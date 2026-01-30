"""Publish packages to BeePM registry"""

import os
import json
import re
import zipfile
import tempfile
from pathlib import Path
from datetime import datetime, timezone
from typing import Dict, Any, Optional

import click
import requests
import boto3
from botocore.exceptions import ClientError
from openai import OpenAI
import semver
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TaskProgressColumn
from dotenv import load_dotenv, find_dotenv

# Load environment variables from .env file
# Try to find .env in current directory, parent directories, or project root
dotenv_path = find_dotenv(usecwd=True)
if dotenv_path:
    load_dotenv(dotenv_path)
else:
    # Try loading from current directory
    load_dotenv()


def get_beepm_paths():
    """Get BeePM directory paths"""
    appdata = Path(os.environ.get("APPDATA", ""))
    beepm_root = appdata / "beepm"
    
    return {
        "root": beepm_root,
        "config": beepm_root / "config",
        "auth_file": beepm_root / "config" / "auth.json",
        "rate_limits_file": beepm_root / "config" / "rate_limits.json"
    }


def load_auth() -> Optional[Dict[str, str]]:
    """Load authentication data from auth.json"""
    paths = get_beepm_paths()
    
    if not paths['auth_file'].exists():
        return None
    
    try:
        with open(paths['auth_file'], 'r') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return None


def verify_token(token: str) -> bool:
    """Verify GitHub token is still valid"""
    try:
        response = requests.get(
            'https://api.github.com/user',
            headers={
                'Authorization': f'Bearer {token}',
                'Accept': 'application/vnd.github.v3+json'
            },
            timeout=10
        )
        return response.status_code == 200
    except requests.RequestException:
        return False


def validate_semver(version: str) -> bool:
    """Validate semantic version string"""
    try:
        semver.Version.parse(version)
        return True
    except ValueError:
        return False


def validate_package_id(package_id: str) -> bool:
    """Validate package ID format (alphanumeric, underscores, hyphens, uppercase)"""
    pattern = r'^[A-Z0-9_]+$'
    return bool(re.match(pattern, package_id))


def generate_package_id(name: str) -> str:
    """Generate a package ID from the name: UPPERCASE_NAME_XXXX"""
    import secrets

    # Convert name to uppercase, replace non-alphanumeric with underscores
    base_name = re.sub(r'[^A-Z0-9]+', '_', name.upper())
    base_name = re.sub(r'^_+|_+$', '', base_name)  # Trim leading/trailing underscores
    base_name = re.sub(r'_+', '_', base_name)  # Collapse multiple underscores

    # Generate a 4-character random suffix
    suffix = secrets.token_hex(2).upper()

    return f"{base_name}_{suffix}"


def validate_name_format(name: str) -> bool:
    """Validate package name format (alphanumeric, hyphens, underscores only)"""
    pattern = r'^[a-zA-Z0-9_-]+$'
    return bool(re.match(pattern, name))


def validate_author_format(author: str) -> bool:
    """Validate author format (alphanumeric, hyphens, underscores only - GitHub username format)"""
    pattern = r'^[a-zA-Z0-9_-]+$'
    return bool(re.match(pattern, author))


def validate_dependencies(deps: Optional[Dict[str, str]]) -> tuple[bool, Optional[str]]:
    """Validate dependency format"""
    if deps is None:
        return True, None
    
    if not isinstance(deps, dict):
        return False, "Dependencies must be a dictionary"
    
    for dep_name, version_range in deps.items():
        # Check format: @author/PACKAGE_ID
        if not re.match(r'^@[a-zA-Z0-9_-]+/[A-Z0-9_]+$', dep_name):
            return False, f"Invalid dependency name format: {dep_name} (expected @author/PACKAGE_ID)"
        
        # Validate version range is a string
        if not isinstance(version_range, str):
            return False, f"Version range for {dep_name} must be a string"
    
    return True, None


