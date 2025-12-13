"""Initialize BeePM configuration and packages"""

import os
import json
import configparser
import shutil
import zipfile
import tempfile
import sys
from pathlib import Path

import click
import requests
from srctools import Property


def get_appdata_path():
    """Get the Windows AppData Roaming path"""
    return Path(os.environ.get("APPDATA", ""))


def get_beepm_paths():
    """Get BeePM directory paths"""
    appdata = get_appdata_path()
    beepm_root = appdata / "beepm"
    
    return {
        "root": beepm_root,
        "packages": beepm_root / "packages",
        "config": beepm_root / "config",
        "config_file": beepm_root / "config" / "beepm_config.json"
    }


def fetch_bee2_versions():
    """Fetch available BEE2 versions from GitHub releases API"""
    click.echo(click.style("Fetching BEE2 versions from GitHub...", fg="cyan", bold=True))
    
    try:
        response = requests.get(
            "https://api.github.com/repos/BEEmod/BEE2.4/releases",
            timeout=10
        )
        response.raise_for_status()
        releases = response.json()
        
        # Filter to get version tags
        versions = []
        for release in releases:
            if not release.get("draft") and not release.get("prerelease"):
                versions.append({
                    "tag": release["tag_name"],
                    "name": release["name"],
                    "published_at": release["published_at"]
                })
        
        return versions
    except requests.RequestException as e:
        click.echo(click.style(f"[ERROR] Failed to fetch versions: {e}", fg="red", bold=True), err=True)
        return []


