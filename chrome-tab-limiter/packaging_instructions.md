# Packaging Chrome Tab Limiter for Personal Use

**Never package the working folder.** It can contain editor recovery files
(`*.swp`), signing keys (`*.pem`), exported settings and other local files that
you did not mean to share. Every recipe below builds from an explicit list of the
runtime files instead, and ends with a step that makes you look at the result.

## Method 1: ZIP of the runtime files (easiest)

From the repository root:

```bash
tools/package.sh
```

This copies only the files the extension runs (the manifest, the scripts, the
pages, the stylesheets, `LICENSE` and the three PNG icons) into a clean temporary
folder, checks that every file those scripts and pages refer to is included,
zips it to `dist/tab-limiter-<version>.zip`, refuses to finish if the archive
holds a dotfile, editor recovery file, key or `.crx`, and prints the contents.

**Read the printed list before you share the archive.** If you add a runtime file
to the extension, add it to the `files` list in `tools/package.sh`; the script
stops with an error if a script or page refers to a file that is not listed.

### To install from the ZIP
1. Extract the ZIP into a new, empty folder
2. Open `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select the extracted folder

---

## Method 2: CRX package

A `.crx` is Chrome's single-file extension format. Pack the **extracted ZIP
folder from Method 1**, never the working folder.

1. Run `tools/package.sh` and extract the ZIP into a new, empty folder
2. Open `chrome://extensions/` and enable "Developer mode"
3. Click "Pack extension", select the extracted folder, and leave "Private key
   file" empty the first time
4. Click "Pack Extension"

This creates `<folder>.crx` and `<folder>.pem` next to the folder.

- The **`.pem` is your signing key.** Anyone who has it can publish an extension
  that Chrome treats as yours. Store it somewhere private. Never put it in a
  backup archive, an email or a shared folder.
- Modern Chrome restricts installing a `.crx` directly. Loading the extracted
  folder with "Load unpacked" (Method 1) is simpler and works everywhere.

---

## Method 3: Install script (convenient)

An install script only needs the extracted ZIP from Method 1.

### `install.sh` (Mac/Linux), placed next to the ZIP
```bash
#!/bin/bash
echo "Installing Chrome Tab Limiter..."

zip_file="$(ls tab-limiter-*.zip 2>/dev/null | head -n 1)"
if [ -z "$zip_file" ]; then
    echo "✗ No tab-limiter-*.zip found next to this script."
    exit 1
fi

rm -rf tab-limiter-extension
mkdir tab-limiter-extension
unzip -q "$zip_file" -d tab-limiter-extension

echo "✓ Extension extracted"
echo ""
echo "Next steps:"
echo "1. Open Chrome and go to: chrome://extensions/"
echo "2. Enable 'Developer mode'"
echo "3. Click 'Load unpacked'"
echo "4. Select this folder: $(pwd)/tab-limiter-extension"

if [[ "$OSTYPE" == "darwin"* ]]; then
    open -a "Google Chrome" "chrome://extensions/"
else
    google-chrome "chrome://extensions/" &
fi
```

### `install.bat` (Windows), placed next to the ZIP
```batch
@echo off
echo Installing Chrome Tab Limiter...

for %%f in (tab-limiter-*.zip) do set ZIPFILE=%%f
if not defined ZIPFILE (
    echo Error: no tab-limiter-*.zip found next to this script.
    pause
    exit /b 1
)

if exist tab-limiter-extension rmdir /s /q tab-limiter-extension
powershell -command "Expand-Archive -Path '%ZIPFILE%' -DestinationPath 'tab-limiter-extension'"

echo.
echo Extension extracted. Next steps:
echo 1. Chrome will open to the extensions page
echo 2. Enable 'Developer mode' (top right)
echo 3. Click 'Load unpacked'
echo 4. Select folder: %cd%\tab-limiter-extension
echo.
pause

start chrome "chrome://extensions/"
```

---

## Backup Strategy

### What to back up
- The **repository** itself (source, tests, documentation) with git, for example
  `git bundle create tab-limiter.bundle --all`, which contains only tracked files
- `dist/tab-limiter-<version>.zip` from `tools/package.sh`
- Your exported settings file (`tab-limiter-settings.json`), if you want it

### What never goes into a backup or a shared archive
- `*.pem` signing keys: keep them in a separate, protected place
- Editor recovery files (`*.swp`, `*~`) and `.DS_Store`
- Anything you did not list on purpose

Do not back up by zipping the working folder. `.gitignore` already keeps these
files out of the repository, but it does not protect a plain `zip -r`.

---

## Quick distribution package

```bash
tools/package.sh                      # builds dist/tab-limiter-<version>.zip
cp dist/tab-limiter-*.zip tab-limiter-dist/   # plus install.sh or install.bat
```

Put the ZIP and one install script in a new folder and archive that folder. It
contains only what you placed there.

---

## Tips

1. **Keep the PEM file safe, and out of backups and shared archives,** if you
   create a CRX - it's your signing key
2. **Version your backups** with the version in the file name (the script does)
3. **Test the package** on a different Chrome profile before relying on it
4. **Export your settings** regularly using the extension's export feature
5. **List the archive** (`unzip -l`) before you share it, every time

For personal use, Method 1 (the ZIP) is usually the best: it is simple, reliable
and works everywhere.