def validate_compatible_with(compatible: Any) -> tuple[bool, Optional[str]]:
    """Validate compatibleWith field"""
    if isinstance(compatible, str):
        # Single version or range
        return True, None
    elif isinstance(compatible, list):
        # Array of versions
        if not all(isinstance(v, str) for v in compatible):
            return False, "compatibleWith array must contain only strings"
        return True, None
    else:
        return False, "compatibleWith must be a string or array"


def extract_and_validate_package(bee_pack_path: Path, username: str) -> tuple[Dict[str, Any], Path]:
    """Extract and validate .bee_pack archive
    
    Returns: (bee-package.json data, temp directory with extracted files)
    """
    if not bee_pack_path.exists():
        raise click.ClickException(f"Package file not found: {bee_pack_path}")
    
    if not bee_pack_path.suffix == '.bee_pack':
        raise click.ClickException("Package must have .bee_pack extension")
    
    # Check file size (50MB limit, skip for Areng14)
    size_mb = bee_pack_path.stat().st_size / (1024 * 1024)
    if size_mb > 50 and username.lower() != "areng14":
        raise click.ClickException(f"Package size ({size_mb:.1f}MB) exceeds 50MB limit")
    elif size_mb > 50 and username.lower() == "areng14":
        click.echo(click.style(f"[!]  Admin bypass: Package size {size_mb:.1f}MB (exceeds normal 50MB limit)", fg="yellow"))
    
    # Create temp directory
    temp_dir = Path(tempfile.mkdtemp())
    
    try:
        # Extract archive
        with zipfile.ZipFile(bee_pack_path, 'r') as zip_ref:
            zip_ref.extractall(temp_dir)
    except zipfile.BadZipFile:
        raise click.ClickException("Invalid .bee_pack archive (not a valid ZIP file)")
    
    # Check for bee-package.json at root
    beepackage_path = temp_dir / "bee-package.json"
    if not beepackage_path.exists():
        raise click.ClickException("bee-package.json not found at archive root")
    
    # Parse bee-package.json
    try:
        with open(beepackage_path, 'r', encoding='utf-8') as f:
            package_data = json.load(f)
    except json.JSONDecodeError as e:
        raise click.ClickException(f"Invalid bee-package.json: {e}")
    
    # Validate required fields (id is optional - will be auto-generated)
    required_fields = ['name', 'author', 'version', 'compatibleWith']
    missing = [f for f in required_fields if f not in package_data]
    if missing:
        raise click.ClickException(f"Missing required fields in bee-package.json: {', '.join(missing)}")

    # Note: ID will be read from info.txt later (authoritative source)

    # Validate name length
    name_len = len(package_data['name'])
    if name_len < 3 or name_len > 50:
        raise click.ClickException(f"Package name must be 3-50 characters (got {name_len})")
    
    # Validate name doesn't contain spaces or special characters
    if ' ' in package_data['name']:
        raise click.ClickException("Package name cannot contain spaces")
    
    if not validate_name_format(package_data['name']):
        raise click.ClickException(
            f"Invalid package name: {package_data['name']} "
            "(must contain only letters, numbers, hyphens, and underscores)"
        )
    
    # Validate author format
    if not validate_author_format(package_data['author']):
        raise click.ClickException(
            f"Invalid author: {package_data['author']} "
            "(must contain only letters, numbers, hyphens, and underscores)"
        )
    
    # Validate author matches GitHub username (unless you're Areng14 - admin override)
    if package_data['author'] != username:
        if username == "Areng14":
            # Admin override - Areng14 can publish for anyone
            click.echo(click.style(
                f"[!]  Admin override: Publishing as '{package_data['author']}' (you are {username})",
                fg="yellow"
            ))
        else:
            raise click.ClickException(
                f"Author field '{package_data['author']}' must match your GitHub username '{username}'"
            )
    
    # Validate version
    if not validate_semver(package_data['version']):
        raise click.ClickException(f"Invalid semantic version: {package_data['version']}")
    
    # Validate compatibleWith
    valid, error = validate_compatible_with(package_data.get('compatibleWith'))
    if not valid:
        raise click.ClickException(f"Invalid compatibleWith field: {error}")
    
    # Validate dependencies if present
    if 'dependencies' in package_data:
        valid, error = validate_dependencies(package_data['dependencies'])
        if not valid:
            raise click.ClickException(f"Invalid dependencies: {error}")
    
    return package_data, temp_dir


