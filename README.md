# 🐝 BeePM (BEE2 Package Manager)

A beautiful, colorful command-line package manager for BEE2.

## ✨ Features

- 🎨 **Colorful Interface** - Beautiful, modern CLI with emojis and colors
- 🔍 **Version Selection** - Choose from available BEE2 releases
- ⚙️ **Auto-Configuration** - Automatically configures BEE2 to use BeePM
- 📦 **Base Packages** - Downloads and installs official BEE2 items
- 💾 **Safe Updates** - Backs up your original configuration

## 📦 Installation

```bash
pip install -e .
```

## 🚀 Usage

### Initialize BeePM

```bash
beepm init
```

This will walk you through a beautiful 6-step process:

1. 🐝 **Select BEE2 Version** - Choose from available releases (use arrow keys!)
2. 📁 **Create Directories** - Set up the BeePM folder structure
3. ⚙️ **Modify BEE2 Config** - Configure BEE2 to use BeePM (with backup!)
4. 📦 **Download Packages** - Install official BEE2 base packages
5. 📝 **Generate Metadata** - Create bee-package.json for all packages (with ID, name, version, etc.)
6. ✅ **Finalize Setup** - Create BeePM configuration

### Uninstall BeePM

```bash
beepm uninit
```

This will:
- Restore your original BEE2 configuration from backup
- Remove BeePM directories and files
- Optionally keep your downloaded packages with `--keep-packages`

## 📋 Requirements

- Python 3.7+
- BEE2 installed and run at least once
- Windows (uses `%appdata%` directory)

## 🎨 Beautiful Output

BeePM uses a colorful, emoji-rich interface that makes package management a joy!

