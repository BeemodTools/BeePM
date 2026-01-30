"""Nuke the entire registry (admin only - Areng14)"""

import os
import json
from pathlib import Path

import click
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


@click.command()
@click.option('--packages', is_flag=True, help='Also delete all package files')
@click.option('--yes', is_flag=True, help='Skip confirmation prompt')
def nuke(packages: bool, yes: bool):
    """Nuke the entire registry (Areng14 only)
    
    This command will delete the registry.json file and optionally all package files.
    Only the user Areng14 can use this command.
    
    Options:
      --packages  Also delete all package files (not just registry)
      --yes       Skip confirmation prompt
    """
    click.echo(click.style("\n BeePM Nuke", fg="red", bold=True))
    click.echo()
    
    # Check authentication
    auth = load_auth()
    if not auth:
        click.echo(click.style("[X] Not logged in", fg="red", bold=True))
        click.echo("Please run 'beepm login' first")
        raise click.Abort()
    
    username = auth['username']
    
    # Check if user is Areng14
    if username != "Areng14":
        click.echo(click.style("[X] Access Denied", fg="red", bold=True))
        click.echo(f"This command is only available to Areng14 (you are: {username})")
        raise click.Abort()
    
    click.echo(click.style(f"[OK] Authenticated as {username}", fg="green"))
    click.echo()
    
    # Show what will be deleted
    if packages:
        click.echo(click.style("[!]  WARNING: This will delete:", fg="yellow", bold=True))
        click.echo("  * registry.json")
        click.echo("  * ALL package files in the bucket")
    else:
        click.echo(click.style("[!]  WARNING: This will delete:", fg="yellow", bold=True))
        click.echo("  * registry.json")
        click.echo("  (packages will remain in storage)")
    
    click.echo()
    
    # Confirmation
    if not yes:
        if not click.confirm(click.style("Are you ABSOLUTELY sure you want to continue?", fg="red", bold=True)):
            click.echo("Aborted.")
            raise click.Abort()
    
    # Get R2 client
    try:
        r2_client = get_r2_client()
        bucket = os.environ.get('R2_BUCKET_NAME', 'beepm')
    except click.ClickException as e:
        click.echo(click.style(f"[X] {e.format_message()}", fg="red", bold=True))
        raise click.Abort()
    
    click.echo()
    click.echo("Nuking registry...")
    
    try:
        # Delete registry.json
        try:
            r2_client.delete_object(Bucket=bucket, Key='registry.json')
            click.echo(click.style("[OK] Deleted registry.json", fg="green"))
        except ClientError as e:
            error_code = e.response.get('Error', {}).get('Code', '')
            if error_code == '404' or error_code == 'NoSuchKey':
                click.echo(click.style("  (registry.json didn't exist)", fg="yellow"))
            else:
                raise
        
        # Delete all packages if requested
        if packages:
            click.echo()
            click.echo("Deleting all packages...")
            
            # List all objects with 'packages/' prefix
            paginator = r2_client.get_paginator('list_objects_v2')
            pages = paginator.paginate(Bucket=bucket, Prefix='packages/')
            
            delete_count = 0
            for page in pages:
                if 'Contents' in page:
                    for obj in page['Contents']:
                        r2_client.delete_object(Bucket=bucket, Key=obj['Key'])
                        delete_count += 1
            
            if delete_count > 0:
                click.echo(click.style(f"[OK] Deleted {delete_count} package file(s)", fg="green"))
            else:
                click.echo(click.style("  (no package files found)", fg="yellow"))
        
        # Success!
        click.echo()
        click.echo(click.style(" Nuke complete!", fg="green", bold=True))
        click.echo()
        click.echo("The registry has been wiped clean.")
        if packages:
            click.echo("All package files have been removed.")
        click.echo()
        
    except ClientError as e:
        click.echo(click.style(f"\n[X] Failed to nuke: {e}", fg="red", bold=True))
        raise click.Abort()
    except Exception as e:
        click.echo(click.style(f"\n[X] Nuke failed: {e}", fg="red", bold=True))
        raise click.Abort()


if __name__ == "__main__":
    nuke()

