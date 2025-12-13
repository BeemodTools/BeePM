# Beemod Package Manager (BeePM)
Beemod Package Manager is a package manager for BeeMOD.

## Setup
Run the installer, and open up a instance of your prefered terminal (Powershell, Command Prompt, etc).
Run the command `beepm init` to install Beemod Package Manager

## Installing a package
First, list all the packages BeePM has. To do this use `beepm list`

This is a example output
┏━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━┳━━━━━━━━━━━━━━━━┳━━━━━━━━━━┓
┃ Package                ┃ Author  ┃ Latest Version ┃ Versions ┃
┡━━━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━╇━━━━━━━━━━━━━━━━╇━━━━━━━━━━┩
│ ArengsPackages         │ Areng14 │ 1.0.0          │ 1        │
│ Areng14@arengspackages │         │                │          │
└────────────────────────┴─────────┴────────────────┴──────────┘

To install ArengsPackages, use the command `beepm install Areng14@arengspackages` OR `beepm install arengspackages`

## Uninstalling a package
First, list all the packages BeePM has installed. To do this use `beepm list --installed`

This is a example output
┏━━━━━━━━━━━━━━━━━┳━━━━━━━━━┳━━━━━━━━━┳━━━━━━━━━━┓
┃ Package         ┃ Author  ┃ Version ┃ Type     ┃
┡━━━━━━━━━━━━━━━━━╇━━━━━━━━━╇━━━━━━━━━╇━━━━━━━━━━┩
│ ArengsPackages  │ Areng14 │ 1.0.0   │ Explicit │
│ ARENGS_PACKAGES │         │         │          │
└─────────────────┴─────────┴─────────┴──────────┘

To install ArengsPackages, use the command `beepm uninstall Areng14@arengspackages` OR `beepm uninstall arengspackages`

## Unhooking 
To unhook beepm from beemod, use the command `beepm unhook` to unhook BeePM from BEEmod.

## List of commands
beepm init               # Setup BeePM
beepm unhook             # Unhook from BEE2 (was: uninit)
beepm login              # GitHub OAuth
beepm publish <file>     # Publish package
beepm install <pkg>      # Install package
beepm uninstall <pkg>    # Uninstall package
beepm update --all       # Update packages
beepm list               # List packages
beepm info <pkg>         # Package details
beepm search <query>     # Search packages