def validate_files(temp_dir: Path) -> None:
    """Validate all files in package against whitelist"""
    # Whitelist of allowed extensions
    allowed_extensions = {
        '.txt', '.vtf', '.vmt', '.mdl', '.vvd', '.vtx', '.phy', '.3ds',
        '.wav', '.mp3', '.vcd', '.pcf', '.vmf', '.vmx', '.cfg', '.json',
        '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tga', '.webp', '.nut'
    }
    
    # Recursively scan all files
    for file_path in temp_dir.rglob('*'):
        if file_path.is_file():
            ext = file_path.suffix.lower()
            if ext not in allowed_extensions:
                raise click.ClickException(
                    f"Invalid file type: {file_path.name} "
                    f"(extension '{ext}' not allowed)"
                )


def get_info_txt_id(temp_dir: Path) -> str:
    """Get the ID from info.txt - this is the authoritative package ID"""
    info_path = temp_dir / "info.txt"
    if not info_path.exists():
        raise click.ClickException("info.txt not found in package")

    try:
        with open(info_path, 'r', encoding='utf-8') as f:
            content = f.read()

        # Look for ID field (case-insensitive)
        match = re.search(r'^\s*"ID"\s+"([^"]+)"', content, re.MULTILINE | re.IGNORECASE)
        if not match:
            raise click.ClickException("ID field not found in info.txt")

        return match.group(1).upper()
    except IOError as e:
        raise click.ClickException(f"Failed to read info.txt: {e}")


def check_content_moderation(author: str, name: str) -> bool:
    """Check content using OpenAI Moderation API
    
    Returns True if content is safe, False if flagged
    """
    openai_key = os.environ.get('OPENAI_API_KEY')
    if not openai_key:
        # If no API key, skip moderation (or could make it required)
        click.echo(click.style("Warning: OPENAI_API_KEY not set, skipping content moderation", fg="yellow"))
        return True
    
    try:
        client = OpenAI(api_key=openai_key)
        response = client.moderations.create(
            input=f"{author} {name}"
        )
        
        # Check if flagged
        result = response.results[0]
        return not result.flagged
        
    except Exception as e:
        # On error, log but don't block
        click.echo(click.style(f"Warning: Content moderation check failed: {e}", fg="yellow"))
        return True


def check_rate_limit(username: str) -> tuple[bool, int]:
    """Check if user has exceeded rate limit
    
    Returns: (is_within_limit, current_count)
    """
    paths = get_beepm_paths()
    rate_limits_file = paths['rate_limits_file']
    
    # Ensure config directory exists
    paths['config'].mkdir(parents=True, exist_ok=True)
    
    # Load existing rate limits
    if rate_limits_file.exists():
        try:
            with open(rate_limits_file, 'r') as f:
                rate_limits = json.load(f)
        except (json.JSONDecodeError, IOError):
            rate_limits = {}
    else:
        rate_limits = {}
    
    # Get current date in UTC
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    
    # Check user's rate limit
    user_limit = rate_limits.get(username, {})
    reset_date = user_limit.get('reset_date')
    count = user_limit.get('count', 0)
    
    # Reset if different day
    if reset_date != today:
        count = 0
        reset_date = today
    
    # Check if within limit
    is_within_limit = count < 10
    
    return is_within_limit, count


def increment_rate_limit(username: str) -> None:
    """Increment user's publish count for today"""
    paths = get_beepm_paths()
    rate_limits_file = paths['rate_limits_file']
    
    # Load existing rate limits
    if rate_limits_file.exists():
        try:
            with open(rate_limits_file, 'r') as f:
                rate_limits = json.load(f)
        except (json.JSONDecodeError, IOError):
            rate_limits = {}
    else:
        rate_limits = {}
    
    # Get current date in UTC
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    
    # Update count
    user_limit = rate_limits.get(username, {})
    reset_date = user_limit.get('reset_date')
    count = user_limit.get('count', 0)
    
    if reset_date != today:
        count = 0
    
    rate_limits[username] = {
        'count': count + 1,
        'reset_date': today
    }
    
    # Save
    with open(rate_limits_file, 'w') as f:
        json.dump(rate_limits, f, indent=2)


