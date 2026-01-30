"""List available packages in BeePM registry"""

import os
import json
from pathlib import Path
from typing import Dict, Any

import click
import requests
from rich.console import Console
from rich.table import Table
from dotenv import load_dotenv, find_dotenv

# Load environment variables from .env file
dotenv_path = find_dotenv(usecwd=True)
if dotenv_path:
    load_dotenv(dotenv_path)
else:
    load_dotenv()

console = Console()


def get_beepm_paths():
    """Get BeePM directory paths"""
    appdata = Path(os.environ.get("APPDATA", ""))
    beepm_root = appdata / "beepm"
    
    return {
        "root": beepm_root,
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


def fetch_registry() -> Dict[str, Any]:
    """Fetch current registry from R2"""
    registry_url = os.environ.get('BEEPM_REGISTRY_URL', 'https://r2.beepm.com/registry.json')
    
    try:
        response = requests.get(registry_url, timeout=30)
        
        if response.status_code == 404:
            return {"packages": {"by_id": {}, "by_name": {}}}
        
        response.raise_for_status()
        
        if not response.content or len(response.content.strip()) == 0:
            return {"packages": {"by_id": {}, "by_name": {}}}
        
        return response.json()
    except (requests.exceptions.JSONDecodeError, ValueError):
        return {"packages": {"by_id": {}, "by_name": {}}}
    except requests.RequestException:
        return {"packages": {"by_id": {}, "by_name": {}}}


@click.command(name='list')
@click.option('--installed', is_flag=True, help='Show only installed packages')
def list_packages(installed: bool):
    """List all available packages in the registry
    
    Shows all packages available for installation from the BeePM registry.
    Use --installed to show only packages you have installed locally.
    
    Examples:
      beepm list
      beepm list --installed
    """
    if installed:
        click.echo(click.style("\n Installed Packages", fg="cyan", bold=True))
        click.echo()
        
        installed_data = load_installed_packages()
        packages = installed_data.get('packages', {})
        
        if not packages:
            click.echo(click.style("No packages installed yet", fg="yellow"))
            click.echo("\nInstall packages with: beepm install <package>")
            return
        
        click.echo(click.style(f"Found {len(packages)} installed package(s)\n", fg="green"))
        
        # Create table
        table = Table(show_header=True, header_style="bold cyan")
        table.add_column("Package", style="bright_white", no_wrap=True)
        table.add_column("Author", style="blue")
        table.add_column("Version", style="green")
        table.add_column("Type", style="yellow")
        
        # Sort by name
        sorted_packages = sorted(packages.items(), key=lambda x: x[1].get('display_name', '').lower())
        
        for package_id, pkg_data in sorted_packages:
            display_name = pkg_data.get('display_name', package_id)
            author = pkg_data.get('author', 'Unknown')
            version = pkg_data.get('version', 'Unknown')
            is_dep = pkg_data.get('installed_as_dependency', False)
            
            pkg_type = "Dependency" if is_dep else "Explicit"
            
            # Format package name
            package_name = f"[bold]{display_name}[/bold]\n{package_id}"
            
            table.add_row(package_name, author, version, pkg_type)
        
        console.print(table)
        click.echo()
        return
    
    click.echo(click.style("\n Available Packages", fg="cyan", bold=True))
    click.echo()
    
    # Fetch registry
    click.echo("Fetching registry...")
    registry = fetch_registry()
    
    by_id = registry.get('packages', {}).get('by_id', {})
    
    if not by_id:
        click.echo(click.style("\n[X] No packages available", fg="yellow"))
        click.echo("The registry is empty or not accessible.")
        return
    
    click.echo(click.style(f"[OK] Found {len(by_id)} package(s)\n", fg="green"))
    
    # Group packages by author
    packages_by_author = {}
    for package_id, package_data in by_id.items():
        author = package_data.get('author', 'Unknown')
        if author not in packages_by_author:
            packages_by_author[author] = []
        packages_by_author[author].append((package_id, package_data))
    
    # Sort authors alphabetically
    sorted_authors = sorted(packages_by_author.keys())
    
    # Display packages grouped by author
    for author in sorted_authors:
        # Author header
        click.echo(click.style(f"| {author}", fg="bright_cyan", bold=True))
        
        # Sort packages by display name within each author
        author_packages = sorted(
            packages_by_author[author], 
            key=lambda x: x[1].get('display_name', '').lower()
        )
        
        for i, (package_id, package_data) in enumerate(author_packages):
            display_name = package_data.get('display_name', package_id)
            name = package_data.get('name', '')
            versions = package_data.get('versions', {})
            
            if versions:
                version_list = list(versions.keys())
                latest_version = version_list[-1] if version_list else 'N/A'
                version_count = len(version_list)
            else:
                latest_version = 'N/A'
                version_count = 0
            
            # Package info - simpler format
            click.echo(click.style("  * ", fg="bright_cyan") + 
                      click.style(display_name, fg="bright_white", bold=True) +
                      click.style(f" v{latest_version}", fg="green"))
            click.echo(click.style("    ", fg="bright_cyan") + 
                      click.style(f"beepm install {author.lower()}@{name}", fg="yellow"))
        
        click.echo()
    
    click.echo(click.style("Tip:", fg="cyan", bold=True) + " Use 'beepm info <package>' for detailed information")
    click.echo()


if __name__ == "__main__":
    list_packages()

