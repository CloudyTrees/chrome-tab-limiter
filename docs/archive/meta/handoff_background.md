# Implementation Task: background

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
  "component": "background",
  "purpose": "Service worker that manages tab counting and limit enforcement per window",
  "version": "1.0",
  "technology": {
    "runtime": "Chrome Extension Service Worker (Manifest V3)",
    "language": "JavaScript"
  },
  "requirements": [
    "Track tab count per window independently",
    "Listen to tab creation events",
    "Check against stored limits when new tab created",
    "Open selector window when limit exceeded",
    "Handle tab removal after user selection",
    "Clean up data for closed windows"
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
    "chrome-tab-limiter/utils/storage.js"
  ],
  "implementation_order": [
    "Create storage.js with get/set functions for tab limits",
    "Set up background.js service worker structure",
    "Implement tab counting per window",
    "Add tab creation listener",
    "Implement limit checking logic",
    "Add placeholder for selector window opening",
    "Handle window close cleanup"
  ],
  "specific_requirements": {
    "storage_functions": {
      "getTabLimit": "Get limit for specific window (default 10)",
      "setTabLimit": "Set limit for specific window",
      "getDefaultLimit": "Get default limit for new windows",
      "setDefaultLimit": "Set default limit"
    },
    "background_logic": {
      "tab_tracking": "Map to track current tab count per window",
      "onTabCreated": "Check if new tab exceeds limit",
      "onTabRemoved": "Update tab count",
      "onWindowRemoved": "Clean up window data",
      "openSelector": "Function to open selector window (stub for now)"
    },
    "data_structures": {
      "tabCounts": "Map: windowId -> current tab count",
      "pendingTabs": "Set: tabs waiting for user selection"
    }
  },
  "code_structure": {
    "storage.js": [
      "Export functions for limit management",
      "Use chrome.storage.sync API",
      "Handle defaults properly",
      "Provide clean async/await interface"
    ],
    "background.js": [
      "Import storage functions",
      "Initialize on service worker start",
      "Set up all event listeners",
      "Implement core limit enforcement",
      "Add detailed console logging for debugging"
    ]
  },
  "test_requirements": [
    "Tab count updates correctly when tabs open/close",
    "Limit check triggers at right threshold",
    "Storage persists across extension reload",
    "Window cleanup works properly",
    "No memory leaks with window/tab tracking"
  ],
  "important_notes": [
    "Must handle rapid tab creation (e.g., restore session)",
    "For now, just log when limit exceeded (selector will come later)",
    "Ensure service worker stays active during operations",
    "Consider edge case: moving tabs between windows"
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
Generated: 2025-08-16T15:17:28.355921
Component: background
Spec Version: 1.0
