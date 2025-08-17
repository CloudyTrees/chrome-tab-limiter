# Implementation Task: tab-groups

## Environment Setup

This is a Chrome extension project with vanilla JavaScript.

### Project Structure:
```
chrome-tab-limiter/
├── manifest.json       # Extension manifest
├── background.js       # Background service worker
├── popup.html         # Popup UI
├── popup.js           # Popup logic
├── popup.css          # Popup styling
├── content.js         # Content script (if needed)
├── options.html       # Options page (optional)
├── options.js         # Options logic
├── options.css        # Options styling
├── icons/            # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── utils/            # Utility modules
    └── storage.js    # Chrome storage API wrapper
```

### Setup Commands:
```bash
# Create project directory
mkdir -p chrome-tab-limiter/{icons,utils}
cd chrome-tab-limiter

# Initialize git (optional)
git init
```

### Chrome Extension Requirements:
- Manifest V3 format
- Service worker for background script
- Chrome APIs: tabs, storage, windows
- No external dependencies (vanilla JS only)

## Project Context
```json
{
  "name": "chrome-tab-limiter",
  "description": "Chrome extension to limit number of open tabs",
  "tech_stack": {
    "platform": "Chrome Extension",
    "manifest": "V3",
    "language": "JavaScript"
  }
}
```

## Component Specification
```json
{
  "component": "tab-groups",
  "purpose": "Add support for Chrome tab groups with separate limits per group",
  "version": "1.0",
  "technology": {
    "runtime": "Chrome Extension (Manifest V3)",
    "language": "JavaScript"
  },
  "requirements": [
    "Track tabs by group within each window",
    "Allow setting limits per tab group",
    "Ungrouped tabs have their own limit",
    "Show group information in selector window",
    "Update popup to show group limits"
  ]
}
```

## Implementation Requirements
```json
{
  "priority": 1,
  "estimated_effort": "2 hours",
  "file_outputs": [
    "chrome-tab-limiter/background.js",
    "chrome-tab-limiter/popup.js",
    "chrome-tab-limiter/popup.html",
    "chrome-tab-limiter/selector.js",
    "chrome-tab-limiter/utils/storage.js"
  ],
  "implementation_order": [
    "Update storage.js to handle group limits",
    "Modify background.js to track tab groups",
    "Update popup to show/set group limits",
    "Enhance selector to display group information"
  ],
  "specific_requirements": {
    "storage_updates": {
      "getGroupLimit": "Get limit for specific group in window",
      "setGroupLimit": "Set limit for specific group",
      "getGroupLimits": "Get all group limits for a window",
      "storage_structure": {
        "windowLimits": "Keep existing per-window limits",
        "groupLimits": {
          "windowId_groupId": "limit",
          "windowId_ungrouped": "limit for ungrouped tabs"
        }
      }
    },
    "background_updates": {
      "tab_tracking": "Track tabs by groupId (-1 for ungrouped)",
      "onTabCreated": "Check group-specific limit",
      "onTabUpdated": "Handle tab moving between groups",
      "getTabsByGroup": "Helper to count tabs per group"
    },
    "popup_updates": {
      "ui_changes": [
        "Add 'Tab Groups' section",
        "List active groups in current window",
        "Input for each group's limit",
        "Special row for ungrouped tabs limit"
      ],
      "functionality": [
        "Query current window's tab groups",
        "Save group-specific limits",
        "Show tab count per group"
      ]
    },
    "selector_updates": {
      "display_changes": [
        "Group tabs by their group",
        "Show group color and title",
        "Visual separator between groups",
        "Sort: grouped tabs first, then ungrouped"
      ]
    }
  },
  "code_examples": {
    "background_grouping": "// Get tabs by group\nconst getTabsByGroup = async (windowId) => {\n  const tabs = await chrome.tabs.query({windowId});\n  const groups = {};\n  \n  tabs.forEach(tab => {\n    const groupKey = tab.groupId === -1 ? 'ungrouped' : `group_${tab.groupId}`;\n    if (!groups[groupKey]) {\n      groups[groupKey] = [];\n    }\n    groups[groupKey].push(tab);\n  });\n  \n  return groups;\n};",
    "popup_group_section": "<!-- In popup.html -->\n<div class=\"section\">\n  <h3>Tab Group Limits</h3>\n  <div id=\"groupsList\">\n    <!-- Dynamically populated -->\n  </div>\n</div>",
    "group_display": "// Display groups in popup\nconst groups = await chrome.tabGroups.query({windowId});\nfor (const group of groups) {\n  const groupEl = document.createElement('div');\n  groupEl.innerHTML = `\n    <span style=\"color: ${group.color}\">${group.title || 'Untitled Group'}</span>\n    <input type=\"number\" id=\"group_${group.id}\" value=\"${limit}\" min=\"1\" max=\"50\">\n    <button onclick=\"saveGroupLimit(${group.id})\">Save</button>\n  `;\n}"
  },
  "chrome_apis": {
    "new_apis": [
      "chrome.tabGroups.query() - Get all groups",
      "chrome.tabGroups.get() - Get specific group info",
      "chrome.tabs.group() - Group tabs (optional feature)",
      "tab.groupId property - Identify tab's group"
    ],
    "permissions": [
      "tabGroups permission (add to manifest.json)"
    ]
  },
  "test_requirements": [
    "Create multiple tab groups",
    "Set different limits per group",
    "Test ungrouped tabs limit separately",
    "Verify moving tabs between groups updates counts",
    "Selector shows tabs organized by group",
    "Limits enforced correctly per group"
  ],
  "important_notes": [
    "Tab groupId is -1 when not in a group",
    "Groups can be collapsed - still count tabs",
    "Groups are window-specific",
    "Handle group deletion (tabs become ungrouped)",
    "Consider group color in UI for visual consistency"
  ]
}
```

## Current Status
```json
{}
```

## Development Workflow

### 1. Load Extension in Chrome:
```bash
1. Open Chrome and navigate to chrome://extensions/
2. Enable "Developer mode" toggle
3. Click "Load unpacked"
4. Select the chrome-tab-limiter directory
```

### 2. Development Commands:
```bash
# No build step needed for vanilla JS
# Just edit files and reload extension in Chrome