def fetch_registry() -> Dict[str, Any]:
    """Fetch current registry from R2"""
    registry_url = os.environ.get('BEEPM_REGISTRY_URL', 'https://r2.beepm.com/registry.json')
    
    try:
        response = requests.get(registry_url, timeout=30)
        
        # If registry doesn't exist (404), create empty one
        if response.status_code == 404:
            click.echo(click.style("Registry not found, creating new registry...", fg="yellow"))
            return {
                "packages": {
                    "by_name": {},
                    "by_id": {}
                }
            }
        
        response.raise_for_status()
        
        # Handle empty response
        if not response.content or len(response.content.strip()) == 0:
            click.echo(click.style("Registry is empty, creating new registry...", fg="yellow"))
            return {
                "packages": {
                    "by_name": {},
                    "by_id": {}
                }
            }
        
        return response.json()
    except (json.JSONDecodeError, ValueError) as e:
        # If JSON decode fails, it might be an empty/corrupted registry - create new one
        click.echo(click.style(f"Registry corrupted or empty, creating new registry...", fg="yellow"))
        return {
            "packages": {
                "by_name": {},
                "by_id": {}
            }
        }
    except requests.RequestException as e:
        raise click.ClickException(f"Failed to fetch registry: {e}")


def check_version_exists(registry: Dict[str, Any], author: str, package_id: str, version: str) -> bool:
    """Check if package version already exists in registry"""
    packages_by_id = registry.get('packages', {}).get('by_id', {})
    
    if package_id in packages_by_id:
        package = packages_by_id[package_id]
        if version in package.get('versions', {}):
            return True
    
    return False


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


def upload_to_r2(client, bucket: str, bee_pack_path: Path, author: str, package_id: str, version: str) -> str:
    """Upload package to R2
    
    Returns: path where package was uploaded
    """
    # Build S3 key
    s3_key = f"packages/{author}/{package_id}/{version}/package.bee_pack"
    
    # Upload with progress
    file_size = bee_pack_path.stat().st_size
    
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(complete_style="green", finished_style="green"),
        TaskProgressColumn(),
    ) as progress:
        task = progress.add_task(f"Uploading to R2...", total=file_size)
        
        # Track total bytes for accurate completion
        total_uploaded = [0]
        
        def callback(bytes_transferred):
            total_uploaded[0] += bytes_transferred
            progress.update(task, completed=total_uploaded[0])
        
        try:
            client.upload_file(
                str(bee_pack_path),
                bucket,
                s3_key,
                Callback=callback
            )
            
            # Ensure progress shows 100% complete
            progress.update(task, completed=file_size)
        except ClientError as e:
            raise click.ClickException(f"R2 upload failed: {e}")
    
    return f"/packages/{author}/{package_id}/{version}/"


def update_registry(registry: Dict[str, Any], package_data: Dict[str, Any], path: str) -> Dict[str, Any]:
    """Update registry with new package version"""
    author = package_data['author']
    package_id = package_data['id']
    name = package_data['name']
    display_name = package_data.get('display_name', name)
    version = package_data['version']
    compatible_with = package_data['compatibleWith']
    dependencies = package_data.get('dependencies', {})
    
    # Ensure structure exists
    if 'packages' not in registry:
        registry['packages'] = {}
    if 'by_name' not in registry['packages']:
        registry['packages']['by_name'] = {}
    if 'by_id' not in registry['packages']:
        registry['packages']['by_id'] = {}
    
    # Build version entry
    version_entry = {
        'compatibleWith': compatible_with,
        'dependencies': dependencies,
        'path': path
    }
    
    # Update by_id index (this has all the data)
    if package_id not in registry['packages']['by_id']:
        registry['packages']['by_id'][package_id] = {
            'author': author,
            'name': name.lower(),
            'display_name': display_name,
            'versions': {}
        }
    else:
        # Update display_name in case it changed
        registry['packages']['by_id'][package_id]['display_name'] = display_name
    
    registry['packages']['by_id'][package_id]['versions'][version] = version_entry
    
    # Update by_name index (just points to the ID)
    name_key = f"{author.lower()}@{name.lower()}"
    registry['packages']['by_name'][name_key] = package_id
    
    return registry


