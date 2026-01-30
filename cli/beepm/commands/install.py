"""Install packages from BeePM registry"""

import os
import json
import re
import zipfile
import tempfile
import shutil
from pathlib import Path
from typing import Dict, Any, Optional, List, Tuple, Set
from collections import defaultdict

import click
import requests
import boto3
from botocore.exceptions import ClientError
from packaging import version as pkg_version
from packaging.specifiers import SpecifierSet
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, DownloadColumn, TransferSpeedColumn
from rich.console import Console
from rich.table import Table
from dotenv import load_dotenv, find_dotenv

# Load environment variables from .env file
# Try to find .env in current directory, parent directories, or project root
dotenv_path = find_dotenv(usecwd=True)
if dotenv_path:
    load_dotenv(dotenv_path)
else:
    # Try loading from current directory
    load_dotenv()

console = Console()


def parse_requirements_file(file_path: str) -> List[str]:
    """Parse a requirements file and return list of package specs
    
    Supports:
    - Simple package names: author@package
    - Version pinning: author@package@1.0.0
    - Comments: # This is a comment
    - Blank lines
    """
    packages = []
    
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            for line_num, line in enumerate(f, 1):
                # Remove comments and whitespace
                line = line.split('#')[0].strip()
                
                # Skip empty lines
                if not line:
                    continue
                
                packages.append(line)
        
        return packages
    except IOError as e:
        raise click.ClickException(f"Failed to read requirements file: {e}")


def install_from_requirements(requirements_file: str, force: bool) -> None:
    """Install all packages from a requirements file"""
    click.echo(click.style(f" Installing from: {requirements_file}", fg="cyan", bold=True))
    click.echo()
    
    # Parse requirements file
    try:
        packages = parse_requirements_file(requirements_file)
    except click.ClickException as e:
        click.echo(click.style(f"[X] {e.format_message()}", fg="red", bold=True))
        raise click.Abort()
    
    if not packages:
        click.echo(click.style("[X] No packages found in requirements file", fg="yellow"))
        return
    
    click.echo(click.style(f"Found {len(packages)} package(s) to install:", fg="cyan"))
    for pkg in packages:
        click.echo(f"  * {pkg}")
    click.echo()
    
    # Install each package
    installed_count = 0
    failed_packages = []
    
    for i, package_spec in enumerate(packages, 1):
        click.echo(click.style(f"\n[{i}/{len(packages)}] Installing {package_spec}...", fg="cyan", bold=True))
        click.echo()
        
        try:
            # Use the main install logic for each package
            install_single_package(package_spec, force)
            installed_count += 1
        except (click.ClickException, click.Abort) as e:
            click.echo(click.style(f"[X] Failed to install {package_spec}", fg="red"))
            failed_packages.append(package_spec)
            # Continue with next package instead of aborting
            continue
    
    # Summary
    click.echo()
    click.echo(click.style("=" * 60, fg="cyan"))
    click.echo(click.style("Installation Summary", fg="cyan", bold=True))
    click.echo(click.style("=" * 60, fg="cyan"))
    click.echo()
    
    if installed_count > 0:
        click.echo(click.style(f"[OK] Successfully installed: {installed_count}/{len(packages)} packages", fg="green", bold=True))
    
    if failed_packages:
        click.echo(click.style(f"[X] Failed to install: {len(failed_packages)} package(s)", fg="red", bold=True))
        click.echo("\nFailed packages:")
        for pkg in failed_packages:
            click.echo(f"  * {pkg}")
    
    click.echo()
    
    if failed_packages:
        raise click.Abort()


