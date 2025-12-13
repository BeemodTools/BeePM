"""Main CLI entry point for BeePM"""

import click
from beepm.commands.init import init
from beepm.commands.uninit import uninit


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
cli.add_command(uninit)


if __name__ == "__main__":
    cli()

