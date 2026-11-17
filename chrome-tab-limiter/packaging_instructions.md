# Packaging Chrome Tab Limiter for Personal Use

## Method 1: Simple ZIP Package (Easiest)

This is perfect for backing up or sharing with yourself across computers.

### Steps:
```bash
# 1. Navigate to the parent directory
cd path/to/your/project

# 2. Create a ZIP file of the extension
zip -r chrome-tab-limiter.zip chrome-tab-limiter/

# Or on Windows:
# Right-click chrome-tab-limiter folder → Send to → Compressed (zipped) folder
```

### To Install from ZIP:
1. Extract the ZIP file anywhere on your computer
2. Open `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select the extracted folder

### Benefits:
- ✅ Simple and quick
- ✅ Easy to backup
- ✅ Can email to yourself
- ✅ Works on any computer

---

## Method 2: Create CRX Package (More Professional)

A .crx file is Chrome's extension format. This is useful if you want a single file to install.

### Steps:

#### Option A: Using Chrome (Creates unsigned CRX)
1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Pack extension"
4. Browse to your `chrome-tab-limiter` folder
5. Leave "Private key file" empty (first time)
6. Click "Pack Extension"

This creates:
- `chrome-tab-limiter.crx` - The packaged extension
- `chrome-tab-limiter.pem` - Private key (KEEP THIS SAFE!)

#### Option B: Using Command Line
```bash
# On macOS/Linux:
cd /path/to/extensions/directory
google-chrome --pack-extension=chrome-tab-limiter

# On Windows:
cd C:\path\to\extensions\directory
chrome.exe --pack-extension=chrome-tab-limiter
```

### To Install CRX:
**Note**: Modern Chrome restricts installing CRX files directly for security. You have two options:

1. **Use Developer Mode** (Recommended):
   - Just use Method 1 (Load unpacked) - it's simpler!

2. **Install via Drag & Drop** (May not work on newer Chrome):
   - Open `chrome://extensions/`
   - Drag the .crx file onto the page
   - Click "Add extension"

---

## Method 3: Create Install Script (Convenient)

Create a simple install script for quick setup on new machines.

### Create `install.sh` (Mac/Linux):
```bash
#!/bin/bash
echo "Installing Chrome Tab Limiter..."

# Check if Chrome is installed
if [ -d "/Applications/Google Chrome.app" ] || command -v google-chrome &> /dev/null; then
    echo "✓ Chrome detected"
else
    echo "✗ Chrome not found. Please install Chrome first."
    exit 1
fi

# Extract if needed
if [ -f "chrome-tab-limiter.zip" ]; then
    echo "Extracting extension..."
    unzip -q chrome-tab-limiter.zip
fi

# Check if extension directory exists
if [ ! -d "chrome-tab-limiter" ]; then
    echo "✗ Extension folder not found!"
    exit 1
fi

echo "✓ Extension ready to install"
echo ""
echo "Next steps:"
echo "1. Open Chrome and go to: chrome://extensions/"
echo "2. Enable 'Developer mode'"
echo "3. Click 'Load unpacked'"
echo "4. Select this folder: $(pwd)/chrome-tab-limiter"
echo ""
echo "Opening Chrome extensions page..."

# Open Chrome extensions page
if [[ "$OSTYPE" == "darwin"* ]]; then
    open -a "Google Chrome" "chrome://extensions/"
else
    google-chrome "chrome://extensions/" &
fi
```

### Create `install.bat` (Windows):
```batch
@echo off
echo Installing Chrome Tab Limiter...

:: Check if extension exists
if not exist "chrome-tab-limiter" (
    if exist "chrome-tab-limiter.zip" (
        echo Extracting extension...
        powershell -command "Expand-Archive -Path 'chrome-tab-limiter.zip' -DestinationPath '.'"
    ) else (
        echo Error: Extension folder not found!
        pause
        exit /b 1
    )
)

echo.
echo Extension ready to install!
echo.
echo Next steps:
echo 1. Chrome will open to extensions page
echo 2. Enable 'Developer mode' (top right)
echo 3. Click 'Load unpacked'
echo 4. Select folder: %cd%\chrome-tab-limiter
echo.
pause

:: Open Chrome extensions page
start chrome "chrome://extensions/"
```

---

## Backup Strategy

### What to Backup:
```
chrome-tab-limiter/
├── All source files (*.html, *.js, *.css)
├── manifest.json
├── icons/
└── utils/

PLUS (optional):
├── README.md
└── Your exported settings JSON files

NEVER include:
└── chrome-tab-limiter.pem  (the CRX signing key; keep it somewhere private)
```

The signing key proves that an update comes from you. Anyone holding it can
publish an extension that Chrome treats as yours, so it must not end up in a
backup ZIP, an email, or a shared folder.

### Simple Backup Script:
```bash
#!/bin/bash
# backup.sh
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="tab-limiter-backup-${DATE}.zip"

echo "Creating backup: ${BACKUP_NAME}"
zip -r "${BACKUP_NAME}" chrome-tab-limiter/ README.md -x "*.pem" "*/*.pem" 2>/dev/null

echo "✓ Backup created: ${BACKUP_NAME}"
echo "  Size: $(du -h ${BACKUP_NAME} | cut -f1)"
```

---

## Quick Distribution Package

If you want everything in one package for easy reinstall:

### Create Complete Package:
```bash
# Create distribution folder
mkdir tab-limiter-dist
cp -r chrome-tab-limiter tab-limiter-dist/
cp README.md tab-limiter-dist/
cp install.sh tab-limiter-dist/  # or install.bat for Windows

# Create archive
zip -r tab-limiter-complete.zip tab-limiter-dist/

# Clean up
rm -rf tab-limiter-dist
```

Now you have a single ZIP with everything needed:
- The extension
- Documentation  
- Install script

---

## Tips

1. **Keep the PEM file safe, and out of backups and shared archives,** if you create a CRX - it's your signing key
2. **Version your backups** with dates in filenames
3. **Test the package** on a different Chrome profile before relying on it
4. **Export your settings** regularly using the extension's export feature
5. **Use cloud storage** (Google Drive, Dropbox) for automatic backup

For personal use, Method 1 (ZIP file) is usually the best - it's simple, reliable, and works everywhere!