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

## Publishing to the Chrome Web Store

Uploading is done by hand in the Developer Dashboard. `tools/release.sh` checks the
tree, runs the tests and builds the ZIP to upload; see `tools/RELEASING.md`.

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

`tools/install.sh` (Mac/Linux) and `tools/install.bat` (Windows) unpack the ZIP
from Method 1 for you. Copy one of them into the folder that holds the
`tab-limiter-<version>.zip` and run it there. Keep exactly one ZIP in that folder.

What they do, and what they refuse to do:

- They extract into a **fresh staging folder** and check that the manifest, the
  background script and both pages are present. The installer for Mac/Linux also
  refuses an archive that contains symbolic links.
- Only then do they replace `tab-limiter-extension`. **If anything fails, the
  existing installation is left exactly as it was**, nothing is reported as
  installed, no browser is opened and the exit status is not zero.
- The ZIP's file name is handled as data, never as part of a command, so a name
  containing quotes, spaces, `;`, `$(...)` or `&` cannot run anything.

```bash
# Mac/Linux
bash install.sh
```

```batch
:: Windows: double-click install.bat, or run it from a command prompt
install.bat
```

Then open `chrome://extensions/`, enable "Developer mode", click "Load unpacked"
and select the `tab-limiter-extension` folder the script prints.

**The Windows script has not been run on Windows.** `tests/installer.test.js` runs
the Mac/Linux script for real, including corrupt archives and hostile file names,
and holds the Windows script to the same rules by inspection. If you would rather
not rely on it, extract the ZIP into a new folder with "Extract All..." and use
"Load unpacked" on that folder.

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
tools/package.sh                                  # builds dist/tab-limiter-<version>.zip
mkdir tab-limiter-dist
cp dist/tab-limiter-*.zip tools/install.sh tools/install.bat tab-limiter-dist/
```

Archive that new folder. It contains only what you copied into it; list it with
`unzip -l` before you share it.

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
