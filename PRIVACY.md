# Tab Limiter Privacy Policy

Effective date: 17 November 2026 (version 1.0.0)

Tab Limiter is a Chrome extension that limits how many tabs a browser window or tab group
may hold and lets you choose which tabs to close when a limit is exceeded.

**Short version: Tab Limiter does not collect, transmit, sell or share any data. Everything it
handles stays on your device.**

## What the extension handles

To do its job the extension reads, in your browser only:

- the **titles** of your open tabs, to show you the list from which you choose tabs to close;
- **tab events**: a tab being created, closed, moved between windows or groups, or navigating
  to a new address, so that it can count tabs and avoid acting on an out-of-date view. Chrome
  delivers these together with each tab's title and current web address, so the extension's
  background process receives them. It uses the titles for the list and uses the fact that an
  address changed to notice navigation; it does not otherwise use addresses;
- **tab group names and colors**, so that each group can have its own limit;
- the **number of tabs** in each window and group.

All of this is processed locally, in memory, on your device. The extension does not read the
content of web pages, and it has no access to your browsing history, cookies, passwords or form
data. (Chrome does make each tab's title and address available to it through the `tabs`
permission; that is the sensitive access the permission grants, and the reason this policy says
exactly what is done with it.)

## What the extension stores, and where

- **Your settings**: the default tab limit, per-window and per-group limits, the pending-tab limit,
  and a flag that you have seen the welcome message. These are stored on your device in Chrome's
  local extension storage (`chrome.storage.local`). They are **not** synced to your Google account.
- **Decisions in progress**: window and tab ID numbers, which tabs are waiting, and counts. These
  are held in memory-only extension storage (`chrome.storage.session`) and disappear when the browser
  closes or the extension is reloaded or updated. They contain **no tab titles and no web addresses**.
- **Tab titles and web addresses are never written to storage and are never transmitted.** They are
  held only in the memory of the running extension, transiently, while it processes tab events and
  while it builds the list you see.
- When a tab is closed because it was beyond the waiting limit, its address is not remembered or reopened.

## What leaves your device

Nothing. The extension makes no network requests: its content security policy sets
`connect-src 'none'`, so the browser itself blocks them. It contains no analytics, advertising,
telemetry or crash-reporting code, and it loads no code from the internet.

## Exporting your settings

If you press "Export Settings", the extension saves a file named `tab-limiter-settings.json` to
your computer. It contains your limits, how many you set, the extension version, and numbered labels
such as `window_1` and `group_1` showing which group limits belong to the same window. It
contains no real window or group IDs, no tab titles, no web addresses and no dates. The file is
created locally and is not sent anywhere; what you do with it is up to you. "Import Settings"
restores only the default limit and the pending-tab limit; window and group limits are not imported.

## Sharing and sale

The extension does not sell, rent, transfer or disclose data to anyone, for any purpose, including
advertising, creditworthiness or lending decisions. It uses the information described above only for
its single purpose: limiting and managing the number of open tabs.

## Your control

- Change or remove your limits at any time in the extension's popup and options page.
- "Reset Settings" on the options page deletes your stored limits and restores the defaults.
- Uninstalling the extension removes everything it stored in your browser.

## Permissions

- **tabs**: makes tab titles and addresses available to the extension. Needed to show the tab titles
  in the list and to notice when a tab navigates. (Counting tabs and receiving tab events alone
  would not need this permission.)
- **tabGroups**: read tab group names and colors.
- **storage**: save your settings on your device.

The extension requests no host permissions, injects no scripts into web pages and needs no account.

## Open source

Tab Limiter's complete source code is in this repository, so every statement above can be
checked: the permissions are in `extension/manifest.json`, the network ban is its
`content_security_policy`, and the code that reads tabs is in `extension/background.js`
and `extension/popup.js`. Known limitations of the extension (as opposed to its privacy
practices) are listed in [CAVEATS.md](CAVEATS.md).

## Children

The extension is a general-purpose browser utility, is not directed at children and collects nothing
from anyone.

## Changes to this policy

If a later version of the extension handles data differently, this policy will be updated before
that version is published, and the effective date above will change.

## Contact

Questions about this policy: open an issue in this repository's issue tracker.
