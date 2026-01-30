"""Hook BeePM to BEE2"""

import os
import json
import configparser
import shutil
from pathlib import Path

import click

from beepm.commands.init import get_appdata_path, get_beepm_paths


@click.command()
@click.option('-y', '--yes', is_flag=True, help='Skip confirmation prompts')
@click.option('--json', 'json_output', is_flag=True, help='Output result as JSON')
def hook(yes, json_output):
    """Hook BeePM to BEE2 (makes BEE2 use BeePM packages)

    Examples:
      beepm hook
      beepm hook -y
    """
    paths = get_beepm_paths()
    appdata = get_appdata_path()
    bee2_config = appdata / "BEEMOD2" / "config" / "config.cfg"

    # JSON output mode
    if json_output:
        result = do_hook(paths, appdata, bee2_config, auto_confirm=True)
        print(json.dumps(result))
        return

    # Check if BeePM is initialized
    if not paths["config_file"].exists():
        click.echo()
        click.echo(click.style("[X] BeePM is not initialized!", fg="red", bold=True))
        click.echo()
        click.echo("Run 'beepm init' first to set up BeePM.")
        click.echo()
        return

    # Check if already hooked
    is_hooked = False
    if bee2_config.exists():
        config = configparser.ConfigParser()
        config.read(bee2_config)

        if "Directories" in config and "package" in config["Directories"]:
            current_pkg_dir = Path(config["Directories"]["package"])
            is_hooked = current_pkg_dir == paths["packages"]

    if is_hooked:
        click.echo()
        click.echo(click.style("[OK] BeePM is already hooked to BEE2", fg="green", bold=True))
        click.echo(f"  Package directory: {paths['packages']}")
        click.echo()
        return

    # Confirmation
    if not yes:
        click.echo()
        click.echo(click.style("This will hook BeePM to BEE2:", fg="cyan", bold=True))
        click.echo(f"  * BEE2 will use packages from: {paths['packages']}")
        click.echo()

        if not click.confirm("Continue?", default=True):
            click.echo(click.style("[CANCELLED]", fg="yellow"))
            return

    # Do the hook
    result = do_hook(paths, appdata, bee2_config, auto_confirm=True)

    if result["success"]:
        click.echo()
        click.echo(click.style("[OK] " + result["message"], fg="green", bold=True))
        click.echo()
    else:
        click.echo()
        click.echo(click.style("[X] " + result["message"], fg="red", bold=True))
        click.echo()


def do_hook(paths, appdata, bee2_config, auto_confirm=False):
    """Perform the actual hook operation"""
    result = {
        "success": False,
        "message": "",
        "action": "hook"
    }

    # Check if BeePM is initialized
    if not paths["config_file"].exists():
        result["message"] = "BeePM is not initialized. Run 'beepm init' first."
        return result

    # Check if BEE2 config exists
    if not bee2_config.exists():
        result["message"] = "BEE2 config file not found. Is BEE2 installed and run at least once?"
        return result

    try:
        config = configparser.ConfigParser()
        config.read(bee2_config)

        if "Directories" not in config:
            config["Directories"] = {}

        # Backup original config (only if backup doesn't exist)
        backup_path = bee2_config.with_suffix(".cfg.backup")
        if not backup_path.exists():
            shutil.copy2(bee2_config, backup_path)

        # Update package directory
        config["Directories"]["package"] = str(paths["packages"])

        with open(bee2_config, "w") as f:
            config.write(f)

        result["success"] = True
        result["message"] = "BeePM hooked to BEE2 successfully"

    except Exception as e:
        result["success"] = False
        result["message"] = f"Failed to hook: {e}"

    return result