def install_single_package(package_spec: str, force: bool) -> None:
    """Install a single package (extracted from main install function)"""
    # Load config to get BEE2 version
    config = load_config()
    if not config:
        raise click.ClickException("BeePM not initialized. Please run 'beepm init' first.")
    
    user_version = config.get('beemod_version')
    if not user_version:
        raise click.ClickException("BEE2 version not found in config. Please run 'beepm init'.")
    
    click.echo(f"BEE2 Version: {user_version}")
    click.echo()
    
    # Parse package identifier
    author, package_name, requested_version = parse_package_identifier(package_spec)
    
    # Fetch registry
    click.echo("Fetching registry...")
    registry = fetch_registry()
    click.echo(click.style("[OK] Registry fetched", fg="green"))
    
    # Find package in registry
    click.echo()
    click.echo(f"Looking up package: {package_spec}...")
    package_id, resolved_author, display_name, pkg_name = find_package_in_registry(
        registry, author, package_name
    )
    click.echo(click.style(f"[OK] Found: {display_name} (@{resolved_author}/{package_id})", fg="green"))
    
    # Check if already installed
    installed = load_installed_packages()
    already_installed = package_id in installed.get('packages', {})
    
    if already_installed and not force:
        installed_version = installed['packages'][package_id]['version']
        
        # Check if it's the version we want
        if not requested_version or installed_version == requested_version:
            click.echo()
            click.echo(click.style(
                f"[OK] {display_name}@{installed_version} is already installed",
                fg="green",
                bold=True
            ))
            click.echo("Use --force to reinstall")
            return
    
    # Resolve version and dependencies
    click.echo()
    click.echo("Resolving dependencies...")
    
    resolver = DependencyResolver(registry, user_version)
    packages_to_install = resolver.resolve(package_id, resolved_author, requested_version)
    
    # Add main package to results
    resolved_version = resolver.resolved[package_id]
    packages_to_install[package_id] = (resolved_version, resolved_author, display_name, pkg_name)
    
    click.echo(click.style(f"[OK] Resolved {len(packages_to_install)} package(s)", fg="green"))
    
    # Show install plan
    click.echo()
    click.echo(click.style("Install plan:", fg="cyan", bold=True))
    for pkg_id, (ver, auth, disp_name, _) in packages_to_install.items():
        is_main = (pkg_id == package_id)
        prefix = "  -> " if is_main else "    "
        label = "" if is_main else "(dependency)"
        click.echo(f"{prefix}{disp_name}@{ver} {label}")
    
    click.echo()
    
    # Get R2 client
    r2_client = get_r2_client()
    bucket = os.environ.get('R2_BUCKET_NAME', 'beepm')
    
    # Download and install packages
    downloaded_files = []
    
    try:
        # Download all packages
        for pkg_id, (ver, auth, disp_name, _) in packages_to_install.items():
            # Get package info from registry
            by_id = registry['packages']['by_id']
            version_data = by_id[pkg_id]['versions'][ver]

            # Check if it's a GitHub package (has downloadUrl) or regular R2 package (has path)
            if 'downloadUrl' in version_data:
                # GitHub package - download from URL
                temp_file = download_github_package(version_data['downloadUrl'], pkg_id, ver)
            else:
                # Regular R2 package - download from S3
                pkg_path = version_data['path']
                temp_file = download_package(r2_client, bucket, pkg_path, pkg_id, ver)

            downloaded_files.append((temp_file, pkg_id, auth, ver, disp_name))
            click.echo(click.style(f"[OK] Downloaded {disp_name}@{ver}", fg="green"))
        
        click.echo()
        click.echo("Installing packages...")
        
        # Install all packages
        for temp_file, pkg_id, auth, ver, disp_name in downloaded_files:
            install_package(temp_file, pkg_id, auth)
            click.echo(click.style(f"[OK] Installed {disp_name}@{ver}", fg="green"))
        
        # Update tracking
        update_installed_tracking(packages_to_install, package_id)
        
        # Clean up temp files
        for temp_file, *_ in downloaded_files:
            if temp_file.exists():
                temp_file.unlink()
        
        # Success!
        click.echo()
        click.echo(click.style(" Installation complete!", fg="green", bold=True))
        click.echo()
        click.echo(f"Installed {len(packages_to_install)} package(s):")
        for pkg_id, (ver, auth, disp_name, _) in packages_to_install.items():
            click.echo(f"  [OK] {disp_name}@{ver}")
        click.echo()
        
    except Exception as e:
        # Clean up temp files on error
        for temp_file, *_ in downloaded_files:
            if temp_file.exists():
                temp_file.unlink()
        raise


