# Chrome Tab Limiter Extension

A Chrome extension that helps you manage tab overload by setting maximum tab limits per window and per tab group.

## Features

### Core Functionality
- **Per-Window Tab Limits**: Set different maximum tab limits for each browser window
- **You decide what closes**: A new tab that exceeds a limit stays open and waits. The popup then lets you choose which tabs to close. The extension never closes a tab you haven't been asked about, except new tabs beyond the pending limit (see below).
- **Persistent Settings**: Limits are saved locally in this browser (they are not synced to other devices)

### Advanced Features
- **Tab Group Support**: Set separate limits for different tab groups within a window
- **Ungrouped Tab Limits**: Control tabs that aren't in any group separately
- **Export/Import Settings**: Backup and restore all your tab limit configurations
- **Clean UI**: Simple popup interface for quick limit adjustments

## Installation

### For Personal Use (Recommended)
1. Download or clone this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top right)
4. Click "Load unpacked"
5. Select the `chrome-tab-limiter` folder
6. The extension icon will appear in your toolbar

### From Package (CRX file)
1. See "Packaging" section below to create a .crx file
2. Drag the .crx file into `chrome://extensions/`
3. Click "Add extension" when prompted

## Usage

### Setting Tab Limits
1. Click the extension icon in your toolbar
2. Enter your desired maximum tab limit for the current window
3. Click "Save"

### Tab Groups
1. Create tab groups in Chrome (right-click tab → "Add to new group")
2. Open the extension popup
3. Set individual limits for each group
4. Ungrouped tabs can have their own separate limit

### When a Limit is Exceeded
The new tab stays open as a **pending** tab, the toolbar badge shows how many tabs are over, and the popup opens (if Chrome allows it; otherwise click the icon).
1. The popup lists the limits that are exceeded (the window, or a group) and every tab in the window.
2. Tick the tabs to close and click "Close selected tabs". The button turns on only when closing them would bring every limit back within range, and never lets you close the last tab in a window.
3. Or click "Close the new tabs" to close just the pending ones.
4. Or click "Decide later". Nothing changes and nothing times out.

While a window is waiting for your decision, further new tabs in it also wait, up to the **pending limit** (default 5, set on the options page, 1 to 10). After that, additional new tabs are closed and the popup tells you how many. Lowering the pending limit never closes tabs that are already waiting.

A tab you drag into a window or group that is full counts toward the excess and asks you the same question, but it is never closed automatically.

### After a Browser Start (startup mode)
When the browser starts or the extension is reloaded or updated, restored windows may already be over their limits. Until you make your first decision, **nothing is closed automatically**. Tabs over a limit are kept, and the badge shows the excess. In the popup you can:
- **Keep these**: grandfather the tabs that are there now as that window's allowance.
- **Choose tabs to close**, as above.
- **Start enforcing now**: end startup mode right away, in every window, without closing or grandfathering anything. This button is shown in the popup (also when no window is over) for as long as startup mode is on.

Your first decision of any kind also ends startup mode.

### Things to know
- Until your first decision after a browser start, limits are not enforced by closing tabs. If no window goes over, startup mode can stay on until you click "Start enforcing now" or make a decision.
- After "Start enforcing now", a window that was already over its limit stays open for review: its next new tabs wait as pending (up to the pending limit) and are then closed, until you resolve that window.
- Tabs you open during startup mode look the same as restored tabs, so "Keep these" can grandfather them. Tabs opened after startup mode ends can never be grandfathered.
- A tab that was rejected may already have started loading. Its address is not remembered or reopened.
- Closing pending tabs discards whatever state they had acquired (a half-filled form, for example). That only happens when you press the labeled button.
- If the extension's background worker restarts at the wrong moment, a new tab may not be recognised as pending. It then shows up as unexplained excess in the popup for you to review, and nothing is closed.

### Export/Import Settings
1. Click the extension icon
2. Click "⚙️ Settings" at the bottom
3. Use "Export Settings" to download a JSON backup
4. Use "Import Settings" to restore from a backup file

## File Structure
```
chrome-tab-limiter/
├── manifest.json          # Extension configuration
├── background.js          # Core tab management logic
├── popup.html/js/css      # Settings and decision popup
├── options.html/js/css    # Pending limit, export/import settings page
├── utils/
│   ├── limits.js          # Pure limit arithmetic (excess, allowances, creation rules)
│   ├── state-store.js     # Enforcement state in chrome.storage.session
│   ├── serial-queue.js    # One queue: every event and command runs in order
│   ├── selection.js       # Live feedback for the popup's tab picker
│   ├── storage.js         # Chrome storage utilities
│   ├── validation.js      # Message validation for the background worker
│   ├── sanitize.js        # HTML escaping and title sanitizing
│   └── export-import.js   # Settings backup utilities
└── icons/                 # Extension icons (16, 48, 128px)
```

