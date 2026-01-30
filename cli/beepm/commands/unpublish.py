"""Unpublish/delete a package version from the registry"""

import os
import json
from pathlib import Path

import click
import requests
import boto3
from botocore.exceptions import ClientError
from dotenv import load_dotenv, find_dotenv


def get_appdata_path() -> Path:
    """Get the AppData/Roaming path"""
    return Path(os.environ.get('APPDATA', ''))


def load_auth() -> dict:
    """Load authentication from auth.json"""
    auth_path = get_appdata_path() / "beepm" / "config" / "auth.json"
    
    if not auth_path.exists():
        return None
    
    try:
        with open(auth_path, 'r') as f:
            return json.load(f)
    except Exception:
        return None


def get_r2_client():
    """Create and return R2 client"""
    account_id = os.environ.get('R2_ACCOUNT_ID')
    access_key = os.environ.get('R2_ACCESS_KEY_ID')
    secret_key = os.environ.get('R2_SECRET_ACCESS_KEY')
    
    if not all([account_id, access_key, secret_key]):
        raise click.ClickException(
            "R2 credentials not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY"
        )
    
    return boto3.client(
        's3',
        endpoint_url=f'https://{account_id}.r2.cloudflarestorage.com',
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name='auto'
    )


def fetch_registry() -> dict:
    """Fetch the registry from R2"""
    registry_url = os.environ.get('REGISTRY_URL', 'https://pub-adc08815222c4c608465419f2d5751a5.r2.dev/registry.json')
    
    try:
        response = requests.get(registry_url, timeout=10)
        
        if response.status_code == 404:
            return {"packages": {"by_id": {}, "by_name": {}}}
        
        response.raise_for_status()
        
        if not response.content or len(response.content.strip()) == 0:
            return {"packages": {"by_id": {}, "by_name": {}}}
        
        return response.json()
    except requests.exceptions.JSONDecodeError:
        return {"packages": {"by_id": {}, "by_name": {}}}
    except requests.RequestException as e:
        raise click.ClickException(f"Failed to fetch registry: {e}")


def upload_registry(client, bucket: str, registry: dict) -> None:
    """Upload updated registry back to R2"""
    registry_json = json.dumps(registry, indent=2)
    
    try:
        client.put_object(
            Bucket=bucket,
            Key='registry.json',
            Body=registry_json.encode('utf-8'),
            ContentType='application/json'
        )
    except ClientError as e:
        raise click.ClickException(f"Failed to update registry: {e}")


