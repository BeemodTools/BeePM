"""Main CLI entry point for BeePM"""

import click
from beepm.commands.init import init
from beepm.commands.uninit import unhook
from beepm.commands.login import login
from beepm.commands.publish import publish
from beepm.commands.install import install
from beepm.commands.uninstall import uninstall
from beepm.commands.update import update
from beepm.commands.nuke import nuke
from beepm.commands.yank import yank
from beepm.commands.list import list_packages
from beepm.commands.info import info
from beepm.commands.search import search


@click.group()
@click.version_option()
def cli():
    """BeePM - BEE2 Package Manager
    
    A command-line tool for managing BEE2 packages.
    
    Use 'beepm init' to get started!
    """
    pass


# Register commands
cli.add_command(init)
cli.add_command(unhook)
cli.add_command(login)
cli.add_command(publish)
cli.add_command(install)
cli.add_command(uninstall)
cli.add_command(update)
cli.add_command(nuke)
cli.add_command(yank)
cli.add_command(list_packages)
cli.add_command(info)
cli.add_command(search)


if __name__ == "__main__":
    cli()

