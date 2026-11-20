#!/usr/bin/env bash
# Build the ZIP you upload to the Chrome Web Store by hand.
#
#   tools/release.sh
#
# Refuses unless the working tree is clean, you are on main, the tests pass and
# this version has not been tagged yet. It records the commit it starts from, exports
# exactly that commit into a private snapshot, and runs the tests and tools/package.sh
# there, so nothing edited afterwards can end up in the ZIP. It uploads nothing, and it
# never commits, tags or pushes.
set -euo pipefail

[ $# -eq 0 ] || { echo "usage: tools/release.sh" >&2; exit 2; }

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

die() { echo "error: $*" >&2; exit 1; }

branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = main ] || die "release from main (you are on $branch)"
[ -z "$(git status --porcelain)" ] || die "the working tree is not clean; commit or stash first"

# Everything below works on this commit, whatever happens to the working tree meanwhile
commit="$(git rev-parse --verify HEAD^{commit})"

snap="$(mktemp -d)"
trap 'rm -rf "$snap"' EXIT
git archive --format=tar "$commit" | tar -x -C "$snap"

version="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$snap/extension/manifest.json")"
[ -z "$(git tag -l "v$version")" ] || die "v$version is already tagged; raise \"version\" in extension/manifest.json"

echo "== tests (snapshot of ${commit})"
if ! (cd "$snap" && node --test >/dev/null 2>&1); then
    (cd "$snap" && node --test 2>&1 | tail -30 >&2) || true
    die "tests fail"
fi
echo "tests pass"

echo "== package"
"$snap/tools/package.sh"
built="$snap/dist/tab-limiter-$version.zip"
[ -f "$built" ] || die "$built was not created"

mkdir -p "$root/dist"
zip="$root/dist/tab-limiter-$version.zip"
cp "$built" "$zip"

echo
echo "Version $version is ready: $zip"
echo "built from commit $commit"
echo "sha256: $(shasum -a 256 "$zip" | cut -d' ' -f1)"
cat <<NEXT

Next, by hand:
  1. Read the file list above.
  2. Developer Dashboard > Tab Limiter > Package > Upload new package, then submit for review.
  3. When it is accepted, tag the commit that was built (not whatever is current by then),
     and push the tag yourself:
         git tag v$version $commit
NEXT