def upload_registry(client, bucket: str, registry: Dict[str, Any]) -> None:
    """Upload updated registry back to R2"""
    # Convert to JSON
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


def create_bee_pack_from_directory(directory: Path) -> Path:
    """Create a .bee_pack file from a directory
    
    Returns: Path to temporary .bee_pack file
    """
    # Verify bee-package.json exists
    bee_package_json = directory / "bee-package.json"
    if not bee_package_json.exists():
        raise click.ClickException(
            f"bee-package.json not found in directory: {directory}\n"
            "Make sure the directory contains a valid BEE2 package structure."
        )
    
    # Create temp .bee_pack file
    import tempfile
    temp_file = Path(tempfile.gettempdir()) / f"{directory.name}_temp.bee_pack"
    
    click.echo(f"Creating .bee_pack from directory: {directory.name}")
    
    try:
        with zipfile.ZipFile(temp_file, 'w', zipfile.ZIP_DEFLATED) as zip_ref:
            file_count = 0
            for file_path in directory.rglob('*'):
                if file_path.is_file():
                    arcname = file_path.relative_to(directory)
                    zip_ref.write(file_path, arcname)
                    file_count += 1
        
        click.echo(click.style(f"[OK] Created .bee_pack with {file_count} files", fg="green"))
        return temp_file
        
    except Exception as e:
        if temp_file.exists():
            temp_file.unlink()
        raise click.ClickException(f"Failed to create .bee_pack: {e}")


