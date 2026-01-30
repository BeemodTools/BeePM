"""Update installed packages to latest compatible versions"""

import os
import json
from pathlib import Path
from typing import Dict, Any, List, Tuple

import click
from rich.console import Console
from rich.table import Table
from dotenv import load_dotenv, find_dotenv

# Import from install command
import sys
sys.path.insert(0, str(Path(__file__).parent))
from install import (
    get_beepm_paths, load_config, load_installed_packages,
    fetch_registry, resolve_version, install_single_package
)

# Load environment variables from .env file
dotenv_path = find_dotenv(usecwd=True)
if dotenv_path:
    load_dotenv(dotenv_path)
else:
    load_dotenv()

console = Console()


def check_for_updates(registry: Dict[str, Any], installed: Dict[str, Any], 
                      user_version: str) -> Dict[str, Tuple[str, str]]:
    """Check which installed packages have updates available
    
    Returns: {package_id: (current_version, latest_version)}
    """
    updates_available = {}
    by_id = registry.get('packages', {}).get('by_id', {})
    
    for package_id, pkg_data in installed.get('packages', {}).items():
        current_version = pkg_data.get('version')
        author = pkg_data.get('author')
        
        if package_id not in by_id:
            continue
        
        # Find latest compatible version
        latest_version = resolve_version(registry, package_id, author, user_version, None)
        
        if latest_version and latest_version != current_version:
            updates_available[package_id] = (current_version, latest_version)
    
    return updates_available


@click.command()
@click.argument('package_spec', required=False)
@click.option('--all', 'update_all', is_flag=True, help='Update all installed packages')
@click.option('--check', is_flag=True, help='Check for updates without installing')
@click.option('--force', is_flag=True, help='Force reinstall even if already at latest')
def update(package_spec: str, update_all: bool, check: bool, force: bool):
    """Update installed packages to latest compatible versions
    
    PACKAGE_SPEC: Specific package to update (author@packagename)
    
    Options:
      --all     Update all installed packages
      --check   Only check for updates, don't install
      --force   Force reinstall even at latest version
    
    Examples:
      beepm update --check           # Check for updates
      beepm update --all             # Update all packages
      beepm update areng14@package   # Update specific package
    """
    click.echo(click.style("\n BeePM Update", fg="cyan", bold=True))
    click.echo()
    
    # Load config
    config = load_config()
    if not config:
        click.echo(click.style("[X] BeePM not initialized", fg="red", bold=True))
        click.echo("\nPlease run 'beepm init' first to set up BeePM")
        raise click.Abort()
    
    user_version = config.get('beemod_version')
    if not user_version:
        click.echo(click.style("[X] BEE2 version not found in config", fg="red", bold=True))
        click.echo("\nPlease run 'beepm init' to configure your BEE2 installation")
        raise click.Abort()
    
    click.echo(f"BEE2 Version: {user_version}")
    
    # Load installed packages
    installed = load_installed_packages()
    if not installed.get('packages'):
        click.echo()
        click.echo(click.style("No packages installed yet", fg="yellow"))
        click.echo("\nInstall packages with: beepm install <package>")
        return
    
    # Fetch registry
    click.echo("Fetching registry...")
    try:
        registry = fetch_registry()
        click.echo(click.style("[OK] Registry fetched", fg="green"))
    except Exception as e:
        click.echo(click.style(f"[X] Failed to fetch registry: {e}", fg="red", bold=True))
        raise click.Abort()
    
    # Check for updates
    click.echo()
    click.echo("Checking for updates...")
    updates = check_for_updates(registry, installed, user_version)
    
    if not updates:
        click.echo()
        click.echo(click.style("[OK] All packages are up to date!", fg="green", bold=True))
        return
    
    click.echo(click.style(f"[OK] Found {len(updates)} update(s) available", fg="green"))
    click.echo()
    
    # Show updates in table
    table = Table(show_header=True, header_style="bold cyan")
    table.add_column("Package", style="bright_white")
    table.add_column("Current", style="yellow")
    table.add_column("Latest", style="green")
    table.add_column("Author", style="blue")
    
    by_id = registry.get('packages', {}).get('by_id', {})
    packages_to_update = []
    
    for package_id, (current, latest) in updates.items():
        pkg_data = installed['packages'][package_id]
        display_name = pkg_data.get('display_name', package_id)
        author = pkg_data.get('author', 'Unknown')
        
        # If specific package requested, filter
        if package_spec:
            package_lower = package_spec.lower()
            if not (package_lower in f"{author}@{pkg_data.get('name', '')}".lower() or
                   package_lower in package_id.lower()):
                continue
        
        table.add_row(display_name, current, latest, author)
        packages_to_update.append((package_id, author, pkg_data.get('name', '')))
    
    console.print(table)
    click.echo()
    
    # If just checking, stop here
    if check:
        click.echo(click.style("Tip: Tip:", fg="cyan", bold=True) + " Run 'beepm update --all' to update all packages")
        return
    
    # Determine what to update
    if not update_all and not package_spec:
        click.echo(click.style("i  Use --all to update all packages, or specify a package name", fg="cyan"))
        return
    
    if not packages_to_update:
        if package_spec:
            click.echo(click.style(f"Package '{package_spec}' not found or already up to date", fg="yellow"))
        return
    
    # Confirm update
    if not click.confirm(click.style(f"\nUpdate {len(packages_to_update)} package(s)?", fg="cyan", bold=True)):
        click.echo("Update cancelled.")
        return
    
    # Update packages
    click.echo()
    updated_count = 0
    failed_packages = []
    
    for i, (package_id, author, name) in enumerate(packages_to_update, 1):
        package_spec_str = f"{author}@{name}"
        click.echo(click.style(f"\n[{i}/{len(packages_to_update)}] Updating {package_spec_str}...", fg="cyan", bold=True))
        click.echo()
        
        try:
            install_single_package(package_spec_str, force=True)  # Force to update
            updated_count += 1
        except Exception as e:
            click.echo(click.style(f"[X] Failed to update {package_spec_str}: {e}", fg="red"))
            failed_packages.append(package_spec_str)
            continue
    
    # Summary
    click.echo()
    click.echo(click.style("=" * 60, fg="cyan"))
    click.echo(click.style("Update Summary", fg="cyan", bold=True))
    click.echo(click.style("=" * 60, fg="cyan"))
    click.echo()
    
    if updated_count > 0:
        click.echo(click.style(f"[OK] Successfully updated: {updated_count}/{len(packages_to_update)} package(s)", fg="green", bold=True))
    
    if failed_packages:
        click.echo(click.style(f"[X] Failed to update: {len(failed_packages)} package(s)", fg="red", bold=True))
        click.echo("\nFailed packages:")
        for pkg in failed_packages:
            click.echo(f"  * {pkg}")
    
    click.echo()


if __name__ == "__main__":
    update()

