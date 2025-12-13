"""Uninstall packages from BeePM"""

import os
import json
import shutil
from pathlib import Path
from typing import Dict, Any, List, Tuple

import click
from rich.console import Console
from rich.table import Table

console = Console()


def get_beepm_paths():
    """Get BeePM directory paths"""
    appdata = Path(os.environ.get("APPDATA", ""))
    beepm_root = appdata / "beepm"
    
    return {
        "root": beepm_root,
        "packages": beepm_root / "packages",
        "config": beepm_root / "config",
        "installed_file": beepm_root / "config" / "installed_packages.json"
    }


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


def find_installed_package(installed: Dict[str, Any], package_spec: str) -> Tuple[str, Dict[str, Any]]:
    """Find an installed package by spec (author@name or package_id)
    
    Returns: (package_id, package_data)
    """
    package_spec = package_spec.lower()
    packages = installed.get('packages', {})
    
    # Direct ID match
    if package_spec in packages:
        return (package_spec, packages[package_spec])
    
    # Search by author@name
    for package_id, pkg_data in packages.items():
        author = pkg_data.get('author', '').lower()
        name = pkg_data.get('name', '').lower()
        
        if f"{author}@{name}" == package_spec:
            return (package_id, pkg_data)
        
        # Also check display_name
        display_name = pkg_data.get('display_name', '').lower()
        if display_name == package_spec:
            return (package_id, pkg_data)
    
    raise click.ClickException(f"Package not found: {package_spec}")


def get_dependents(installed: Dict[str, Any], package_id: str) -> List[Tuple[str, str]]:
    """Get packages that depend on this package
    
    Returns: [(package_id, display_name), ...]
    """
    dependents = []
    packages = installed.get('packages', {})
    
    for pkg_id, pkg_data in packages.items():
        required_by = pkg_data.get('required_by', [])
        if package_id in required_by:
            display_name = pkg_data.get('display_name', pkg_id)
            dependents.append((pkg_id, display_name))
    
    return dependents


def uninstall_package(package_id: str, author: str) -> None:
    """Remove package files from packages directory"""
    paths = get_beepm_paths()
    install_dir = paths['packages'] / f"{author}_{package_id}"
    
    if install_dir.exists():
        shutil.rmtree(install_dir)


@click.command()
@click.argument('package_spec', required=False)
@click.option('--all', 'uninstall_all', is_flag=True, help='Uninstall all packages')
@click.option('--yes', is_flag=True, help='Skip confirmation prompt')
def uninstall(package_spec: str, uninstall_all: bool, yes: bool):
    """Uninstall packages from BeePM
    
    PACKAGE_SPEC can be:
    - packagename
    - author@packagename
    - PACKAGE_ID
    
    Examples:
      beepm uninstall areng14@arengspackages
      beepm uninstall ARENGS_PACKAGES
      beepm uninstall --all
    """
    click.echo(click.style("\n🗑️  BeePM Uninstall", fg="cyan", bold=True))
    click.echo()
    
    # Load installed packages
    installed = load_installed_packages()
    packages = installed.get('packages', {})
    
    if not packages:
        click.echo(click.style("No packages installed", fg="yellow"))
        return
    
    # Handle --all flag
    if uninstall_all:
        click.echo(click.style(f"Found {len(packages)} installed package(s):", fg="cyan"))
        for pkg_id, pkg_data in packages.items():
            display_name = pkg_data.get('display_name', pkg_id)
            version = pkg_data.get('version', 'unknown')
            click.echo(f"  • {display_name}@{version}")
        
        click.echo()
        if not yes and not click.confirm(click.style("Uninstall ALL packages?", fg="red", bold=True)):
            click.echo("Cancelled.")
            return
        
        click.echo()
        paths = get_beepm_paths()
        
        # Remove all package directories
        for pkg_id, pkg_data in packages.items():
            author = pkg_data.get('author', '')
            display_name = pkg_data.get('display_name', pkg_id)
            
            try:
                uninstall_package(pkg_id, author)
                click.echo(click.style(f"✓ Uninstalled {display_name}", fg="green"))
            except Exception as e:
                click.echo(click.style(f"✗ Failed to uninstall {display_name}: {e}", fg="red"))
        
        # Clear installed packages list
        save_installed_packages({"packages": {}})
        
        click.echo()
        click.echo(click.style("✓ All packages uninstalled!", fg="green", bold=True))
        return
    
    # Require package_spec if not using --all
    if not package_spec:
        click.echo(click.style("❌ Error: Please specify a package or use --all", fg="red", bold=True))
        click.echo("\nUsage:")
        click.echo("  beepm uninstall <package>")
        click.echo("  beepm uninstall --all")
        raise click.Abort()
    
    # Find the package
    try:
        package_id, pkg_data = find_installed_package(installed, package_spec)
    except click.ClickException as e:
        click.echo(click.style(f"❌ {e.format_message()}", fg="red", bold=True))
        click.echo("\nInstalled packages:")
        for pkg_id, data in packages.items():
            display_name = data.get('display_name', pkg_id)
            author = data.get('author', '')
            click.echo(f"  • {author}@{data.get('name', '')} ({display_name})")
        raise click.Abort()
    
    display_name = pkg_data.get('display_name', package_id)
    version = pkg_data.get('version', 'unknown')
    author = pkg_data.get('author', '')
    is_dependency = pkg_data.get('installed_as_dependency', False)
    
    click.echo(f"Package: {display_name}")
    click.echo(f"Version: {version}")
    click.echo(f"Author: {author}")
    
    if is_dependency:
        click.echo(click.style("Type: Dependency", fg="yellow"))
    
    # Check for dependents
    dependents = get_dependents(installed, package_id)
    
    if dependents:
        click.echo()
        click.echo(click.style("⚠️  Warning: Other packages depend on this!", fg="yellow", bold=True))
        click.echo("\nThe following packages will break:")
        for dep_id, dep_name in dependents:
            click.echo(f"  • {dep_name}")
        click.echo()
    
    # Confirm
    if not yes:
        click.echo()
        if not click.confirm(click.style(f"Uninstall {display_name}?", fg="red", bold=True)):
            click.echo("Cancelled.")
            return
    
    # Uninstall
    click.echo()
    try:
        uninstall_package(package_id, author)
        click.echo(click.style(f"✓ Removed package files", fg="green"))
    except Exception as e:
        click.echo(click.style(f"✗ Failed to remove files: {e}", fg="red"))
        # Continue anyway to clean up metadata
    
    # Update installed packages tracking
    del packages[package_id]
    
    # Remove this package from required_by lists
    for pkg_id, pkg_data_item in packages.items():
        required_by = pkg_data_item.get('required_by', [])
        if package_id in required_by:
            required_by.remove(package_id)
    
    save_installed_packages(installed)
    click.echo(click.style(f"✓ Updated package registry", fg="green"))
    
    click.echo()
    click.echo(click.style(f"✓ {display_name} has been uninstalled!", fg="green", bold=True))
    
    if dependents:
        click.echo()
        click.echo(click.style("⚠️  Remember: Dependent packages may be broken!", fg="yellow"))
    
    click.echo()


if __name__ == "__main__":
    uninstall()

