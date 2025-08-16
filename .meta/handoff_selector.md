# Implementation Task: selector

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
  "component": "selector",
  "purpose": "Popup window for selecting which tab to close when limit is exceeded",
  "version": "1.0",
  "technology": {
    "runtime": "Chrome Extension Popup Window",
    "language": "HTML/JavaScript/CSS"
  },
  "requirements": [
    "Display all tabs from the current window",
    "Show tab title, favicon, and URL",
    "Allow user to select one tab to close",
    "Confirm button to close selected tab",
    "Cancel option to close the new tab instead",
    "Clear visual indication of selection"
  ]
}
```

## Implementation Requirements
```json
{
  "priority": 1,
  "estimated_effort": "2 hours",
  "file_outputs": [
    "chrome-tab-limiter/selector.html",
    "chrome-tab-limiter/selector.js",
    "chrome-tab-limiter/selector.css"
  ],
  "implementation_order": [
    "Create selector.html with list structure",
    "Style with selector.css for clear UI",
    "Implement selector.js to load tabs",
    "Add selection handling",
    "Implement confirm/cancel actions",
    "Update background.js to open selector window",
    "Add message passing between background and selector"
  ],
  "specific_requirements": {
    "html_structure": {
      "header": "Title: 'Tab limit reached - Choose a tab to close'",
      "tab_list": "Scrollable list of all tabs",
      "tab_item": "Radio button + favicon + title + URL",
      "action_buttons": "Confirm and Cancel buttons",
      "footer": "Help text explaining the action"
    },
    "javascript_functionality": {
      "onLoad": "Get windowId from URL params, load all tabs",
      "displayTabs": "Show all tabs with favicons and titles",
      "handleSelection": "Track which tab is selected",
      "confirmClose": "Send selected tab ID to background",
      "cancelAction": "Close this selector window and new tab",
      "messagePassing": "Communicate with background.js"
    },
    "css_styling": {
      "window_size": "400px wide, 500px tall",
      "list": "Scrollable with max-height",
      "tab_items": "Hover effects, clear selection state",
      "favicons": "16px icons aligned properly",
      "buttons": "Fixed at bottom, always visible",
      "colors": "Match popup style"
    }
  },
  "ui_layout": {
    "structure": [
      "Header: Warning icon + 'Tab limit reached!'",
      "Subheader: 'This window has exceeded its X tab limit'",
      "Instruction: 'Select a tab to close:'",
      "Tab List (scrollable):",
      "  - [\u25cb] \ud83c\udf10 Tab Title",
      "       example.com",
      "  - [\u25cf] \ud83d\udce7 Gmail",
      "       mail.google.com",
      "Bottom buttons:",
      "  [Close Selected Tab] [Cancel (Close New Tab)]"
    ]
  },
  "background_integration": {
    "opening_selector": "// In background.js\nconst openTabSelector = async (windowId, newTabId) => {\n  const popup = await chrome.windows.create({\n    url: `selector.html?windowId=${windowId}&newTabId=${newTabId}`,\n    type: 'popup',\n    width: 400,\n    height: 500,\n    left: Math.round((screen.width - 400) / 2),\n    top: Math.round((screen.height - 500) / 2),\n    focused: true\n  });\n  return popup.id;\n}",
    "message_handling": "// Listen for selection\nchrome.runtime.onMessage.addListener((request, sender, sendResponse) => {\n  if (request.action === 'tabSelected') {\n    chrome.tabs.remove(request.tabId);\n    chrome.windows.remove(sender.tab.windowId);\n  } else if (request.action === 'cancelSelection') {\n    chrome.tabs.remove(request.newTabId);\n    chrome.windows.remove(sender.tab.windowId);\n  }\n});"
  },
  "code_examples": {
    "selector.html": "<!DOCTYPE html>\n<html>\n<head>\n  <link rel=\"stylesheet\" href=\"selector.css\">\n</head>\n<body>\n  <div class=\"container\">\n    <h2>\u26a0\ufe0f Tab Limit Reached!</h2>\n    <p class=\"subtitle\">Please select a tab to close:</p>\n    <div id=\"tabList\" class=\"tab-list\"></div>\n    <div class=\"actions\">\n      <button id=\"confirm\" disabled>Close Selected Tab</button>\n      <button id=\"cancel\">Cancel (Close New Tab)</button>\n    </div>\n  </div>\n  <script src=\"selector.js\"></script>\n</body>\n</html>",
    "selector.js_init": "// Get params from URL\nconst params = new URLSearchParams(window.location.search);\nconst windowId = parseInt(params.get('windowId'));\nconst newTabId = parseInt(params.get('newTabId'));\n\n// Load tabs for this window\nchrome.tabs.query({windowId: windowId}, (tabs) => {\n  displayTabs(tabs.filter(t => t.id !== newTabId));\n});",
    "tab_item_template": "<div class=\"tab-item\" data-tab-id=\"${tab.id}\">\n  <input type=\"radio\" name=\"tab\" id=\"tab-${tab.id}\">\n  <label for=\"tab-${tab.id}\">\n    <img src=\"${tab.favIconUrl || 'default-icon.png'}\" class=\"favicon\">\n    <div class=\"tab-info\">\n      <div class=\"tab-title\">${tab.title}</div>\n      <div class=\"tab-url\">${new URL(tab.url).hostname}</div>\n    </div>\n  </label>\n</div>"
  },
  "test_requirements": [
    "Selector window opens centered on screen",
    "All tabs from window are listed",
    "Favicons display correctly",
    "Selection state is clear",
    "Confirm button enables after selection",
    "Selected tab closes on confirm",
    "New tab closes on cancel",
    "Selector window closes after action",
    "No errors in console"
  ],
  "important_notes": [
    "Must pass windowId and newTabId through URL params",
    "Filter out the new tab from the list",
    "Handle tabs without favicons gracefully",
    "Ensure window closes after user action",
    "Test with many tabs (scrolling)",
    "Consider keyboard navigation (arrow keys)",
    "The new tab might not be fully loaded yet"
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
- chrome-tab-limiter/selector.html
- chrome-tab-limiter/selector.js
- chrome-tab-limiter/selector.css


### Testing Checklist:
- [ ] Extension loads without errors
- [ ] Tab limit can be set and saved
- [ ] New tabs blocked when limit reached
- [ ] Prompt appears with tab list
- [ ] Selected tab closes correctly
- [ ] New tab opens after closing
- [ ] Settings persist across browser restarts

---
Generated: 2025-08-16T15:36:53.715154
Component: selector
Spec Version: 1.0