def get_beepm_paths():
    """Get BeePM directory paths"""
    appdata = Path(os.environ.get("APPDATA", ""))
    beepm_root = appdata / "beepm"
    
    return {
        "root": beepm_root,
        "packages": beepm_root / "packages",
        "config": beepm_root / "config",
        "config_file": beepm_root / "config" / "beepm_config.json",
        "installed_file": beepm_root / "config" / "installed_packages.json"
    }


def load_config() -> Optional[Dict[str, Any]]:
    """Load BeePM configuration"""
    paths = get_beepm_paths()
    
    if not paths['config_file'].exists():
        return None
    
    try:
        with open(paths['config_file'], 'r') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return None


def load_installed_packages() -> Dict[str, Any]:
    """Load list of installed packages"""
    paths = get_beepm_paths()
    
    if not paths['installed_file'].exists():
        return {"packages": {}}
    
    try:
        with open(paths['installed_file'], 'r') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {"packages": {}}


def save_installed_packages(installed: Dict[str, Any]) -> None:
    """Save installed packages list"""
    paths = get_beepm_paths()
    paths['config'].mkdir(parents=True, exist_ok=True)
    
    with open(paths['installed_file'], 'w') as f:
        json.dump(installed, f, indent=2)


def fetch_registry() -> Dict[str, Any]:
    """Fetch current registry from R2, merging main registry and GitHub packages"""
    registry_url = os.environ.get('BEEPM_REGISTRY_URL', 'https://r2.beepm.com/registry.json')
    github_packages_url = registry_url.replace('registry.json', 'github_packages.json')

    try:
        response = requests.get(registry_url, timeout=30)

        # If registry doesn't exist (404), return empty
        if response.status_code == 404:
            raise click.ClickException(
                f"Registry not found at {registry_url}\n"
                "No packages available. The registry may not be set up yet."
            )

        response.raise_for_status()

        # Handle empty response
        if not response.content or len(response.content.strip()) == 0:
            raise click.ClickException("Registry is empty. No packages available.")

        registry = response.json()
    except (json.JSONDecodeError, ValueError) as e:
        # Show what was actually returned
        content_preview = response.content[:200].decode('utf-8', errors='ignore') if response.content else "(empty)"
        raise click.ClickException(
            f"Registry is corrupted (invalid JSON)\n"
            f"URL: {registry_url}\n"
            f"Status: {response.status_code}\n"
            f"Content preview: {content_preview}"
        )
    except requests.RequestException as e:
        raise click.ClickException(f"Failed to fetch registry from {registry_url}: {e}")

    # Also fetch and merge GitHub packages
    try:
        github_response = requests.get(github_packages_url, timeout=30)
        if github_response.status_code == 200:
            github_packages = github_response.json()
            if 'packages' in github_packages:
                # Ensure registry structure exists
                if 'packages' not in registry:
                    registry['packages'] = {}
                if 'by_id' not in registry['packages']:
                    registry['packages']['by_id'] = {}
                if 'by_name' not in registry['packages']:
                    registry['packages']['by_name'] = {}

                # Merge GitHub packages into registry
                for pkg_id, pkg in github_packages['packages'].items():
                    # Add to by_id with isGithub marker
                    registry['packages']['by_id'][pkg_id] = {**pkg, 'isGithub': True}
                    # Add to by_name index
                    if pkg.get('author') and pkg.get('name'):
                        name_key = f"{pkg['author'].lower()}@{pkg['name'].lower()}"
                        registry['packages']['by_name'][name_key] = pkg_id
    except Exception:
        # GitHub packages are optional, don't fail if unavailable
        pass

    return registry


