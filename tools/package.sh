#!/usr/bin/env bash
# Build dist/tab-limiter-<version>.zip from an explicit list of runtime files.
# Nothing else in the working folder (editor recovery files, keys, exports,
# documentation) can end up in the archive. The result is listed for inspection.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/chrome-tab-limiter"

# Everything the extension needs to run, and nothing more
files=(
    manifest.json
    LICENSE
    background.js
    popup.html popup.css popup.js
    options.html options.css options.js
    utils/export-import.js
    utils/limits.js
    utils/sanitize.js
    utils/selection.js
    utils/serial-queue.js
    utils/state-store.js
    utils/storage.js
    utils/validation.js
    icons/icon16.png icons/icon48.png icons/icon128.png
)

version="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$src/manifest.json")"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

for f in "${files[@]}"; do
    [ -f "$src/$f" ] || { echo "error: $f is missing" >&2; exit 1; }
    mkdir -p "$stage/$(dirname "$f")"
    cp "$src/$f" "$stage/$f"
done

# Every local file the pages and scripts refer to must be in the list
python3 - "$stage" <<'PY'
import os, re, sys
stage = sys.argv[1]
missing = []
for dirpath, _, names in os.walk(stage):
    for name in names:
        if not name.endswith(('.js', '.html')):
            continue
        path = os.path.join(dirpath, name)
        text = open(path, encoding='utf-8').read()
        refs = re.findall(r"""from\s+['"](\.{1,2}/[^'"]+)['"]""", text)
        if name.endswith('.html'):
            refs += re.findall(r"""(?:src|href)=["']([^"':]+\.(?:js|css))["']""", text)
        for ref in refs:
            if not os.path.exists(os.path.normpath(os.path.join(dirpath, ref))):
                missing.append(f"{os.path.relpath(path, stage)} -> {ref}")
if missing:
    sys.exit("error: referenced files are not packaged:\n  " + "\n  ".join(missing))
PY

out="$root/dist/tab-limiter-$version.zip"
mkdir -p "$root/dist"
rm -f "$out"
(cd "$stage" && zip -qr -X "$out" .)

# Refuse to finish if anything that does not belong is inside
unexpected="$(unzip -Z1 "$out" | grep -E '(^|/)\.|\.(swp|swo|pem|key|crx)$|~$' || true)"
if [ -n "$unexpected" ]; then
    rm -f "$out"
    echo "error: unexpected files in the archive:" >&2
    echo "$unexpected" >&2
    exit 1
fi

echo "Created $out"
unzip -l "$out"
echo "Inspect the list above before sharing the archive."
