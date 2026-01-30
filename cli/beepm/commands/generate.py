"""Generate bee-package.json for a BEE2 package directory"""

import json
import re
from pathlib import Path
from typing import Optional, Dict, Any

import click
from srctools.property_parser import Property


def read_info_txt(package_dir: Path) -> Optional[Dict[str, Any]]:
    """Read and parse info.txt from package directory using srctools VDF parser"""
    info_file = package_dir / "info.txt"
    
    if not info_file.exists():
        return None
    
    info = {}
    try:
        with open(info_file, 'r', encoding='utf-8') as f:
            props = Property.parse(f)
        
        # Parse ID
        id_prop = props.find_key('ID')
        if id_prop:
            info['id'] = id_prop.value
        
        # Parse Name
        name_prop = props.find_key('Name')
        if name_prop:
            info['name'] = name_prop.value
        
        # Parse Prerequisites/Dependencies
        dependencies = {}
        try:
            prerequisites_prop = props.find_key('Prerequisites')
            if prerequisites_prop:
                # Find all "Package" entries under Prerequisites
                for child in prerequisites_prop:
                    if child.name.lower() == 'package':
                        dep_package_id = child.value
                        # Store as @beemod/ID (base packages are from beemod)
                        # User can manually change to author@name format if needed
                        dependencies[f"@beemod/{dep_package_id}"] = "*"
        except (KeyError, LookupError):
            pass
        
        if dependencies:
            info['dependencies'] = dependencies
            
    except Exception:
        pass
    
    return info if info else None


def validate_package_id(package_id: str) -> bool:
    """Validate package ID format (alphanumeric and underscores only)"""
    return bool(re.match(r'^[A-Z0-9_]+$', package_id))


def validate_package_name(name: str) -> bool:
    """Validate package name (no special symbols, spaces allowed)"""
    return bool(re.match(r'^[A-Za-z0-9 ]+$', name))


def validate_author(author: str) -> bool:
    """Validate author name (alphanumeric only)"""
    return bool(re.match(r'^[A-Za-z0-9]+$', author))


def validate_semver(version: str) -> bool:
    """Validate semantic version"""
    try:
        import semver
        semver.VersionInfo.parse(version)
        return True
    except:
        return False


def validate_bee2_version(ver: str) -> bool:
    """Validate BEE2 version specifier"""
    # Simple check for common patterns like ">=2.4.41" or "^2.4.46"
    return bool(re.match(r'^[><=^~]+\d+\.\d+\.\d+', ver))