def parse_package_identifier(package_spec: str) -> Tuple[Optional[str], str, Optional[str]]:
    """Parse package identifier into (author, package_name, version)
    
    Formats:
    - packagename -> (None, packagename, None)
    - author@packagename -> (author, packagename, None)
    - author@packagename@version -> (author, packagename, version)
    """
    parts = package_spec.split('@')
    
    if len(parts) == 1:
        # Just package name
        return (None, parts[0].lower(), None)
    elif len(parts) == 2:
        # author@package
        return (parts[0].lower(), parts[1].lower(), None)
    elif len(parts) == 3:
        # author@package@version
        return (parts[0].lower(), parts[1].lower(), parts[2])
    else:
        raise click.ClickException(f"Invalid package format: {package_spec}")


def find_package_in_registry(registry: Dict[str, Any], author: Optional[str], package_name: str) -> Tuple[str, str, str, str]:
    """Find package in registry

    Returns: (package_id, author, display_name, name)
    """
    by_name = registry.get('packages', {}).get('by_name', {})
    by_id = registry.get('packages', {}).get('by_id', {})
    
    if author:
        # Exact lookup
        key = f"{author}@{package_name}"
        if key not in by_name:
            raise click.ClickException(f"Package not found: {key}")

        # Get package ID from by_name, then lookup full data in by_id
        package_id = by_name[key]
        if package_id not in by_id:
            # Check if there's another entry for this package name with a different ID
            alt_matches = []
            for alt_key, alt_id in by_name.items():
                if alt_key.split('@')[1] == package_name and alt_id in by_id:
                    alt_matches.append((alt_key, alt_id))

            if alt_matches:
                # Found alternative entry
                click.echo(click.style(f"Warning: Registry entry '{key}' is orphaned (points to missing ID: {package_id})", fg="yellow"))
                click.echo(click.style(f"Using alternative entry instead...", fg="yellow"))
                package_id = alt_matches[0][1]
            else:
                raise click.ClickException(
                    f"Registry has orphaned entry: '{key}' -> '{package_id}'\n"
                    f"The package data for ID '{package_id}' is missing.\n"
                    f"This package may need to be republished to fix the registry."
                )

        pkg = by_id[package_id]
        display_name = pkg.get('display_name', pkg.get('name', package_id))
        name = pkg.get('name', display_name.lower().replace(' ', '').replace("'", ''))
        return (package_id, pkg['author'], display_name, name)
    else:
        # Search for packages with this name
        matches = []
        for key, package_id in by_name.items():
            # key format: "author@packagename"
            if key.split('@')[1] == package_name:
                if package_id in by_id:
                    matches.append((key, package_id))

        if len(matches) == 0:
            raise click.ClickException(f"Package not found: {package_name}")
        elif len(matches) > 1:
            click.echo(click.style(f"Multiple packages found with name '{package_name}':", fg="yellow", bold=True))
            for key, _ in matches:
                click.echo(f"  - {key}")
            raise click.ClickException("Please specify author: author@packagename")

        # Single match
        package_id = matches[0][1]
        pkg = by_id[package_id]
        display_name = pkg.get('display_name', pkg.get('name', package_id))
        name = pkg.get('name', display_name.lower().replace(' ', '').replace("'", ''))
        return (package_id, pkg['author'], display_name, name)


def check_version_compatibility(version_spec: Any, user_version: str) -> bool:
    """Check if a version is compatible with user's BEE2 version
    
    version_spec can be:
    - Array of versions: ["2.4.40", "2.4.41"]
    - Semver range string: ">=2.4.40"
    """
    try:
        user_ver = pkg_version.parse(user_version)
    except Exception:
        # If can't parse, assume incompatible
        return False
    
    if isinstance(version_spec, list):
        # Array format - check if user version is in list
        for v in version_spec:
            try:
                if pkg_version.parse(v) == user_ver:
                    return True
            except Exception:
                continue
        return False
    elif isinstance(version_spec, str):
        # Semver range format
        try:
            spec = SpecifierSet(version_spec)
            return user_ver in spec
        except Exception:
            return False
    else:
        return False


