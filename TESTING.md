# 🧪 Testing BeePM

This guide will help you test the BeePM CLI tool.

## 📋 Prerequisites

Before testing, make sure you have:
- Python 3.7 or higher installed
- pip (Python package manager)
- Windows OS (BeePM uses `%appdata%` directories)

## 🚀 Installation & Testing Steps

### 1. Install BeePM in Development Mode

Open PowerShell or Command Prompt in the project directory and run:

```bash
pip install -e .
```

This installs BeePM in "editable" mode, so any changes you make to the code will be immediately reflected.

### 2. Verify Installation

Check that BeePM is installed correctly:

```bash
beepm --version
```

You should see the version number.

### 3. View Help

See all available commands:

```bash
beepm --help
```

View help for the init command:

```bash
beepm init --help
```

### 4. Test the Init Command

Run the initialization:

```bash
beepm init
```

This will:
- Show a beautiful colored header
- Fetch BEE2 versions from GitHub
- Let you select a version
- Create directories in `%appdata%/beepm/`
- Modify BEE2 config (or create one if missing)
- Download base packages
- Show success message

### 5. Verify the Results

Check that everything was created:

#### Check BeePM directories:
```bash
dir %appdata%\beepm
```

You should see:
- `packages\` folder
- `config\` folder

#### Check config file:
```bash
type %appdata%\beepm\config\beepm_config.json
```

Should show your configuration with BEE2 version and package directory.

#### Check BEE2 config:
```bash
type %appdata%\BEEMOD2\config\config.cfg
```

Look for the line:
```
package = C:\Users\...\AppData\Roaming\beepm\packages
```

#### Check backup:
```bash
type %appdata%\BEEMOD2\config\config.cfg.backup
```

Should show your original config.

#### Check packages:
```bash
dir %appdata%\beepm\packages
```

Should contain the BEE2-items repository contents.

### 6. Test Reinitialization

Run init again to test the "already initialized" flow:

```bash
beepm init
```

It should warn you that BeePM is already initialized and ask if you want to continue.

### 7. Test Uninstallation

Test the uninit command:

```bash
beepm uninit
```

This should:
- Show what will be removed
- Ask for confirmation
- Restore BEE2 config from backup
- Remove BeePM directory

To keep packages while uninstalling:

```bash
beepm uninit --keep-packages
```

## 🐛 Testing Without BEE2 Installed

If you don't have BEE2 installed, BeePM will:
1. Warn you that the config file doesn't exist
2. Ask if you want to continue
3. Create a new config file for you

This is expected behavior and you can test it!

## 🧹 Clean Up (Reset for Testing)

To reset and test from scratch:

```bash
# Remove BeePM directories
rmdir /s %appdata%\beepm

# Restore BEE2 config from backup (if you have one)
copy %appdata%\BEEMOD2\config\config.cfg.backup %appdata%\BEEMOD2\config\config.cfg
```

## 🔍 Troubleshooting

### "beepm: command not found"
- Make sure you ran `pip install -e .` successfully
- Try closing and reopening your terminal
- Check if Python Scripts folder is in your PATH

### Network errors
- Check your internet connection
- GitHub API might be rate-limited (wait a few minutes)

### Permission errors
- Run your terminal as Administrator
- Check that `%appdata%` is writable

## 🎯 What to Test

### Init Command
- ✅ Version fetching from GitHub
- ✅ Arrow key navigation (up/down/left/right)
- ✅ Pagination (if more than 10 versions)
- ✅ Directory creation
- ✅ Config file modification
- ✅ Package downloading with progress bar (both zips)
- ✅ JSON config creation
- ✅ Colorful output rendering
- ✅ Error handling (try disconnecting internet, etc.)
- ✅ Reinitialization flow
- ✅ Cancellation (press Esc or Ctrl+C)

### Uninit Command
- ✅ Shows what will be removed
- ✅ Confirmation prompt
- ✅ Restores BEE2 config from backup
- ✅ Removes BeePM directory
- ✅ --keep-packages option works
- ✅ Handles missing files gracefully

## 📸 Expected Output

You should see:
- 🐝 Yellow header with "BeePM Initialization"
- 🔍 Cyan "Fetching versions" message
- 🐝 Yellow "Available BEE2 Versions" list with colors
- 📁 Green checkmarks for directory creation
- 💾 Blue backup confirmation
- 📦 Progress bar with green fill
- ✨ Green success box at the end

Enjoy testing! 🎉

