"""Uninstall BeePM configuration and packages"""

import os
import shutil
from pathlib import Path

import click

from beepm.commands.init import get_appdata_path, get_beepm_paths


@click.command()
@click.option('--keep-packages', is_flag=True, help='Keep the packages directory')
def unhook(keep_packages):
    """Unhook BeePM from BEE2 and restore original configuration"""
    
    # Header
    click.echo()
    width = 68
    click.echo(click.style("+" + "=" * width + "+", fg="bright_red"))
    
    # Title line
    title = "BeePM Uninstallation"
    title_padding = (width - len(title)) // 2
    title_line = " " * title_padding + title + " " * (width - title_padding - len(title))
    click.echo(click.style("|" + title_line + "|", fg="bright_red", bold=True))
    
    # Subtitle line
    subtitle = "Remove BeePM and restore BEE2"
    subtitle_padding = (width - len(subtitle)) // 2
    subtitle_line = " " * subtitle_padding + subtitle + " " * (width - subtitle_padding - len(subtitle))
    click.echo(click.style("|", fg="bright_red") + 
               click.style(subtitle_line, fg="yellow") + 
               click.style("|", fg="bright_red"))
    
    click.echo(click.style("+" + "=" * width + "+", fg="bright_red"))
    
    # Get paths
    paths = get_beepm_paths()
    appdata = get_appdata_path()
    
    # Check if BeePM is installed
    if not paths["config_file"].exists():
        click.echo()
        click.echo(click.style("[INFO] BeePM is not currently installed.", fg="cyan", bold=True))
        click.echo(click.style("       Nothing to uninstall.", fg="cyan"))
        click.echo()
        return
    
    # Show what will be removed
    click.echo()
    click.echo(click.style("The following will be removed:", fg="yellow", bold=True))
    
    if paths["root"].exists():
        rel_root = str(paths["root"]).replace(str(appdata), "%appdata%")
        click.echo(click.style(f"  - BeePM directory: {rel_root}", fg="white"))
        
        if paths["packages"].exists():
            try:
                # Count packages
                package_count = sum(1 for item in paths["packages"].iterdir() if item.is_dir())
                if keep_packages:
                    click.echo(click.style(f"    (Packages will be kept: {package_count} packages)", fg="cyan"))
                else:
                    click.echo(click.style(f"    (Including {package_count} packages)", fg="white"))
            except:
                pass
    
    # Check for backup
    bee2_config = appdata / "BEEMOD2" / "config" / "config.cfg"
    backup_path = bee2_config.with_suffix(".cfg.backup")
    
    if backup_path.exists():
        click.echo(click.style(f"  - BEE2 config will be restored from backup", fg="white"))
    else:
        click.echo(click.style(f"  - BEE2 config will be updated (no backup found)", fg="yellow"))
    
    click.echo()
    
    # Confirmation
    if not click.confirm(click.style("Are you sure you want to uninstall BeePM?", fg="bright_red", bold=True), default=False):
        click.echo()
        click.echo(click.style("[CANCELLED] Uninstallation cancelled.", fg="cyan", bold=True))
        click.echo()
        return
    
    click.echo()
    click.echo(click.style("Uninstalling BeePM...", fg="yellow", bold=True))
    
    # Step 1: Restore BEE2 config
    click.echo()
    click.echo(click.style("Step 1/2: Restoring BEE2 Configuration", fg="bright_blue", bold=True))
    
    if backup_path.exists():
        try:
            shutil.copy2(backup_path, bee2_config)
            click.echo(click.style("          [OK] BEE2 config restored from backup", fg="green"))
            
            # Remove backup file
            backup_path.unlink()
            click.echo(click.style("          [OK] Backup file removed", fg="green"))
        except Exception as e:
            click.echo(click.style(f"          [WARNING] Failed to restore backup: {e}", fg="yellow"))
    else:
        # Try to reset the package path in config
        try:
            import configparser
            if bee2_config.exists():
                config = configparser.ConfigParser()
                config.read(bee2_config)
                
                if "Directories" in config and "package" in config["Directories"]:
                    # Reset to default (empty or packages folder)
                    default_packages = appdata / "BEEMOD2" / "packages"
                    config["Directories"]["package"] = str(default_packages)
                    
                    with open(bee2_config, "w") as f:
                        config.write(f)
                    
                    click.echo(click.style("          [OK] BEE2 config updated to use default packages", fg="green"))
                else:
                    click.echo(click.style("          [INFO] BEE2 config doesn't need updating", fg="cyan"))
            else:
                click.echo(click.style("          [INFO] BEE2 config file not found", fg="cyan"))
        except Exception as e:
            click.echo(click.style(f"          [WARNING] Failed to update config: {e}", fg="yellow"))
    
    # Step 2: Remove BeePM directory
    click.echo()
    click.echo(click.style("Step 2/2: Removing BeePM Files", fg="bright_blue", bold=True))
    
    removed_items = []
    
    if paths["root"].exists():
        try:
            if keep_packages and paths["packages"].exists():
                # Remove everything except packages
                for item in paths["root"].iterdir():
                    if item != paths["packages"]:
                        if item.is_dir():
                            shutil.rmtree(item)
                        else:
                            item.unlink()
                        removed_items.append(item.name)
                
                click.echo(click.style(f"          [OK] Removed BeePM files (kept packages)", fg="green"))
            else:
                # Remove entire directory
                shutil.rmtree(paths["root"])
                removed_items.append("All BeePM files")
                click.echo(click.style(f"          [OK] Removed BeePM directory", fg="green"))
        except Exception as e:
            click.echo(click.style(f"          [ERROR] Failed to remove files: {e}", fg="red", bold=True))
            click.echo()
            return
    else:
        click.echo(click.style("          [INFO] BeePM directory not found", fg="cyan"))
    
    # Success!
    click.echo()
    width = 68
    click.echo(click.style("+" + "=" * width + "+", fg="bright_green"))
    
    # Success title
    success_title = "UNINSTALLED!"
    success_padding = (width - len(success_title)) // 2
    success_line = " " * success_padding + success_title + " " * (width - success_padding - len(success_title))
    click.echo(click.style("|" + success_line + "|", fg="bright_green", bold=True))
    
    # Success message
    success_msg = "BeePM has been removed successfully"
    msg_padding = (width - len(success_msg)) // 2
    msg_line = " " * msg_padding + success_msg + " " * (width - msg_padding - len(success_msg))
    click.echo(click.style("|", fg="bright_green") + 
               click.style(msg_line, fg="green") + 
               click.style("|", fg="bright_green"))
    
    click.echo(click.style("+" + "=" * width + "+", fg="bright_green"))
    
    click.echo()
    click.echo(click.style("BEE2 has been restored to its original configuration.", fg="bright_magenta", bold=True))
    
    if keep_packages:
        click.echo(click.style(f"Your packages have been kept at: {paths['packages']}", fg="magenta"))
    
    click.echo()