def resolve_version(registry: Dict[str, Any], package_id: str, author: str, 
                   user_version: str, requested_version: Optional[str] = None, 
                   allow_yanked: bool = False) -> Optional[str]:
    """Resolve the best version for a package
    
    Returns: version string or None if no compatible version
    """
    by_id = registry.get('packages', {}).get('by_id', {})
    
    if package_id not in by_id:
        return None
    
    package = by_id[package_id]
    versions = package.get('versions', {})
    
    if requested_version:
        # User requested specific version
        if requested_version not in versions:
            return None
        
        # Check if it's compatible
        version_data = versions[requested_version]
        
        # Check if yanked
        if version_data.get('yanked', False) and not allow_yanked:
            return None
        
        if check_version_compatibility(version_data.get('compatibleWith'), user_version):
            return requested_version
        else:
            return None
    else:
        # Find highest compatible version (excluding yanked)
        compatible_versions = []
        
        for ver, ver_data in versions.items():
            # Skip yanked versions unless explicitly allowed
            if ver_data.get('yanked', False) and not allow_yanked:
                continue
            
            if check_version_compatibility(ver_data.get('compatibleWith'), user_version):
                try:
                    compatible_versions.append(pkg_version.parse(ver))
                except Exception:
                    continue
        
        if not compatible_versions:
            return None
        
        # Return highest version
        highest = max(compatible_versions)
        return str(highest)


class DependencyResolver:
    """Resolve package dependencies with conflict detection"""
    
    def __init__(self, registry: Dict[str, Any], user_version: str):
        self.registry = registry
        self.user_version = user_version
        self.resolved: Dict[str, str] = {}  # package_id -> version
        self.resolution_path: Set[str] = set()  # For circular dependency detection
    
    def resolve(self, package_id: str, author: str, requested_version: Optional[str] = None,
                required_by: Optional[str] = None) -> Dict[str, Tuple[str, str, str]]:
        """Resolve dependencies recursively
        
        Returns: {package_id: (version, author, display_name, name)}
        """
        # Check circular dependency
        if package_id in self.resolution_path:
            raise click.ClickException(
                f"Circular dependency detected: {package_id} is already being resolved"
            )
        
        # Check if already resolved
        if package_id in self.resolved:
            if requested_version and self.resolved[package_id] != requested_version:
                raise click.ClickException(
                    f"Version conflict for {package_id}: "
                    f"requires both {self.resolved[package_id]} and {requested_version}"
                )
            return {}
        
        # Resolve version for this package (allow yanked if explicitly requested)
        allow_yanked = (requested_version is not None)
        version = resolve_version(self.registry, package_id, author, self.user_version, requested_version, allow_yanked)
        
        # Check if the resolved version is yanked
        if version:
            by_id = self.registry.get('packages', {}).get('by_id', {})
            if package_id in by_id:
                version_data = by_id[package_id]['versions'].get(version, {})
                if version_data.get('yanked', False):
                    yank_reason = version_data.get('yank_reason', 'No reason provided')
                    raise click.ClickException(
                        f"Version {version} of {package_id} has been yanked (disabled)\n"
                        f"Reason: {yank_reason}\n"
                        f"Use --force to install anyway (not recommended)"
                    )
        
        if not version:
            if requested_version:
                raise click.ClickException(
                    f"Package {package_id}@{requested_version} not found or not compatible with BEE2 {self.user_version}"
                )
            else:
                raise click.ClickException(
                    f"No compatible version of {package_id} found for BEE2 {self.user_version}"
                )
        
        # Mark as resolved
        self.resolved[package_id] = version
        self.resolution_path.add(package_id)
        
        # Get package info
        by_id = self.registry.get('packages', {}).get('by_id', {})
        package = by_id[package_id]
        display_name = package.get('display_name', package_id)
        # Use the sanitized name from registry, fallback to lowercased display_name with spaces removed
        name = package.get('name', display_name.lower().replace(' ', '').replace("'", ''))

        result = {
            package_id: (version, author, display_name, name)
        }
        
        # Resolve dependencies
        version_data = package['versions'][version]
        dependencies = version_data.get('dependencies', {})
        
        for dep_spec, dep_version_range in dependencies.items():
            # Parse dependency spec: @author/PACKAGE_ID
            match = re.match(r'^@([^/]+)/(.+)$', dep_spec)
            if not match:
                raise click.ClickException(f"Invalid dependency format: {dep_spec}")
            
            dep_author, dep_package_id = match.groups()
            
            # Parse version range
            dep_requested_version = None
            if dep_version_range and dep_version_range != "*":
                # For now, extract exact version from simple specs like "^1.0.0" or "1.0.0"
                # More complex: use packaging.specifiers to find compatible versions
                pass  # We'll resolve the best compatible version
            
            # Recursively resolve
            dep_results = self.resolve(dep_package_id, dep_author, dep_requested_version, 
                                      required_by=package_id)
            result.update(dep_results)
        
        # Remove from resolution path (we're done with this branch)
        self.resolution_path.discard(package_id)
        
        return result


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


