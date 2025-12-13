"""Build BeePM as a standalone executable using PyInstaller"""

import PyInstaller.__main__
import sys

PyInstaller.__main__.run([
    'beepm/cli.py',
    '--name=beepm',
    '--onefile',
    '--console',
    '--icon=NONE',
    '--hidden-import=click',
    '--hidden-import=requests',
    '--hidden-import=boto3',
    '--hidden-import=openai',
    '--hidden-import=rich',
    '--hidden-import=semver',
    '--hidden-import=packaging',
    '--hidden-import=dotenv',
    '--hidden-import=srctools',
    '--collect-all=beepm',
])

