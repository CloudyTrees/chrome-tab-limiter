# Chrome Tab Limiter Extension

A Chrome extension that helps you manage tab overload by setting maximum tab limits per window and per tab group.

## Features

### Core Functionality
- **Per-Window Tab Limits**: Set different maximum tab limits for each browser window
- **Smart Tab Selection**: When you exceed the limit, a popup window lets you choose which existing tab to close
- **Persistent Settings**: All limits are saved and synced across your devices (if Chrome sync is enabled)

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

### When Limit is Exceeded
When you try to open a tab beyond your limit:
1. A selection window appears showing all tabs in the current window
2. Choose which existing tab to close
3. Click "Close Selected Tab" to proceed
4. Or click "Cancel" to close the new tab instead

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
├── popup.html/js/css      # Settings popup interface
├── selector.html/js/css   # Tab selection window
├── options.html/js/css    # Export/import settings page
├── utils/
│   ├── storage.js         # Chrome storage utilities
│   └── export-import.js   # Settings backup utilities
└── icons/                 # Extension icons (16, 48, 128px)
```

## Configuration

### Default Settings
- Default tab limit: 10 tabs per window
- No limit on tab groups by default
- Settings sync across devices (if Chrome sync is enabled)

### Storage Structure
Settings are stored in Chrome's sync storage:
```json
{
  "defaultLimit": 10,
  "windowLimits": {
    "windowId": limit
  },
  "groupLimits": {
    "windowId_groupId": limit,
    "windowId_ungrouped": limit
  }
}
```

## Development

### Prerequisites
- Chrome browser (for testing)
- Text editor
- Basic knowledge of Chrome Extension APIs

### Testing
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

### Settings Not Saving
- Check Chrome sync is enabled (if using sync storage)
- Look for storage quota errors in console
- Try export/import as a workaround

## Privacy

This extension:
- Works entirely locally on your machine
- Does not collect or transmit any data — the content security policy sets `connect-src 'none'`, so extension pages cannot make network requests, and there is no analytics or telemetry
- Only accesses tab information (titles, favicons, counts) to enforce limits and show the tab selector; tab URLs and titles are never written to storage
- Stores only your tab-limit settings, in `chrome.storage.local` (not synced to your Google account)
- Requests no host, history, cookie, or web-request permissions and injects no content scripts
- Exports settings only when you ask, as a local JSON file with window/group IDs anonymized

## License

For personal use only. Feel free to modify for your own needs.

## Credits

Developed through collaboration between human and AI assistants (Claude) using a systematic component-based approach.

---

*Version 1.0 - Tab groups, export/import, and all core features included*