def download_package(client, bucket: str, package_path: str, package_id: str, version: str) -> Path:
    """Download package from R2 to temp directory
    
    Returns: Path to downloaded .bee_pack file
    """
    # Build S3 key
    s3_key = f"{package_path.lstrip('/')}package.bee_pack"
    
    # Create temp file
    temp_dir = Path(tempfile.gettempdir())
    temp_file = temp_dir / f"{package_id}_{version}.bee_pack"
    
    try:
        # Get file size for progress bar
        response = client.head_object(Bucket=bucket, Key=s3_key)
        file_size = response['ContentLength']
        
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(complete_style="green", finished_style="green"),
            DownloadColumn(),
            TransferSpeedColumn(),
        ) as progress:
            task = progress.add_task(f"Downloading {package_id}@{version}...", total=file_size)
            
            # Track total bytes for accurate completion
            total_downloaded = [0]
            
            def callback(bytes_transferred):
                total_downloaded[0] += bytes_transferred
                progress.update(task, completed=total_downloaded[0])
            
            client.download_file(
                bucket,
                s3_key,
                str(temp_file),
                Callback=callback
            )
            
            # Ensure progress shows 100% complete
            progress.update(task, completed=file_size)
        
        return temp_file
        
    except ClientError as e:
        error_code = e.response.get('Error', {}).get('Code', '')
        if error_code == '404' or error_code == 'NoSuchKey':
            raise click.ClickException(f"Package file not found in registry: {package_id}@{version}")
        else:
            raise click.ClickException(f"Failed to download {package_id}: {e}")


