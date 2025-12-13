"""Search for packages in the registry"""

import os
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


@click.command()
@click.argument('query')
def search(query: str):
    """Search for packages in the registry
    
    Searches package names, IDs, and authors for matches.
    
    Examples:
      beepm search cube
      beepm search areng
    """
    click.echo(click.style(f"\n🔍 Searching for: {query}", fg="cyan", bold=True))
    click.echo()
    
    # Fetch registry
    click.echo("Fetching registry...")
    registry = fetch_registry()
    
    by_id = registry.get('packages', {}).get('by_id', {})
    
    if not by_id:
        click.echo(click.style("\n❌ No packages available", fg="yellow"))
        click.echo("The registry is empty or not accessible.")
        return
    
    # Search packages
    query_lower = query.lower()
    matches = []
    
    for package_id, package_data in by_id.items():
        author = package_data.get('author', '').lower()
        display_name = package_data.get('display_name', '').lower()
        package_name = package_data.get('name', '').lower()
        package_id_lower = package_id.lower()
        
        # Check if query matches any field
        if (query_lower in author or 
            query_lower in display_name or 
            query_lower in package_name or 
            query_lower in package_id_lower):
            matches.append((package_id, package_data))
    
    if not matches:
        click.echo(click.style(f"✗ No packages found matching '{query}'", fg="yellow"))
        return
    
    click.echo(click.style(f"✓ Found {len(matches)} package(s)\n", fg="green"))
    
    # Create table
    table = Table(show_header=True, header_style="bold cyan")
    table.add_column("Package", style="bright_white", no_wrap=True)
    table.add_column("Author", style="blue")
    table.add_column("Latest Version", style="green")
    table.add_column("Versions", style="yellow")
    
    # Sort matches by relevance (exact matches first)
    matches.sort(key=lambda x: (
        query_lower not in x[1].get('display_name', '').lower(),
        x[1].get('display_name', '').lower()
    ))
    
    for package_id, package_data in matches:
        author = package_data.get('author', 'Unknown')
        display_name = package_data.get('display_name', package_id)
        versions = package_data.get('versions', {})
        
        if versions:
            version_list = list(versions.keys())
            latest_version = version_list[-1] if version_list else 'N/A'
            version_count = len(version_list)
        else:
            latest_version = 'N/A'
            version_count = 0
        
        # Format package name
        package_name = f"[bold]{display_name}[/bold]\n{author}@{package_data.get('name', '')}"
        
        table.add_row(
            package_name,
            author,
            latest_version,
            str(version_count)
        )
    
    console.print(table)
    
    click.echo()
    click.echo(click.style("💡 Tip:", fg="cyan", bold=True) + " Use 'beepm info <package>' for detailed information")
    click.echo()


if __name__ == "__main__":
    search()