@click.command()
@click.argument('package_spec')
@click.argument('version')
@click.option('--yes', is_flag=True, help='Skip confirmation prompt')
def unpublish(package_spec: str, version: str, yes: bool):
    """Unpublish/delete a package version from the registry (Admin only)
    
    PACKAGE_SPEC can be:
    - author@packagename
    - PACKAGE_ID
    
    VERSION: The version to remove (e.g., 1.0.0)
    
    This will:
    - Remove the version from the registry
    - Delete the .bee_pack file from R2
    
    Examples:
      beepm unpublish areng14@arengspackages 1.0.0
      beepm unpublish ARENGS_PACKAGES 1.0.0
    """
    # Load environment variables
    load_dotenv(find_dotenv(usecwd=True))
    
    click.echo(click.style("\n  BeePM Unpublish", fg="red", bold=True))
    click.echo()
    
    # Check authentication
    auth = load_auth()
    if not auth:
        click.echo(click.style("[X] Not logged in", fg="red", bold=True))
        click.echo("Please run 'beepm login' first")
        raise click.Abort()
    
    username = auth['username']
    
    # Check if user is Areng14 (admin)
    if username.lower() != "areng14":
        click.echo(click.style("[X] Access denied", fg="red", bold=True))
        click.echo("Only administrators can unpublish packages")
        raise click.Abort()
    
    click.echo(click.style(f"[OK] Authenticated as {username} (Admin)", fg="green"))
    
    # Fetch registry
    click.echo("\nFetching registry...")
    registry = fetch_registry()
    by_id = registry.get('packages', {}).get('by_id', {})
    by_name = registry.get('packages', {}).get('by_name', {})
    
    # Find package
    package_id = None
    package_data = None
    
    # Try as package ID first
    if package_spec.upper() in by_id:
        package_id = package_spec.upper()
        package_data = by_id[package_id]
    # Try as author@name
    elif '@' in package_spec:
        spec_lower = package_spec.lower()
        if spec_lower in by_name:
            package_id = by_name[spec_lower]
            package_data = by_id.get(package_id)
    
    if not package_id or not package_data:
        click.echo(click.style(f"[X] Package not found: {package_spec}", fg="red", bold=True))
        raise click.Abort()
    
    author = package_data.get('author', 'Unknown')
    display_name = package_data.get('display_name', package_id)
    versions = package_data.get('versions', {})
    
    click.echo(click.style(f"[OK] Found package: {display_name} by {author}", fg="green"))
    
    # Check if version exists
    if version not in versions:
        click.echo(click.style(f"\n[X] Version {version} not found", fg="red", bold=True))
        click.echo(f"Available versions: {', '.join(versions.keys())}")
        raise click.Abort()
    
    version_data = versions[version]
    package_path = version_data.get('path', '')
    
    click.echo(click.style(f"[OK] Found version: {version}", fg="green"))
    
    # Show what will be deleted
    click.echo()
    click.echo(click.style("[!]  This will permanently delete:", fg="yellow", bold=True))
    click.echo(f"  * Package: {display_name} ({package_id})")
    click.echo(f"  * Version: {version}")
    click.echo(f"  * Author: {author}")
    click.echo(f"  * File: {package_path}package.bee_pack")
    click.echo()
    
    # Check if it's the last version
    if len(versions) == 1:
        click.echo(click.style("[!]  WARNING: This is the LAST VERSION of this package!", fg="red", bold=True))
        click.echo(click.style("   The entire package will be removed from the registry.", fg="red"))
        click.echo()
    
    # Confirmation
    if not yes:
        if not click.confirm(click.style("Are you sure you want to unpublish this version?", fg="red", bold=True), default=False):
            click.echo()
            click.echo(click.style("[CANCELLED] Unpublish cancelled.", fg="cyan", bold=True))
            click.echo()
            return
    
    # Get R2 client
    click.echo("\nConnecting to R2...")
    try:
        r2_client = get_r2_client()
        bucket = os.environ.get('R2_BUCKET_NAME', 'beepm')
        click.echo(click.style("[OK] Connected to R2", fg="green"))
    except click.ClickException:
        raise
    
    # Delete the .bee_pack file from R2
    click.echo(f"\nDeleting package file from R2...")
    s3_key = f"{package_path.lstrip('/')}package.bee_pack"
    
    try:
        r2_client.delete_object(Bucket=bucket, Key=s3_key)
        click.echo(click.style("[OK] Package file deleted", fg="green"))
    except ClientError as e:
        click.echo(click.style(f"[!]  Warning: Failed to delete file: {e}", fg="yellow"))
        click.echo("Continuing with registry update...")
    
    # Update registry
    click.echo("\nUpdating registry...")
    
    # Remove the version
    del by_id[package_id]['versions'][version]
    
    # If no versions left, remove the entire package
    if not by_id[package_id]['versions']:
        click.echo(click.style("i  Removing entire package (no versions left)", fg="cyan"))
        
        # Remove from by_id
        del by_id[package_id]
        
        # Remove from by_name
        name_key = f"{author.lower()}@{package_data.get('name', '').lower()}"
        if name_key in by_name:
            del by_name[name_key]
    
    # Upload updated registry
    try:
        upload_registry(r2_client, bucket, registry)
        click.echo(click.style("[OK] Registry updated", fg="green"))
    except click.ClickException:
        raise
    
    # Success!
    click.echo()
    click.echo(click.style("[OK] Version unpublished successfully!", fg="green", bold=True))
    click.echo()
    click.echo(f"  Package: {display_name}")
    click.echo(f"  Version: {version}")
    click.echo(f"  Author: {author}")
    click.echo()


if __name__ == "__main__":
    unpublish()