def select_bee2_version(versions):
    """Display versions and let user select one with arrow keys"""
    if not versions:
        click.echo(click.style("[ERROR] No versions available. Please check your internet connection.", fg="red", bold=True), err=True)
        return None
    
    # Display 10 items per page, but allow more versions total
    items_per_page = 10
    # Limit to 30 versions total (3 pages)
    versions = versions[:30]
    total_pages = (len(versions) + items_per_page - 1) // items_per_page
    current_page = 0
    current_selection = 0
    
    def get_page_versions():
        start_idx = current_page * items_per_page
        end_idx = min(start_idx + items_per_page, len(versions))
        return versions[start_idx:end_idx], start_idx
    
    def display_menu():
        # Clear screen (works on Windows and Unix)
        click.clear()
        
        click.echo()
        click.echo(click.style("Available BEE2 Versions", fg="yellow", bold=True))
        click.echo(click.style("=" * 70, fg="yellow"))
        click.echo()
        
        page_versions, start_idx = get_page_versions()
        
        for idx, version in enumerate(page_versions):
            absolute_idx = start_idx + idx
            version_name = version['name']
            version_tag = f"({version['tag']})"
            date = version['published_at'][:10]
            
            if absolute_idx == current_selection:
                # Highlighted selection
                line = f"  > {version_name} {version_tag} - {date}"
                click.echo(click.style(line, fg="black", bg="bright_cyan", bold=True))
            else:
                # Normal line
                version_name_colored = click.style(version_name, fg="green", bold=True)
                version_tag_colored = click.style(version_tag, fg="cyan")
                date_colored = click.style(date, fg="magenta")
                click.echo(f"    {version_name_colored} {version_tag_colored} - {date_colored}")
        
        click.echo()
        click.echo(click.style("=" * 70, fg="yellow"))
        
        if total_pages > 1:
            page_info = click.style(f"Page {current_page + 1}/{total_pages}", fg="cyan")
            click.echo(f"{page_info} | ", nl=False)
        
        click.echo(click.style("Use ", fg="white") + 
                   click.style("↑/↓", fg="bright_green", bold=True) + 
                   click.style(" to navigate", fg="white"), nl=False)
        
        if total_pages > 1:
            click.echo(click.style(", ", fg="white") + 
                      click.style("←/→", fg="bright_green", bold=True) + 
                      click.style(" for pages", fg="white"), nl=False)
        
        click.echo(click.style(", ", fg="white") + 
                   click.style("Enter", fg="bright_green", bold=True) + 
                   click.style(" to select, ", fg="white") + 
                   click.style("Esc", fg="bright_red", bold=True) + 
                   click.style(" to cancel", fg="white"))
    
    try:
        # Display initial menu
        display_menu()
        
        # Handle keyboard input
        while True:
            # Read a character
            if sys.platform == 'win32':
                import msvcrt
                if msvcrt.kbhit():
                    first_char = msvcrt.getch()
                    
                    # Handle Enter
                    if first_char == b'\r':
                        selected = versions[current_selection]
                        click.clear()
                        click.echo()
                        click.echo(click.style(f"Selected: {selected['name']} ({selected['tag']})", fg="green", bold=True))
                        return selected
                    
                    # Handle Escape
                    elif first_char == b'\x1b':
                        click.clear()
                        click.echo()
                        click.echo(click.style("[CANCELLED] Initialization cancelled.", fg="red", bold=True))
                        return None
                    
                    # Handle arrow keys (they send two bytes: 0xE0 or 0x00, then direction)
                    elif first_char in (b'\xe0', b'\x00'):
                        second_char = msvcrt.getch()
                        
                        # Up arrow
                        if second_char == b'H':
                            if current_selection > 0:
                                current_selection -= 1
                                # Check if we need to change page
                                if current_selection < current_page * items_per_page:
                                    current_page -= 1
                                display_menu()
                        
                        # Down arrow
                        elif second_char == b'P':
                            if current_selection < len(versions) - 1:
                                current_selection += 1
                                # Check if we need to change page
                                if current_selection >= (current_page + 1) * items_per_page:
                                    current_page += 1
                                display_menu()
                        
                        # Left arrow (previous page)
                        elif second_char == b'K':
                            if current_page > 0:
                                current_page -= 1
                                current_selection = current_page * items_per_page
                                display_menu()
                        
                        # Right arrow (next page)
                        elif second_char == b'M':
                            if current_page < total_pages - 1:
                                current_page += 1
                                current_selection = current_page * items_per_page
                                display_menu()
            else:
                # Unix/Linux arrow key handling
                import termios
                import tty
                
                fd = sys.stdin.fileno()
                old_settings = termios.tcgetattr(fd)
                try:
                    tty.setraw(fd)
                    ch = sys.stdin.read(1)
                    
                    if ch == '\r' or ch == '\n':
                        selected = versions[current_selection]
                        click.clear()
                        click.echo()
                        click.echo(click.style(f"Selected: {selected['name']} ({selected['tag']})", fg="green", bold=True))
                        return selected
                    elif ch == '\x1b':  # Escape sequence
                        next_chars = sys.stdin.read(2)
                        if next_chars == '[A':  # Up
                            if current_selection > 0:
                                current_selection -= 1
                                if current_selection < current_page * items_per_page:
                                    current_page -= 1
                                display_menu()
                        elif next_chars == '[B':  # Down
                            if current_selection < len(versions) - 1:
                                current_selection += 1
                                if current_selection >= (current_page + 1) * items_per_page:
                                    current_page += 1
                                display_menu()
                        elif next_chars == '[D':  # Left
                            if current_page > 0:
                                current_page -= 1
                                current_selection = current_page * items_per_page
                                display_menu()
                        elif next_chars == '[C':  # Right
                            if current_page < total_pages - 1:
                                current_page += 1
                                current_selection = current_page * items_per_page
                                display_menu()
                finally:
                    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
    
    except KeyboardInterrupt:
        click.clear()
        click.echo()
        click.echo(click.style("[CANCELLED] Initialization cancelled.", fg="red", bold=True))
        return None


def modify_bee2_config(packages_path):
    """Modify BEE2 config file to use BeePM packages directory"""
    appdata = get_appdata_path()
    config_path = appdata / "BEEMOD2" / "config" / "config.cfg"
    
    if not config_path.exists():
        click.echo()
        click.echo(click.style(f"[WARNING] BEE2 config file not found at {config_path}", fg="yellow", bold=True))
        click.echo(click.style("          Make sure BEE2 is installed and has been run at least once.", fg="yellow"))
        
        if not click.confirm(click.style("\n          Continue anyway?", fg="cyan"), default=True):
            return False
        
        # Create the config file with minimal content
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config = configparser.ConfigParser()
        config["Directories"] = {"package": str(packages_path)}
        
        with open(config_path, "w") as f:
            config.write(f)
        
        click.echo(click.style(f"          [OK] Created new config file", fg="green"))
        return True
    
    # Read and modify existing config
    config = configparser.ConfigParser()
    config.read(config_path)
    
    # Ensure Directories section exists
    if "Directories" not in config:
        config["Directories"] = {}
    
    # Backup original config (only if backup doesn't already exist)
    backup_path = config_path.with_suffix(".cfg.backup")
    if not backup_path.exists():
        shutil.copy2(config_path, backup_path)
        click.echo(click.style(f"          [OK] Backed up original config to {backup_path.name}", fg="bright_blue"))
    else:
        click.echo(click.style(f"          [INFO] Using existing backup (preserving original)", fg="cyan"))
    
    # Update package directory
    config["Directories"]["package"] = str(packages_path)
    
    # Write back to file
    with open(config_path, "w") as f:
        config.write(f)
    
    click.echo(click.style(f"          [OK] Updated BEE2 config to use BeePM packages", fg="green"))
    return True


