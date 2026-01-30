"""Uninstall BeePM configuration and packages"""

import os
import json
import shutil
from pathlib import Path

import click

from beepm.commands.init import get_appdata_path, get_beepm_paths


@click.command()
@click.option('-y', '--yes', is_flag=True, help='Skip confirmation prompts')
@click.option('--json', 'json_output', is_flag=True, help='Output result as JSON')
def unhook(yes, json_output):
    """Unhook BeePM from BEE2 (restores original package directory)

    Examples:
      beepm unhook
      beepm unhook -y
    """
    paths = get_beepm_paths()
    appdata = get_appdata_path()
    bee2_config = appdata / "BEEMOD2" / "config" / "config.cfg"

    # JSON output mode
    if json_output:
        result = do_unhook(paths, appdata, bee2_config)
        print(json.dumps(result))
        return

    # Check if BeePM is installed
    if not paths["config_file"].exists():
        click.echo()
        click.echo(click.style("[INFO] BeePM is not currently hooked.", fg="cyan", bold=True))
        click.echo()
        return

    # Check if actually hooked
    import configparser as cp
    is_hooked = False
    if bee2_config.exists():
        config = cp.ConfigParser()
        config.read(bee2_config)
        if "Directories" in config and "package" in config["Directories"]:
            current_pkg_dir = Path(config["Directories"]["package"])
            is_hooked = current_pkg_dir == paths["packages"]

    if not is_hooked:
        click.echo()
        click.echo(click.style("[INFO] BeePM is not currently hooked to BEE2.", fg="cyan", bold=True))
        click.echo()
        return

    # Confirmation
    if not yes:
        click.echo()
        click.echo(click.style("This will unhook BeePM from BEE2:", fg="cyan", bold=True))
        click.echo("  * BEE2 will use its original package directory")
        click.echo()
        click.echo(click.style("Note: BeePM files will be preserved", fg="green"))
        click.echo()

        if not click.confirm("Continue?", default=True):
            click.echo(click.style("[CANCELLED]", fg="yellow"))
            return

    # Do the unhook
    result = do_unhook(paths, appdata, bee2_config)

    if result["success"]:
        click.echo()
        click.echo(click.style("[OK] " + result["message"], fg="green", bold=True))
        click.echo()
        click.echo("To re-hook, run: beepm hook")
        click.echo()
    else:
        click.echo()
        click.echo(click.style("[X] " + result["message"], fg="red", bold=True))
        click.echo()


def do_unhook(paths, appdata, bee2_config):
    """Perform the actual unhook operation"""
    result = {
        "success": False,
        "message": "",
        "action": "unhook"
    }

    backup_path = bee2_config.with_suffix(".cfg.backup")

    if backup_path.exists():
        try:
            shutil.copy2(backup_path, bee2_config)
            result["success"] = True
            result["message"] = "BEE2 config restored from backup"
        except Exception as e:
            result["success"] = False
            result["message"] = f"Failed to restore backup: {e}"
    else:
        try:
            import configparser
            if bee2_config.exists():
                config = configparser.ConfigParser()
                config.read(bee2_config)

                if "Directories" in config and "package" in config["Directories"]:
                    default_packages = appdata / "BEEMOD2" / "packages"
                    config["Directories"]["package"] = str(default_packages)

                    with open(bee2_config, "w") as f:
                        config.write(f)

                    result["success"] = True
                    result["message"] = "BEE2 config reset to default packages"
                else:
                    result["success"] = True
                    result["message"] = "BEE2 config doesn't need updating"
            else:
                result["success"] = False
                result["message"] = "BEE2 config file not found"
        except Exception as e:
            result["success"] = False
            result["message"] = f"Failed to update config: {e}"

    return result