@click.command()
@click.argument('bee_pack_path', type=click.Path(exists=True, path_type=Path))
def publish(bee_pack_path: Path):
    """Publish a package to BeePM registry
    
    BEE_PACK_PATH: Path to the .bee_pack file OR directory to publish
    
    If a directory is provided, it will be automatically zipped.
    
    Before publishing, make sure:
    - You are logged in (run 'beepm login')
    - Your package has a valid bee-package.json
    - All files are of allowed types
    - Package version doesn't already exist
    
    Examples:
      beepm publish package.bee_pack
      beepm publish path/to/package/directory
    """
    click.echo(click.style("\n BeePM Publish", fg="cyan", bold=True))
    click.echo()
    
    # Check if input is a directory
    temp_bee_pack = None
    if bee_pack_path.is_dir():
        try:
            temp_bee_pack = create_bee_pack_from_directory(bee_pack_path)
            bee_pack_path = temp_bee_pack
            click.echo()
        except click.ClickException:
            raise
    
    try:
        # Check authentication
        auth = load_auth()
        if not auth:
            click.echo(click.style("[X] Not logged in", fg="red", bold=True))
            click.echo("Please run 'beepm login' first")
            raise click.Abort()
        
        token = auth['token']
        username = auth['username']
        
        # Verify token is still valid
        click.echo("Verifying authentication...")
        if not verify_token(token):
            click.echo(click.style("[X] Token expired or invalid", fg="red", bold=True))
            click.echo("Please run 'beepm login' again")
            raise click.Abort()
        
        click.echo(click.style(f"[OK] Authenticated as {username}", fg="green"))
        
        # Check rate limit (skip for Areng14)
        if username.lower() == "areng14":
            click.echo("\nRate limit check...")
            click.echo(click.style("[OK] Admin bypass enabled", fg="yellow"))
        else:
            click.echo("\nChecking rate limit...")
            within_limit, current_count = check_rate_limit(username)
            if not within_limit:
                click.echo(click.style(
                    f"[X] Rate limit exceeded: {current_count}/10 packages published today",
                    fg="red",
                    bold=True
                ))
                click.echo("Please try again tomorrow (limit resets at midnight UTC)")
                raise click.Abort()
            
            click.echo(click.style(f"[OK] Rate limit OK ({current_count}/10 packages today)", fg="green"))
        
        # Extract and validate package
        click.echo("\nValidating package...")
        try:
            package_data, temp_dir = extract_and_validate_package(bee_pack_path, username)
            click.echo(click.style("[OK] Package structure valid", fg="green"))
            
            # Validate files
            click.echo("Validating file types...")
            validate_files(temp_dir)
            click.echo(click.style("[OK] All file types allowed", fg="green"))
            
            # Get ID from info.txt (authoritative source)
            click.echo("Reading info.txt...")
            info_id = get_info_txt_id(temp_dir)
            if not validate_package_id(info_id):
                raise click.ClickException(
                    f"Invalid package ID in info.txt: {info_id} "
                    "(must contain only uppercase letters, numbers, and underscores)"
                )
            package_data['id'] = info_id
            click.echo(click.style(f"[OK] Package ID: {info_id}", fg="green"))
            
        except click.ClickException:
            raise
        except Exception as e:
            raise click.ClickException(f"Validation failed: {e}")
        
        # Content moderation (skip for Areng14)
        if username.lower() == "areng14":
            click.echo("\nContent checks...")
            click.echo(click.style("[OK] Admin bypass enabled", fg="yellow"))
        else:
            click.echo("\nRunning content checks...")
            if not check_content_moderation(package_data['author'], package_data['name']):
                raise click.ClickException("Invalid name format")
            click.echo(click.style("[OK] Content checks passed", fg="green"))
        
        # Fetch registry
        click.echo("\nFetching registry...")
        try:
            registry = fetch_registry()
            click.echo(click.style("[OK] Registry fetched", fg="green"))
        except click.ClickException:
            raise
        
        # Check if version exists
        if check_version_exists(registry, package_data['author'], package_data['id'], package_data['version']):
            raise click.ClickException(
                f"Version {package_data['version']} of @{package_data['author']}/{package_data['id']} "
                "already exists (versions are immutable)"
            )
        
        click.echo(click.style(f"[OK] Version {package_data['version']} is new", fg="green"))
        
        # Get R2 client
        click.echo("\nConnecting to R2...")
        try:
            r2_client = get_r2_client()
            bucket = os.environ.get('R2_BUCKET_NAME', 'beepm')
            click.echo(click.style("[OK] Connected to R2", fg="green"))
        except click.ClickException:
            raise
        
        # Upload package
        click.echo()
        try:
            package_path = upload_to_r2(
                r2_client,
                bucket,
                bee_pack_path,
                package_data['author'],
                package_data['id'],
                package_data['version']
            )
            click.echo(click.style("[OK] Package uploaded", fg="green"))
        except click.ClickException:
            raise
        
        # Update registry
        click.echo("\nUpdating registry...")
        try:
            updated_registry = update_registry(registry, package_data, package_path)
            upload_registry(r2_client, bucket, updated_registry)
            click.echo(click.style("[OK] Registry updated", fg="green"))
        except click.ClickException:
            raise
        
        # Increment rate limit (skip for Areng14)
        if username.lower() != "areng14":
            increment_rate_limit(username)
        
        # Success!
        click.echo()
        click.echo(click.style(" Package published successfully!", fg="green", bold=True))
        click.echo()
        click.echo(f"  Package: @{package_data['author']}/{package_data['id']}")
        click.echo(f"  Version: {package_data['version']}")
        click.echo(f"  Name: {package_data['name']}")
        click.echo()
        click.echo(click.style("To install this package, run:", fg="cyan"))
        click.echo(f"  beepm install {package_data['author']}@{package_data['name'].lower()}")
        click.echo()
        
    finally:
        # Cleanup temp file if we created one
        if temp_bee_pack and temp_bee_pack.exists():
            try:
                temp_bee_pack.unlink()
            except:
                pass


if __name__ == "__main__":
    publish()