@click.command()
@click.argument('package_dir', type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option('--author', help='Package author (GitHub username)')
@click.option('--id', 'package_id', help='Package ID (uppercase, underscores only)')
@click.option('--name', help='Package display name')
@click.option('--version', default='1.0.0', help='Package version (default: 1.0.0)')
@click.option('--compatible', default='>=2.4.41', help='Compatible BEE2 version (default: >=2.4.41)')
@click.option('--auto', is_flag=True, help='Auto-generate with defaults from info.txt (no prompts)')
@click.option('--force', is_flag=True, help='Overwrite existing bee-package.json')
def generate(package_dir: Path, author: Optional[str], package_id: Optional[str], 
             name: Optional[str], version: str, compatible: str, auto: bool, force: bool):
    """Generate bee-package.json for a BEE2 package directory
    
    PACKAGE_DIR: Path to the package directory containing info.txt
    
    This command will:
    - Read existing info.txt to extract package information
    - Prompt for any missing information
    - Generate a bee-package.json file
    
    Examples:
      beepm generate path/to/package --author Areng14
      beepm generate . --author PieCreeper12 --version 2.0.0
    """
    click.echo(click.style("\n Generate Package Metadata", fg="cyan", bold=True))
    click.echo()
    
    # Check if bee-package.json already exists
    output_file = package_dir / "bee-package.json"
    if output_file.exists() and not force:
        click.echo(click.style("[X] bee-package.json already exists!", fg="red", bold=True))
        click.echo(f"   Location: {output_file}")
        click.echo()
        click.echo("Use --force to overwrite it.")
        raise click.Abort()
    
    # Try to read info.txt
    click.echo(f"Reading package directory: {package_dir.name}")
    info_data = read_info_txt(package_dir)
    
    if info_data:
        click.echo(click.style("[OK] Found info.txt", fg="green"))
        if 'id' in info_data:
            click.echo(f"  ID: {info_data['id']}")
        if 'name' in info_data:
            click.echo(f"  Name: {info_data['name']}")
    else:
        click.echo(click.style("[!] info.txt not found or couldn't be parsed", fg="yellow"))
    
    click.echo()
    
    # Get package ID from info.txt or use provided value
    if not package_id:
        if info_data and 'id' in info_data:
            package_id = info_data['id']
        else:
            # Try to generate from directory name
            package_id = package_dir.name.upper().replace(' ', '_').replace('-', '_')
            # Remove any invalid characters
            package_id = re.sub(r'[^A-Z0-9_]', '', package_id)
    
    # Validate and fix ID
    if not validate_package_id(package_id):
        # Clean it up
        package_id = re.sub(r'[^A-Z0-9_]', '', package_id.upper())
        if not package_id:
            package_id = "PACKAGE_ID"
    
    click.echo(click.style(f"[OK] ID: {package_id}", fg="green"))
    
    # Get package name from info.txt or use provided value
    if not name:
        if info_data and 'name' in info_data:
            name = info_data['name']
        else:
            # Use directory name as fallback
            name = package_dir.name.replace('_', ' ').title()
    
    # Validate and fix name
    if not validate_package_name(name):
        # Remove invalid characters
        name = re.sub(r'[^A-Za-z0-9 ]', '', name)
        if not name:
            name = "Package Name"
    
    click.echo(click.style(f"[OK] Name: {name}", fg="green"))
    
    # Get author - only prompt if not provided
    if not author:
        author = click.prompt("Author (GitHub username)")
        
        # Validate author
        while not validate_author(author):
            click.echo(click.style("[X] Invalid author: Use only letters and numbers", fg="red"))
            author = click.prompt("Author")
    else:
        # Validate provided author
        if not validate_author(author):
            click.echo(click.style(f"[X] Invalid author '{author}': Use only letters and numbers", fg="red", bold=True))
            raise click.Abort()
    
    click.echo(click.style(f"[OK] Author: {author}", fg="green"))
    
    # Validate version
    if not validate_semver(version):
        click.echo(click.style(f"[!] Invalid version '{version}', using 1.0.0", fg="yellow"))
        version = "1.0.0"
    
    click.echo(click.style(f"[OK] Version: {version}", fg="green"))
    
    # Validate compatible version
    if not validate_bee2_version(compatible):
        click.echo(click.style(f"[!] Invalid version specifier '{compatible}', using >=2.4.41", fg="yellow"))
        compatible = ">=2.4.41"
    
    click.echo(click.style(f"[OK] Compatible: {compatible}", fg="green"))
    
    # Get dependencies from info.txt if available
    dependencies = {}
    if info_data and 'dependencies' in info_data:
        dependencies = info_data['dependencies']
        if dependencies:
            click.echo(click.style(f"[OK] Found {len(dependencies)} prerequisite(s) in info.txt", fg="green"))
            for dep_id in dependencies:
                click.echo(f"    * {dep_id}")
    
    # Create bee-package.json
    metadata = {
        "id": package_id,
        "name": name,
        "author": author,
        "version": version,
        "compatibleWith": compatible,
        "dependencies": dependencies
    }
    
    click.echo()
    click.echo("Generating bee-package.json...")
    
    try:
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(metadata, f, indent=2)
        
        click.echo(click.style("[OK] bee-package.json created!", fg="green", bold=True))
        click.echo(f"  Location: {output_file}")
        click.echo()
        
        # Show the generated content
        click.echo(click.style("Content:", fg="cyan"))
        click.echo(json.dumps(metadata, indent=2))
        click.echo()
        
        # Next steps
        click.echo(click.style("Next steps:", fg="cyan", bold=True))
        click.echo(f"  1. Review the generated bee-package.json")
        click.echo(f"  2. Add any dependencies if needed")
        click.echo(f"  3. Publish: beepm publish {package_dir}")
        click.echo()
        
    except Exception as e:
        click.echo(click.style(f"[X] Failed to create file: {e}", fg="red", bold=True))
        raise click.Abort()


if __name__ == "__main__":
    generate()