def create_directory_structure(paths):
    """Create BeePM directory structure"""
    click.echo()
    click.echo(click.style("Creating BeePM directory structure...", fg="cyan", bold=True))
    
    for name, path in paths.items():
        if name != "config_file":  # Don't create the config file yet
            path.mkdir(parents=True, exist_ok=True)
            rel_path = str(path).replace(str(get_appdata_path()), "%appdata%")
            click.echo(click.style(f"          [OK] {rel_path}", fg="green"))
    
    return True


def create_package_metadata(packages_dir, bee2_version):
    """Create bee-package.json for all packages in the packages directory"""
    click.echo()
    click.echo(click.style("Creating package metadata files...", fg="cyan", bold=True))
    
    package_count = 0
    error_count = 0
    
    # Get all .bee_pack files
    bee_pack_files = [f for f in packages_dir.iterdir() if f.is_file() and f.name.endswith('.bee_pack')]
    
    if not bee_pack_files:
        click.echo(click.style("          [WARNING] No .bee_pack files found", fg="yellow"))
        return False
    
    click.echo(click.style(f"          Found {len(bee_pack_files)} package(s) to process", fg="cyan"))
    click.echo()
    
    # Process each .bee_pack file with progress bar
    with click.progressbar(
        bee_pack_files,
        label=click.style("          Processing packages", fg="bright_cyan"),
        bar_template="%(label)s  [%(bar)s] %(info)s",
        fill_char=click.style("#", fg="bright_green"),
        empty_char="-",
        show_pos=True
    ) as bar:
        for item in bar:
            temp_extract_dir = None
            try:
                # Create temporary directory for extraction
                temp_extract_dir = tempfile.mkdtemp()
                temp_extract_path = Path(temp_extract_dir)
                
                # Extract the .bee_pack (it's a zip file)
                with zipfile.ZipFile(item, 'r') as zip_ref:
                    zip_ref.extractall(temp_extract_path)
                
                # Find info.txt in the extracted contents
                info_txt = temp_extract_path / "info.txt"
                if not info_txt.exists():
                    # Sometimes it might be in a subdirectory
                    info_files = list(temp_extract_path.rglob("info.txt"))
                    if not info_files:
                        error_count += 1
                        continue
                    info_txt = info_files[0]
                    temp_extract_path = info_txt.parent
                
                # Parse the VDF file using srctools
                with open(info_txt, 'r', encoding='utf-8') as f:
                    props = Property.parse(f)
                
                # Extract package information
                package_id_prop = props.find_key('ID')
                package_id = package_id_prop.value if package_id_prop else item.stem.upper()
                
                package_name_prop = props.find_key('Name')
                package_name = package_name_prop.value if package_name_prop else item.stem
                
                # Extract prerequisites/dependencies
                dependencies = {}
                try:
                    prerequisites_prop = props.find_key('Prerequisites')
                    if prerequisites_prop:
                        # Find all "Package" entries under Prerequisites
                        for child in prerequisites_prop:
                            if child.name.lower() == 'package':
                                dep_package_id = child.value
                                # Convert to @beemod/id format with version constraint
                                dependencies[f"@beemod/{dep_package_id}"] = f">={bee2_version}"
                except (KeyError, LookupError):
                    # Prerequisites section doesn't exist, that's fine
                    pass
                
                # Create bee-package.json
                package_metadata = {
                    "id": package_id,
                    "name": package_name,
                    "author": "beemod",
                    "version": bee2_version,
                    "compatibleWith": f">={bee2_version}",
                    "dependencies": dependencies
                }
                
                # Write bee-package.json to the extracted directory
                package_json_path = temp_extract_path / "bee-package.json"
                with open(package_json_path, 'w', encoding='utf-8') as f:
                    json.dump(package_metadata, f, indent=2)
                
                # Repack everything into a new .bee_pack
                temp_zip_path = temp_extract_path.parent / f"{item.stem}_new.bee_pack"
                with zipfile.ZipFile(temp_zip_path, 'w', zipfile.ZIP_DEFLATED) as zip_ref:
                    for file_path in temp_extract_path.rglob('*'):
                        if file_path.is_file():
                            arcname = file_path.relative_to(temp_extract_path)
                            zip_ref.write(file_path, arcname)
                
                # Replace the original .bee_pack with the new one
                item.unlink()
                shutil.move(str(temp_zip_path), str(item))
                
                package_count += 1
                
            except zipfile.BadZipFile:
                error_count += 1
                continue
            except Exception as e:
                error_count += 1
                continue
            finally:
                # Clean up temporary directory
                if temp_extract_dir and os.path.exists(temp_extract_dir):
                    shutil.rmtree(temp_extract_dir)
    
    click.echo()
    if package_count > 0:
        click.echo(click.style(f"          [OK] Created metadata for {package_count} package(s)", fg="green", bold=True))
    
    if error_count > 0:
        click.echo(click.style(f"          [WARNING] Failed to process {error_count} package(s)", fg="yellow"))
    
    return package_count > 0


