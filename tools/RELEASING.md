# Releasing Tab Limiter

Uploading to the Chrome Web Store is done by hand in the
[Developer Dashboard](https://chrome.google.com/webstore/devconsole). No script holds
credentials or talks to Google.

```bash
tools/release.sh
```

It refuses unless the working tree is clean, you are on `main`, the tests pass and
`v<version>` has not been tagged. It records the commit it starts from, exports exactly
that commit into a private snapshot, and runs the tests and `tools/package.sh` there,
so an edit made while it runs cannot reach the ZIP. It copies the ZIP to
`dist/tab-limiter-<version>.zip` and prints the file list, the commit it built, the
archive's SHA-256 and the steps below. It never commits, tags, pushes or uploads.

## Releasing a version

1. Raise `version` in `chrome-tab-limiter/manifest.json` and commit it. The store
   rejects a package whose version is not higher than the published one.
2. Merge to `main`.
3. Run `tools/release.sh` and read the file list it prints.
4. In the dashboard, open the item, then Package, then Upload new package, choose the
   ZIP and submit for review.
5. When it is accepted, tag **the commit the script printed** (`built from commit ...`),
   not whatever `HEAD` is by then: `git tag v<version> <that commit>`. Push the tag yourself.

## First submission (new item)

Create the item in the dashboard by uploading the same ZIP, then fill in the listing:

- description, category, screenshots and a 128x128 icon;
- a justification for each permission: `tabs` (reads tab URLs and titles to show and
  count tabs), `tabGroups` (group limits) and `storage` (saves limits);
- the privacy practices tab: no user data is collected or sent anywhere;
- a privacy policy URL, if the dashboard asks for one.

## Not covered

The script has been tested, but a real upload has not been done by this project, and
review outcomes are up to the store.