# Watch for changes (optional, using any file watcher)
# fswatch -o . | xargs -n1 -I{} echo "Files changed, reload extension in Chrome"
```

### 3. Testing the Extension:
- Click the extension icon to open popup
- Try opening tabs beyond the limit
- Check that prompt appears correctly
- Verify tab closing functionality
- Test persistence of settings

### 4. Debugging:
- Right-click extension icon > "Inspect popup" for popup debugging
- Go to chrome://extensions/ > "Inspect views: service worker" for background script
- Use Chrome DevTools Console for debugging

### Core Functionality to Implement:
- [ ] Track number of open tabs in current window
- [ ] Store maximum tab limit in chrome.storage
- [ ] Monitor tab creation events
- [ ] Show prompt when limit exceeded
- [ ] Allow user to select tab to close
- [ ] Close selected tab and open new one
- [ ] Settings UI in popup

## Implementation Instructions for Claude Code

### Core Features to Implement:

1. **Tab Tracking (background.js)**:
   - Listen to tab creation/removal events
   - Track tab count per window
   - Check against user-defined limit

2. **Limit Enforcement**:
   - When limit exceeded, prevent new tab creation
   - Show prompt to select tab to close
   - Handle user selection

3. **User Interface (popup.html/js)**:
   - Input field for max tab limit
   - Save button to store preference
   - Current tab count display

4. **Storage (utils/storage.js)**:
   - Save/load max tab limit
   - Use chrome.storage.sync for cross-device sync

5. **Prompt Dialog**:
   - List all current tabs with titles
   - Allow selection of tab to close
   - Handle cancellation

### Manifest.json Structure:
```json
{
  "manifest_version": 3,
  "name": "Tab Limiter",
  "version": "1.0",
  "description": "Limit the number of open tabs in a window",
  "permissions": [
    "tabs",
    "storage"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "action": {
    "default_popup": "popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

### File Structure to Create:
- chrome-tab-limiter/background.js
- chrome-tab-limiter/popup.js
- chrome-tab-limiter/popup.html
- chrome-tab-limiter/selector.js
- chrome-tab-limiter/utils/storage.js


### Testing Checklist:
- [ ] Extension loads without errors
- [ ] Tab limit can be set and saved
- [ ] New tabs blocked when limit reached
- [ ] Prompt appears with tab list
- [ ] Selected tab closes correctly
- [ ] New tab opens after closing
- [ ] Settings persist across browser restarts

---
Generated: 2025-08-16T16:43:02.904724
Component: tab-groups
Spec Version: 1.0