def download_base_packages(packages_dir, selected_version):
    """Download and extract base packages from the BEE2-items release"""
    click.echo()
    
    try:
        # Convert BEE2.4 version tag to BEE2-items version tag
        # BEE2.4 uses tags like "2.4.46.1" and BEE2-items uses "4.46.0"
        bee2_tag = selected_version['tag']
        
        # Extract the version number (e.g., "2.4.46.1" -> "46")
        # Handle different formats: "2.4.46.1", "v2.4.46.1", etc.
        version_parts = bee2_tag.replace('v', '').replace('V', '').split('.')
        
        if len(version_parts) >= 3:
            # Try to construct BEE2-items version (4.XX.0 format)
            major_version = version_parts[-2]  # The "46" part from "2.4.46.1"
            items_version_tag = f"4.{major_version}.0"
        else:
            # Fallback: use the tag as-is
            items_version_tag = bee2_tag
        
        # Try with 'v' prefix first
        if not items_version_tag.startswith('v'):
            items_version_tag = 'v' + items_version_tag
        
        click.echo(click.style(f"Looking for BEE2-items version {items_version_tag}...", fg="cyan", bold=True))
        
        release_url = f"https://api.github.com/repos/BEEmod/BEE2-items/releases/tags/{items_version_tag}"
        response = requests.get(release_url, timeout=10)
        
        # If not found with v prefix, try without
        if response.status_code == 404:
            items_version_tag = items_version_tag.replace('v', '')
            release_url = f"https://api.github.com/repos/BEEmod/BEE2-items/releases/tags/{items_version_tag}"
            response = requests.get(release_url, timeout=10)
        
        response.raise_for_status()
        release_data = response.json()
        
        click.echo(click.style(f"Found release: {release_data.get('name', items_version_tag)}", fg="green"))
        
        # Get all zip assets
        assets = release_data.get("assets", [])
        zip_assets = [asset for asset in assets if asset["name"].lower().endswith(".zip")]
        
        if not zip_assets:
            click.echo(click.style("          [ERROR] No zip files found in this release", fg="red", bold=True), err=True)
            return False
        
        click.echo(click.style(f"          Found {len(zip_assets)} package file(s) to download", fg="cyan"))
        
        # Download and extract each zip file
        for idx, asset in enumerate(zip_assets, 1):
            asset_name = asset["name"]
            asset_url = asset["browser_download_url"]
            asset_size = asset["size"]
            
            click.echo()
            click.echo(click.style(f"          [{idx}/{len(zip_assets)}] {asset_name}", fg="bright_cyan", bold=True))
            
            # Download the asset
            response = requests.get(asset_url, timeout=60, stream=True)
            response.raise_for_status()
            
            # Save to temporary file
            with tempfile.NamedTemporaryFile(delete=False, suffix=".zip") as tmp_file:
                if asset_size > 0:
                    with click.progressbar(
                        length=asset_size,
                        label=click.style("                Downloading", fg="bright_cyan"),
                        bar_template="%(label)s  [%(bar)s] %(info)s",
                        fill_char=click.style("#", fg="bright_green"),
                        empty_char="-"
                    ) as bar:
                        for chunk in response.iter_content(chunk_size=8192):
                            tmp_file.write(chunk)
                            bar.update(len(chunk))
                else:
                    click.echo(click.style("                Downloading...", fg="bright_cyan"))
                    for chunk in response.iter_content(chunk_size=8192):
                        tmp_file.write(chunk)
                
                tmp_path = tmp_file.name
            
            # Extract the zip file
            click.echo(click.style("                Extracting...", fg="bright_yellow"))
            with zipfile.ZipFile(tmp_path, "r") as zip_ref:
                # Extract to packages directory
                zip_ref.extractall(packages_dir)
            
            # Clean up temporary file
            os.unlink(tmp_path)
            click.echo(click.style("                [OK] Extracted successfully", fg="green"))
        
        click.echo()
        click.echo(click.style("          [OK] All packages installed successfully!", fg="green", bold=True))
        return True
        
    except requests.RequestException as e:
        click.echo(click.style(f"          [ERROR] Failed to download packages: {e}", fg="red", bold=True), err=True)
        return False
    except zipfile.BadZipFile:
        click.echo(click.style("          [ERROR] Downloaded file is not a valid zip archive", fg="red", bold=True), err=True)
        return False
    except Exception as e:
        click.echo(click.style(f"          [ERROR] Failed to extract packages: {e}", fg="red", bold=True), err=True)
        return False


