# BeePM Distribution Tools

This folder contains all the tools needed to build and distribute BeePM.

## Quick Start

### Build the Installer (Windows)

1. **Install NSIS:**
   - Download: https://nsis.sourceforge.io/Download
   - Install with default settings

2. **Run the build script:**
   ```bash
   cd dist_tools
   .\build_installer.bat
   ```

3. **Find the installer:**
   - Output: `dist\BeePM-Setup.exe`
   - Ready to distribute!

## Files

- `installer.nsi` - NSIS installer script
- `EnvVarUpdate.nsh` - Helper for PATH manipulation
- `build_installer.bat` - Automated build script
- `build_exe.py` - PyInstaller build configuration

## What the Installer Does

✅ Installs BeePM to `C:\Program Files\BeePM\`  
✅ Automatically adds to system PATH  
✅ Creates Start Menu shortcuts  
✅ Registers in Add/Remove Programs  
✅ Includes uninstaller

## Manual Build

```bash
# Step 1: Build executable
cd ..
pyinstaller --onefile --name=beepm --console beepm/cli.py

# Step 2: Build installer
cd dist_tools
makensis installer.nsi
```

## Distribution

Upload `dist\BeePM-Setup.exe` to GitHub Releases:
```
https://github.com/yourusername/beepm/releases
```

Users download and run - BeePM is instantly available in their terminal!