Development-only files live outside this folder and are not packaged:
`tests/` (unit tests) and `package.json` (test runner config) at the repository root.

## Configuration

### Default Settings
- Default tab limit: 10 tabs per window
- Each tab group (and the ungrouped tabs) uses the default limit unless overridden
- Settings are stored locally and do not sync across devices

### Storage Structure
Settings are stored in `chrome.storage.local` as flat keys:
```json
{
  "defaultTabLimit": 10,
  "tabLimit_<windowId>": 5,
  "groupLimit_<windowId>_<groupId>": 4,
  "groupLimit_<windowId>_ungrouped": 6,
  "maxPendingPerWindow": 5,
  "hasSeenWelcome": true
}
```
The decisions in progress are kept in `chrome.storage.session` under `tl_state`: window IDs and tab IDs, which tabs are pending, moved or left over from startup, each window's allowance, a random operation ID, a revision number, and the count of rejected tabs. It holds **no URLs and no titles**. Session storage is in memory only: it survives a background-worker restart, and is cleared when the browser exits or the extension is reloaded or updated (which is when startup mode begins again).

## Development

### Prerequisites
- Chrome browser (for manual testing)
- Node.js 22+ (for unit tests; no npm packages required)
- Basic knowledge of Chrome Extension APIs

### Unit Tests
From the repository root:
```bash
npm test          # or: node --test tests/
```
Tests use Node's built-in test runner and an in-memory `chrome.*` stand-in
(`tests/helpers/chrome-mock.js`). `background.test.js` loads the real
`background.js` and drives it through its tab events and runtime messages.
The popup is exercised against a small fake DOM, so rendering and click handling
are covered, but real Chrome behavior (event ordering, the popup opening on its
own, dragging tabs between windows, worker suspension) needs the manual
checklist in `REVIEW.md`.

### Manual Testing
1. Make changes to the code
2. Go to `chrome://extensions/`
3. Click the refresh icon on the Tab Limiter extension
4. Test your changes

### Debugging
- **Popup**: Right-click extension icon → "Inspect popup"
- **Background**: Go to `chrome://extensions/` → "Inspect views: service worker"
- **Options**: Open options page → Right-click → "Inspect"

## Troubleshooting

### Extension Not Working
- Ensure you've granted all required permissions
- Check for errors in `chrome://extensions/`
- Try refreshing the extension

### Limits Not Enforced
- Verify the limit is set (check popup)
- Make sure you're counting all tabs (including pinned)
- Check if tab groups have separate limits

### The Popup Doesn't Open By Itself
- Chrome only allows an extension to open its popup in some situations. The toolbar badge still shows how many tabs are over; click the icon to decide.

### Settings Not Saving
- Look for storage quota errors in console
- Try export/import as a workaround

## Permissions

The extension asks for three permissions and no host access:

- **`tabs`**: lets it read each tab's `title`, `url` and group, which Chrome withholds without this permission. It uses titles and groups to count tabs and to show you which tab to close; it does not use the URL. The permission does let the extension see the URL of every open tab, so it is the most sensitive one. Nothing is sent anywhere (see Privacy), and tab URLs and titles are never written to storage.
- **`storage`**: saves your limits locally.
- **`tabGroups`**: reads tab group names and colors so groups can have their own limits.

Window handling (telling windows apart, noticing when one closes) needs no permission of its own. Requires Chrome 127 or later.

## Privacy

This extension:
- Works entirely locally on your machine
- Does not collect or transmit any data — the content security policy sets `connect-src 'none'`, so extension pages cannot make network requests, and there is no analytics or telemetry
- Reads tab information (titles, URLs, groups, counts) only to enforce limits and to show the tab list in the popup; tab URLs and titles are never written to storage
- Stores your tab-limit settings in `chrome.storage.local` (not synced to your Google account), and the decisions in progress as IDs and counts in memory-only `chrome.storage.session` (see Storage Structure)
- Does not remember or reopen the address of a tab it closed
- Requests no host, history, cookie, or web-request permissions and injects no content scripts
- Exports settings only when you ask, as a local JSON file named `tab-limiter-settings.json`. It holds your limits, how many you set, the extension version and numbered labels (`window_1`, `group_1`) that show which group limits share a window. It has no real window or group IDs, titles, URLs or dates.

## License

For personal use only. Feel free to modify for your own needs.

## Credits

Developed through collaboration between human and AI assistants (Claude) using a systematic component-based approach.

---

*Version 1.0 - Tab groups, export/import, and all core features included*