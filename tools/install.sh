#!/bin/bash
# Install Tab Limiter from the tab-limiter-*.zip that sits next to this script.
#
# It extracts into a fresh staging folder, checks the result, and only then
# replaces ./tab-limiter-extension. If anything fails, the existing installation
# is left exactly as it was, nothing is reported as installed, and the exit
# status is not zero. The archive's file name is only ever passed as data.
#
# Set TAB_LIMITER_NO_BROWSER=1 to skip opening the browser (used by the tests).
set -euo pipefail
cd -- "$(dirname -- "$0")"

dest="tab-limiter-extension"

fail() {
    echo "✗ $1 Nothing was changed." >&2
    exit 1
}

shopt -s nullglob
zips=(tab-limiter-*.zip)
shopt -u nullglob
[ "${#zips[@]}" -ge 1 ] || fail "No tab-limiter-*.zip found next to this script."
[ "${#zips[@]}" -le 1 ] || fail "More than one tab-limiter-*.zip found; keep only the one to install."
zip_file="${zips[0]}"

echo "Installing Chrome Tab Limiter..."

# Extract next to the destination (same file system), never into it
staging="$(mktemp -d ./.tab-limiter-staging.XXXXXX)"
trap 'rm -rf -- "$staging"' EXIT

unzip -q -- "$zip_file" -d "$staging" || fail "Could not extract the archive."

for required in manifest.json background.js popup.html options.html; do
    [ -f "$staging/$required" ] || fail "The archive is missing $required."
done

# An extension folder has no reason to contain links that point elsewhere
if [ -n "$(find "$staging" -type l -print -quit)" ]; then
    fail "The archive contains symbolic links."
fi

chmod 755 "$staging"

# Replace the old installation only now that the new one is complete
previous=""
if [ -e "$dest" ]; then
    previous=".tab-limiter-previous.$$"
    mv -- "$dest" "$previous"
fi
if ! mv -- "$staging" "$dest"; then
    if [ -n "$previous" ]; then
        mv -- "$previous" "$dest"
    fi
    fail "Could not put the new installation in place."
fi
if [ -n "$previous" ]; then
    rm -rf -- "$previous"
fi

echo "✓ Extension extracted"
echo ""
echo "Next steps:"
echo "1. Open Chrome and go to: chrome://extensions/"
echo "2. Enable 'Developer mode'"
echo "3. Click 'Load unpacked'"
printf '4. Select this folder: %s/%s\n' "$(pwd)" "$dest"

if [ -z "${TAB_LIMITER_NO_BROWSER:-}" ]; then
    echo ""
    echo "Opening Chrome extensions page..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        open -a "Google Chrome" "chrome://extensions/" || true
    else
        (google-chrome "chrome://extensions/" &) 2>/dev/null || true
    fi
fi