def download_github_package(download_url: str, package_id: str, version: str) -> Path:
    """Download package from GitHub release URL

    Returns: Path to downloaded .bee_pack file
    """
    temp_dir = Path(tempfile.gettempdir())
    temp_file = temp_dir / f"{package_id}_{version}.bee_pack"

    try:
        # Stream download with progress
        response = requests.get(download_url, stream=True, timeout=60, allow_redirects=True)
        response.raise_for_status()

        file_size = int(response.headers.get('content-length', 0))

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(complete_style="green", finished_style="green"),
            DownloadColumn(),
            transient=True
        ) as progress:
            task = progress.add_task(f"Downloading {package_id}...", total=file_size or None)

            with open(temp_file, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
                        progress.update(task, advance=len(chunk))

        return temp_file

    except requests.RequestException as e:
        raise click.ClickException(f"Failed to download {package_id} from GitHub: {e}")


def install_package(bee_pack_path: Path, package_id: str, author: str) -> None:
    """Install package to packages directory as .bee_pack file"""
    paths = get_beepm_paths()
    
    # Destination: packages/author_packageid.bee_pack
    dest_file = paths['packages'] / f"{author}_{package_id}.bee_pack"
    
    # Remove existing installation if it exists
    if dest_file.exists():
        dest_file.unlink()
    
    try:
        # Verify the package before installing
        with zipfile.ZipFile(bee_pack_path, 'r') as zip_ref:
            # Check if bee-package.json exists
            if "bee-package.json" not in zip_ref.namelist():
                raise click.ClickException(f"Invalid package: bee-package.json not found")

            # Get package ID - try bee-package.json first, then info.txt
            with zip_ref.open("bee-package.json") as f:
                package_data = json.load(f)

            actual_id = package_data.get('id')

            # If no ID in bee-package.json, try to get from info.txt (authoritative source)
            if not actual_id and "info.txt" in zip_ref.namelist():
                with zip_ref.open("info.txt") as f:
                    info_content = f.read().decode('utf-8')
                    # Look for ID field
                    match = re.search(r'^\s*"ID"\s+"([^"]+)"', info_content, re.MULTILINE | re.IGNORECASE)
                    if match:
                        actual_id = match.group(1).upper()

            # Verify package ID matches
            if actual_id != package_id:
                raise click.ClickException(
                    f"Package ID mismatch: expected {package_id}, got {actual_id}"
                )
        
        # Copy the .bee_pack file to packages directory
        shutil.copy2(bee_pack_path, dest_file)
        
    except zipfile.BadZipFile:
        raise click.ClickException(f"Corrupted package file: {bee_pack_path}")
    except Exception as e:
        # Clean up on error
        if dest_file.exists():
            dest_file.unlink()
        raise


def update_installed_tracking(packages_to_install: Dict[str, Tuple[str, str, str, str]],
                              main_package_id: str) -> None:
    """Update installed_packages.json with newly installed packages"""
    installed = load_installed_packages()

    if 'packages' not in installed:
        installed['packages'] = {}

    for package_id, (version, author, display_name, name) in packages_to_install.items():
        is_dependency = (package_id != main_package_id)

        # Use the sanitized name from the registry
        package_name = name
        
        if package_id in installed['packages']:
            # Update existing
            pkg = installed['packages'][package_id]
            pkg['version'] = version
            
            # If it was a dependency but now explicitly installed, update
            if not is_dependency:
                pkg['installed_as_dependency'] = False
            
            # Update required_by if it's a dependency
            if is_dependency and main_package_id not in pkg.get('required_by', []):
                if 'required_by' not in pkg:
                    pkg['required_by'] = []
                pkg['required_by'].append(main_package_id)
        else:
            # Add new entry
            installed['packages'][package_id] = {
                'version': version,
                'author': author,
                'name': package_name,
                'display_name': display_name,
                'installed_as_dependency': is_dependency,
                'required_by': [main_package_id] if is_dependency else []
            }
    
    save_installed_packages(installed)


@click.command()
@click.argument('package_spec', required=False)
@click.option('--force', is_flag=True, help='Force reinstall even if already installed')
@click.option('-r', '--requirements', 'requirements_file', type=click.Path(exists=True), help='Install from requirements file')
def install(package_spec: Optional[str], force: bool, requirements_file: Optional[str]):
    """Install a package from BeePM registry
    
    PACKAGE_SPEC can be:
    - packagename (searches for package)
    - author@packagename (specific author)
    - author@packagename@version (specific version)
    
    Or install from a requirements file:
    - beepm install -r requirements.txt
    
    Examples:
      beepm install mypackage
      beepm install author@mypackage
      beepm install author@mypackage@1.0.0
      beepm install -r requirements.txt
    """
    click.echo(click.style("\n BeePM Install", fg="cyan", bold=True))
    click.echo()
    
    # Handle requirements file
    if requirements_file:
        return install_from_requirements(requirements_file, force)
    
    # Require package_spec if not using requirements file
    if not package_spec:
        click.echo(click.style("[X] Error: Please specify a package or use -r for requirements file", fg="red", bold=True))
        click.echo("\nUsage:")
        click.echo("  beepm install <package>")
        click.echo("  beepm install -r requirements.txt")
        raise click.Abort()
    
    # Install single package
    try:
        install_single_package(package_spec, force)
    except click.ClickException as e:
        click.echo(click.style(f"[X] {e.format_message()}", fg="red", bold=True))
        raise click.Abort()
    except Exception as e:
        click.echo(click.style(f"[X] Installation failed: {e}", fg="red", bold=True))
        raise click.Abort()


if __name__ == "__main__":
    install()

