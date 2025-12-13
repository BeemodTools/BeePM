"""Show detailed information about a package"""

import os
from typing import Dict, Any, Optional, Tuple

import click
import requests
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.tree import Tree
from rich import box
from dotenv import load_dotenv, find_dotenv

# Load environment variables from .env file
dotenv_path = find_dotenv(usecwd=True)
if dotenv_path:
    load_dotenv(dotenv_path)
else:
    load_dotenv()

console = Console()


def fetch_registry() -> Dict[str, Any]:
    """Fetch current registry from R2"""
    registry_url = os.environ.get('BEEPM_REGISTRY_URL', 'https://r2.beepm.com/registry.json')
    
    try:
        response = requests.get(registry_url, timeout=30)
        
        if response.status_code == 404:
            raise click.ClickException("Registry not found")
        
        response.raise_for_status()
        
        if not response.content or len(response.content.strip()) == 0:
            raise click.ClickException("Registry is empty")
        
        return response.json()
    except (requests.exceptions.JSONDecodeError, ValueError):
        raise click.ClickException("Registry is corrupted")
    except requests.RequestException as e:
        raise click.ClickException(f"Failed to fetch registry: {e}")


def parse_package_spec(package_spec: str) -> Tuple[Optional[str], str]:
    """Parse package identifier into (author, package_name)"""
    if '@' in package_spec:
        parts = package_spec.split('@', 1)
        return (parts[0].lower(), parts[1].lower())
    else:
        return (None, package_spec.lower())


def find_package(registry: Dict[str, Any], author: Optional[str], package_name: str) -> Tuple[str, Dict[str, Any]]:
    """Find package in registry
    
    Returns: (package_id, package_data)
    """
    by_name = registry.get('packages', {}).get('by_name', {})
    by_id = registry.get('packages', {}).get('by_id', {})
    
    if author:
        # Exact lookup
        key = f"{author}@{package_name}"
        if key not in by_name:
            raise click.ClickException(f"Package not found: {key}")
        
        package_id = by_name[key]
    else:
        # Search for packages with this name
        matches = []
        for key, pkg_id in by_name.items():
            if key.split('@')[1] == package_name:
                matches.append((key, pkg_id))
        
        if len(matches) == 0:
            raise click.ClickException(f"Package not found: {package_name}")
        elif len(matches) > 1:
            click.echo(click.style(f"Multiple packages found with name '{package_name}':", fg="yellow", bold=True))
            for key, _ in matches:
                click.echo(f"  - {key}")
            raise click.ClickException("Please specify author: author@packagename")
        
        package_id = matches[0][1]
    
    if package_id not in by_id:
        raise click.ClickException(f"Package data not found for: {package_id}")
    
    return package_id, by_id[package_id]


@click.command()
@click.argument('package_spec')
def info(package_spec: str):
    """Show detailed information about a package
    
    PACKAGE_SPEC can be:
    - packagename (searches for package)
    - author@packagename (specific author)
    
    Examples:
      beepm info mypackage
      beepm info author@mypackage
    """
    click.echo(click.style("\n📋 Package Information", fg="cyan", bold=True))
    click.echo()
    
    # Parse package spec
    try:
        author, package_name = parse_package_spec(package_spec)
    except Exception as e:
        click.echo(click.style(f"❌ Invalid package format: {e}", fg="red", bold=True))
        raise click.Abort()
    
    # Fetch registry
    click.echo("Fetching package information...")
    try:
        registry = fetch_registry()
        package_id, package_data = find_package(registry, author, package_name)
        click.echo(click.style("✓ Package found\n", fg="green"))
    except click.ClickException as e:
        click.echo(click.style(f"❌ {e.format_message()}", fg="red", bold=True))
        raise click.Abort()
    
    # Extract data
    display_name = package_data.get('display_name', package_id)
    author_name = package_data.get('author', 'Unknown')
    package_name_lower = package_data.get('name', '')
    versions = package_data.get('versions', {})
    
    # Create main info panel
    info_text = f"[bold cyan]Package ID:[/bold cyan] {package_id}\n"
    info_text += f"[bold cyan]Name:[/bold cyan] {display_name}\n"
    info_text += f"[bold cyan]Author:[/bold cyan] {author_name}\n"
    info_text += f"[bold cyan]Total Versions:[/bold cyan] {len(versions)}\n"
    
    # Install command
    install_cmd = f"beepm install {author_name.lower()}@{package_name_lower}"
    info_text += f"\n[bold green]Install:[/bold green] {install_cmd}"
    
    panel = Panel(info_text, title="📦 Package Details", border_style="cyan", box=box.ROUNDED)
    console.print(panel)
    
    # Versions table
    if versions:
        click.echo()
        console.print("[bold cyan]Available Versions:[/bold cyan]")
        
        table = Table(show_header=True, header_style="bold cyan", box=box.SIMPLE)
        table.add_column("Version", style="green", no_wrap=True)
        table.add_column("Compatible With", style="yellow")
        table.add_column("Dependencies", style="blue")
        
        # Sort versions (newest first)
        sorted_versions = sorted(versions.items(), reverse=True)
        
        for version, version_data in sorted_versions:
            compatible = version_data.get('compatibleWith', 'Unknown')
            dependencies = version_data.get('dependencies', {})
            
            # Format compatible with
            if isinstance(compatible, list):
                compatible_str = ', '.join(compatible)
            else:
                compatible_str = str(compatible)
            
            # Format dependencies
            if dependencies:
                dep_count = len(dependencies)
                dep_str = f"{dep_count} package(s)"
            else:
                dep_str = "None"
            
            table.add_row(version, compatible_str, dep_str)
        
        console.print(table)
    
    # Show dependencies for latest version
    if versions:
        latest_version = sorted(versions.keys(), reverse=True)[0]
        latest_data = versions[latest_version]
        dependencies = latest_data.get('dependencies', {})
        
        if dependencies:
            click.echo()
            console.print(f"[bold cyan]Dependencies for v{latest_version}:[/bold cyan]")
            
            tree = Tree("📦 Dependencies", style="cyan")
            for dep_spec, version_range in dependencies.items():
                tree.add(f"{dep_spec} ({version_range})")
            
            console.print(tree)
    
    click.echo()


if __name__ == "__main__":
    info()

