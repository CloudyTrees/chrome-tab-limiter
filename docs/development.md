# Development

How the extension is put together and how to work on it. For what it does, see the
[README](../README.md); for assumptions and known limits, [CAVEATS.md](../CAVEATS.md).

## Prerequisites

- Chrome 127 or later, for manual testing
- Node.js 22 or later, for the unit tests (no npm packages are used)
- Basic knowledge of Chrome extension APIs (Manifest V3)

## Layout of `extension/`

```
manifest.json          Extension configuration (MV3, three permissions, strict CSP)
background.js          Service worker: tab events, enforcement, popup commands
popup.html/js/css      Settings and the decision view
options.html/js/css    Pending limit, export/import
utils/
  limits.js            Pure limit arithmetic (excess, allowances, creation rules)
  state-store.js       Enforcement state in chrome.storage.session
  serial-queue.js      One queue: every event and command runs in order
  selection.js         Live feedback for the popup's tab picker
  storage.js           chrome.storage.local helpers
  group-overrides.js   Group limits stored by group and browser session
  validation.js        Message validation for the background worker
  sanitize.js          HTML escaping and title sanitizing
  export-import.js     Settings backup utilities
icons/                 icon16.png, icon48.png, icon128.png
LICENSE                Shipped inside the ZIP
```

Everything in `extension/` that the browser needs must also be listed in `tools/package.sh`, which
builds the ZIP from an explicit file list and stops if a script or page refers to a file that is not
listed.

## How enforcement works

Product rules are in [decisions.md](decisions.md). In short:

- A new tab that exceeds a limit stays open as **pending**. While a window has pending tabs, further
  new tabs join them up to the pending limit; after that they are closed.
- A tab moved into a full window or group counts toward the excess but is never closed automatically.
- After a browser start or an extension reload, **startup mode** keeps everything until the first
  decision.
- Every event and popup command goes through one serial queue (`utils/serial-queue.js`), so decisions
  never interleave. The decision state lives in `chrome.storage.session` (`utils/state-store.js`) so
  it survives a service-worker restart.

The design and its reasoning, including the review rounds that shaped it, are in
[review.md](review.md) and [regressions.md](regressions.md). Source comments cite sections of
`review.md`.

## Storage

Settings are stored in `chrome.storage.local` as flat keys:

```json
{
  "defaultTabLimit": 10,
  "tabLimit_<windowId>": 5,
  "groupLimit_<windowId>_ungrouped": 6,
  "groupOverride_<session>_<groupId>": 4,
  "groupLimitSession": "<random ID>",
  "maxPendingPerWindow": 5,
  "hasSeenWelcome": true
}
```

A group's limit is stored by its group ID, with no window in the key, so it follows the group
between windows. Chrome's group IDs are only unique within one browser session, so the key also
names the session: `groupLimitSession` is a random ID that changes at every browser start, and when
you reset or import settings. Only limits stored under the current one apply; older ones are removed
in the background. Earlier versions stored a group's limit as `groupLimit_<windowId>_<groupId>`.
Such a key is carried over once, and only if that group is still open in that window; otherwise it
is removed.

The decisions in progress are kept in `chrome.storage.session` under `tl_state`: window and tab IDs,
which tabs are pending, moved or left over from startup, each window's allowance, a random operation
ID, a revision number, and the count of rejected tabs. To recognise a move that happened while the
background worker was stopped, it also keeps the window each tab was last seen in, and, for a few
seconds while a group is moving, which tabs belong to that move. A short-lived marker
(`tl_rotation_pending`) holds the new session ID while it is being saved after a browser start. None
of it holds **URLs or titles**. Session storage is in memory only: it survives a worker restart and
is cleared when the browser exits or the extension is reloaded or updated, which is when startup
mode begins again.

## Unit tests

From the repository root:

```bash
npm test          # or: node --test
```

The tests use Node's built-in runner and an in-memory `chrome.*` stand-in
(`tests/helpers/chrome-mock.js`). `background.test.js` loads the real `background.js` and drives it
through its tab events and runtime messages. The popup runs against a small fake DOM, so rendering and
click handling are covered. `copy.test.js` guards user-facing wording: claims that review found
overstated must not come back.

Real Chrome behavior is not covered by the unit tests: event ordering, the popup opening on its own,
dragging tabs between windows, and worker suspension. For those, use the live Chrome checklist in
[review.md](review.md) (search for "The live Chrome checklist"), and its recorded results under
"Live Chrome results".

## Manual testing

1. Open `chrome://extensions/`, turn on *Developer mode* and *Load unpacked* the `extension/` folder.
2. After a code change, click the refresh icon on the extension's card.
3. A fresh install or reload starts in startup mode. Click **Start enforcing now** in the popup before
   testing pending tabs; otherwise an excess tab is kept as startup excess instead.

To test the ZIP rather than the folder, build it with `tools/package.sh`, extract it somewhere new and
load that folder.

## Debugging

- **Popup:** right-click the toolbar icon, then *Inspect popup*.
- **Background worker:** `chrome://extensions/`, then *Inspect views: service worker*.
- **Options page:** open it, right-click, then *Inspect*.

## Troubleshooting

- **Limits not enforced:** check that a limit is set in the popup, that startup mode has ended (the
  popup shows *Start enforcing now* while it is on). The window limit and each group limit (the
  ungrouped tabs count as a group) apply side by side: a window can be within its own limit and
  still have a group over theirs, and the reverse. Pinned tabs count.
- **The popup does not open by itself:** Chrome only allows that in some situations. The toolbar badge
  still shows how many tabs are over; click the icon to decide.
- **Settings not saving:** look for storage errors in the worker's console.

## Related documents

- [packaging.md](packaging.md): building and installing the ZIP
- [releasing.md](releasing.md): submitting to the Chrome Web Store
- [archive/](archive/): the planning files from the project's first version, kept for history