def create_beepm_config(config_file, bee2_version, packages_path):
    """Create beepm_config.json with configuration"""
    # Extract clean version number (remove 'v' prefix and limit to 3 parts)
    version_tag = bee2_version["tag"].replace('v', '').replace('V', '')
    version_parts = version_tag.split('.')
    if len(version_parts) > 3:
        clean_version = '.'.join(version_parts[:3])
    else:
        clean_version = version_tag
    
    config = {
        "bee2_version": bee2_version["tag"],
        "bee2_version_name": bee2_version["name"],
        "beemod_version": clean_version,  # This is what install command looks for
        "package_directory": str(packages_path),
        "installed_packages": []
    }
    
    with open(config_file, "w") as f:
        json.dump(config, f, indent=2)
    
    click.echo()
    click.echo(click.style("Created BeePM configuration file", fg="green", bold=True))
    return True


@click.command()
def init():
    """Initialize BeePM configuration and install base packages"""
    # Header
    click.echo()
    width = 68
    click.echo(click.style("+" + "=" * width + "+", fg="bright_yellow"))
    
    # Title line
    title = "BeePM Initialization"
    title_padding = (width - len(title)) // 2
    title_line = " " * title_padding + title + " " * (width - title_padding - len(title))
    click.echo(click.style("|" + title_line + "|", fg="bright_yellow", bold=True))
    
    # Subtitle line
    subtitle = "BEE2 Package Manager Setup"
    subtitle_padding = (width - len(subtitle)) // 2
    subtitle_line = " " * subtitle_padding + subtitle + " " * (width - subtitle_padding - len(subtitle))
    click.echo(click.style("|", fg="bright_yellow") + 
               click.style(subtitle_line, fg="cyan") + 
               click.style("|", fg="bright_yellow"))
    
    click.echo(click.style("+" + "=" * width + "+", fg="bright_yellow"))
    
    # Get paths
    paths = get_beepm_paths()
    
    # Check if already initialized
    if paths["config_file"].exists():
        click.echo()
        click.echo(click.style("[WARNING] BeePM is already initialized!", fg="yellow", bold=True))
        
        if not click.confirm(click.style("          Do you want to reinitialize? This will overwrite existing configuration.", fg="yellow"), default=False):
            click.echo()
            click.echo(click.style("[CANCELLED] Initialization cancelled.", fg="red", bold=True))
            return
    
    # Step 1: Fetch and select BEE2 version
    click.echo()
    click.echo(click.style("-" * 70, fg="bright_blue"))
    click.echo(click.style("  Step 1/6: Select BEE2 Version", fg="bright_blue", bold=True))
    click.echo(click.style("-" * 70, fg="bright_blue"))
    
    versions = fetch_bee2_versions()
    selected_version = select_bee2_version(versions)
    
    if not selected_version:
        return
    
    # Step 2: Create directory structure
    click.echo()
    click.echo(click.style("-" * 70, fg="bright_blue"))
    click.echo(click.style("  Step 2/6: Create Directory Structure", fg="bright_blue", bold=True))
    click.echo(click.style("-" * 70, fg="bright_blue"))
    
    if not create_directory_structure(paths):
        click.echo()
        click.echo(click.style("[ERROR] Failed to create directory structure", fg="red", bold=True), err=True)
        return
    
    # Step 3: Modify BEE2 config
    click.echo()
    click.echo(click.style("-" * 70, fg="bright_blue"))
    click.echo(click.style("  Step 3/6: Modify BEE2 Configuration", fg="bright_blue", bold=True))
    click.echo(click.style("-" * 70, fg="bright_blue"))
    
    if not modify_bee2_config(paths["packages"]):
        click.echo()
        click.echo(click.style("[ERROR] Failed to modify BEE2 configuration", fg="red", bold=True), err=True)
        return
    
    # Step 4: Download base packages
    click.echo()
    click.echo(click.style("-" * 70, fg="bright_blue"))
    click.echo(click.style("  Step 4/6: Download Base Packages", fg="bright_blue", bold=True))
    click.echo(click.style("-" * 70, fg="bright_blue"))
    
    if not download_base_packages(paths["packages"], selected_version):
        click.echo()
        click.echo(click.style("[ERROR] Failed to download base packages", fg="red", bold=True), err=True)
        return
    
    # Step 5: Create package metadata
    click.echo()
    click.echo(click.style("-" * 70, fg="bright_blue"))
    click.echo(click.style("  Step 5/6: Generate Package Metadata", fg="bright_blue", bold=True))
    click.echo(click.style("-" * 70, fg="bright_blue"))
    
    # Extract version for metadata (e.g., "2.4.46.1" -> "2.4.46")
    bee2_version = selected_version['tag'].replace('v', '').replace('V', '')
    # Remove the last part if it's a patch version (e.g., "2.4.46.1" -> "2.4.46")
    version_parts = bee2_version.split('.')
    if len(version_parts) > 3:
        bee2_version = '.'.join(version_parts[:3])
    
    if not create_package_metadata(paths["packages"], bee2_version):
        click.echo()
        click.echo(click.style("[WARNING] Package metadata generation had issues", fg="yellow"))
        # Don't fail, just warn
    
    # Step 6: Create BeePM config
    click.echo()
    click.echo(click.style("-" * 70, fg="bright_blue"))
    click.echo(click.style("  Step 6/6: Create BeePM Configuration", fg="bright_blue", bold=True))
    click.echo(click.style("-" * 70, fg="bright_blue"))
    
    if not create_beepm_config(paths["config_file"], selected_version, paths["packages"]):
        click.echo()
        click.echo(click.style("[ERROR] Failed to create BeePM configuration", fg="red", bold=True), err=True)
        return
    
    # Success!
    click.echo()
    width = 68
    click.echo(click.style("+" + "=" * width + "+", fg="bright_green"))
    
    # Success title
    success_title = "SUCCESS!"
    success_padding = (width - len(success_title)) // 2
    success_line = " " * success_padding + success_title + " " * (width - success_padding - len(success_title))
    click.echo(click.style("|" + success_line + "|", fg="bright_green", bold=True))
    
    # Success message
    success_msg = "BeePM initialization completed successfully!"
    msg_padding = (width - len(success_msg)) // 2
    msg_line = " " * msg_padding + success_msg + " " * (width - msg_padding - len(success_msg))
    click.echo(click.style("|", fg="bright_green") + 
               click.style(msg_line, fg="green") + 
               click.style("|", fg="bright_green"))
    
    click.echo(click.style("+" + "=" * width + "+", fg="bright_green"))
    
    click.echo()
    click.echo(click.style("Installation Details:", fg="cyan", bold=True))
    rel_packages = str(paths['packages']).replace(str(get_appdata_path()), "%appdata%")
    rel_config = str(paths['config']).replace(str(get_appdata_path()), "%appdata%")
    click.echo(click.style(f"  Packages: ", fg="bright_blue") + click.style(rel_packages, fg="white"))
    click.echo(click.style(f"  Config:   ", fg="bright_blue") + click.style(rel_config, fg="white"))
    
    click.echo()
    click.echo(click.style("BEE2 has been configured to use BeePM packages!", fg="bright_magenta", bold=True))
    click.echo(click.style("You can now use BeePM to manage your BEE2 packages!", fg="magenta"))
    click.echo()
