"""Yank (disable) package versions that are broken/incompatible"""

import os
import json
from pathlib import Path

import click
import requests
import boto3
from botocore.exceptions import ClientError
from dotenv import load_dotenv, find_dotenv

# Load environment variables from .env file
dotenv_path = find_dotenv(usecwd=True)
if dotenv_path:
    load_dotenv(dotenv_path)
else:
    load_dotenv()


def get_beepm_paths():
    """Get BeePM directory paths"""
    appdata = Path(os.environ.get("APPDATA", ""))
    beepm_root = appdata / "beepm"
    
    return {
        "root": beepm_root,
        "config": beepm_root / "config",
        "auth_file": beepm_root / "config" / "auth.json"
    }


def load_auth():
    """Load authentication data from auth.json"""
    paths = get_beepm_paths()
    
    if not paths['auth_file'].exists():
        return None
    
    try:
        with open(paths['auth_file'], 'r') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return None


def fetch_registry():
    """Fetch current registry from R2"""
    registry_url = os.environ.get('BEEPM_REGISTRY_URL', 'https://r2.beepm.com/registry.json')
    
    try:
        response = requests.get(registry_url, timeout=30)
        response.raise_for_status()
        return response.json()
    except Exception as e:
        raise click.ClickException(f"Failed to fetch registry: {e}")


def get_r2_client():
    """Get boto3 S3 client configured for Cloudflare R2"""
    access_key = os.environ.get('R2_ACCESS_KEY_ID')
    secret_key = os.environ.get('R2_SECRET_ACCESS_KEY')
    endpoint = os.environ.get('R2_ENDPOINT_URL')
    
    if not all([access_key, secret_key, endpoint]):
        raise click.ClickException(
            "R2 credentials not configured. Set R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_ENDPOINT_URL"
        )
    
    return boto3.client(
        's3',
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name='auto'
    )


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
@click.argument('package_spec')  # author@package@version
@click.option('--unyank', is_flag=True, help='Unyank (re-enable) a package version')
@click.option('--reason', default='Incompatible with current BEE2 versions', help='Reason for yanking')
def yank(package_spec: str, unyank: bool, reason: str):
    """Yank (disable) or unyank a package version (Areng14 only)
    
    Yanked versions cannot be installed (except with --force).
    Useful for marking versions as broken or incompatible.
    
    PACKAGE_SPEC format: author@packagename@version
    
    Examples:
      beepm yank areng14@package@1.0.0
      beepm yank areng14@package@1.0.0 --reason "Breaks on BEE2 2.5+"
      beepm yank areng14@package@1.0.0 --unyank
    """
    click.echo(click.style(f"\n{'' if unyank else ''} BeePM {'Unyank' if unyank else 'Yank'}", fg="cyan", bold=True))
    click.echo()
    
    # Check authentication
    auth = load_auth()
    if not auth:
        click.echo(click.style("[X] Not logged in", fg="red", bold=True))
        click.echo("Please run 'beepm login' first")
        raise click.Abort()
    
    username = auth['username']
    
    # Only Areng14 can yank
    if username != "Areng14":
        click.echo(click.style("[X] Access Denied", fg="red", bold=True))
        click.echo(f"This command is only available to Areng14 (you are: {username})")
        raise click.Abort()
    
    click.echo(click.style(f"[OK] Authenticated as {username}", fg="green"))
    click.echo()
    
    # Parse package spec
    parts = package_spec.split('@')
    if len(parts) != 3:
        click.echo(click.style("[X] Invalid format", fg="red", bold=True))
        click.echo("Format: author@packagename@version")
        click.echo("Example: beepm yank areng14@package@1.0.0")
        raise click.Abort()
    
    author, package_name, version = parts
    author = author.lower()
    package_name = package_name.lower()
    
    # Fetch registry
    click.echo("Fetching registry...")
    try:
        registry = fetch_registry()
        click.echo(click.style("[OK] Registry fetched", fg="green"))
    except click.ClickException as e:
        click.echo(click.style(f"[X] {e.format_message()}", fg="red", bold=True))
        raise click.Abort()
    
    # Find package
    by_name = registry.get('packages', {}).get('by_name', {})
    by_id = registry.get('packages', {}).get('by_id', {})
    
    name_key = f"{author}@{package_name}"
    if name_key not in by_name:
        click.echo(click.style(f"[X] Package not found: {name_key}", fg="red", bold=True))
        raise click.Abort()
    
    package_id = by_name[name_key]
    if package_id not in by_id:
        click.echo(click.style(f"[X] Package data not found: {package_id}", fg="red", bold=True))
        raise click.Abort()
    
    package = by_id[package_id]
    versions = package.get('versions', {})
    
    if version not in versions:
        click.echo(click.style(f"[X] Version not found: {version}", fg="red", bold=True))
        available = ', '.join(versions.keys())
        click.echo(f"Available versions: {available}")
        raise click.Abort()
    
    # Check current yank status
    version_data = versions[version]
    is_yanked = version_data.get('yanked', False)
    
    if unyank and not is_yanked:
        click.echo(click.style(f"[!]  Version {version} is not yanked", fg="yellow"))
        return
    
    if not unyank and is_yanked:
        click.echo(click.style(f"[!]  Version {version} is already yanked", fg="yellow"))
        yank_reason = version_data.get('yank_reason', 'No reason provided')
        click.echo(f"Reason: {yank_reason}")
        return
    
    # Update registry
    click.echo()
    display_name = package.get('display_name', package_id)
    
    if unyank:
        click.echo(f"Unyanking {display_name}@{version}...")
        version_data['yanked'] = False
        if 'yank_reason' in version_data:
            del version_data['yank_reason']
    else:
        click.echo(f"Yanking {display_name}@{version}...")
        click.echo(f"Reason: {reason}")
        version_data['yanked'] = True
        version_data['yank_reason'] = reason
    
    # Upload updated registry
    click.echo()
    click.echo("Updating registry...")
    try:
        r2_client = get_r2_client()
        bucket = os.environ.get('R2_BUCKET_NAME', 'beepm')
        upload_registry(r2_client, bucket, registry)
        click.echo(click.style("[OK] Registry updated", fg="green"))
    except click.ClickException as e:
        click.echo(click.style(f"[X] {e.format_message()}", fg="red", bold=True))
        raise click.Abort()
    
    # Success
    click.echo()
    if unyank:
        click.echo(click.style(f"[OK] {display_name}@{version} has been unyanked!", fg="green", bold=True))
        click.echo("Users can now install this version again.")
    else:
        click.echo(click.style(f"[OK] {display_name}@{version} has been yanked!", fg="green", bold=True))
        click.echo("Users cannot install this version (unless using --force).")
        click.echo(f"\nReason: {reason}")
    
    click.echo()


if __name__ == "__main__":
    yank()

