# Chrome Tab Limiter Extension - Implementation Plan

## Core Requirements
1. **Tab limit scope**: Per window (each window tracks its own limit)
2. **Tab selection UI**: Separate popup window when limit exceeded
3. **Special tabs**: None - all tabs count toward limit

## Architecture Overview

### Component Breakdown

#### 1. **Manifest (manifest.json)**
- Manifest V3 configuration
- Required permissions: `tabs`, `storage`, `windows`
- Background service worker registration
- Extension popup for settings

#### 2. **Background Service Worker (background.js)**
Core logic for tab management:
- Track tab count per window
- Listen to `chrome.tabs.onCreated` event
- Check if new tab exceeds limit
- If exceeded:
  - Prevent/pause new tab creation
  - Open selection popup window
  - Wait for user selection
  - Close selected tab
  - Allow new tab to complete

#### 3. **Settings Storage (utils/storage.js)**
- Store/retrieve tab limit per window
- Default limit (e.g., 10 tabs)
- Use `chrome.storage.sync` for cross-device sync

#### 4. **Settings Popup (popup.html/js/css)**
Main extension UI (click extension icon):
- Display current window's tab count
- Input field to set max tab limit
- Save button
- Show current limit
- Simple, clean interface

#### 5. **Tab Selection Window (selector.html/js/css)**
Separate popup window for tab selection:
- List all tabs in current window with:
  - Tab title
  - Favicon
  - URL preview
- Radio buttons or click-to-select
- Confirm button to close selected tab
- Cancel option (closes the newly attempted tab instead)

## Implementation Order

### Phase 1: Foundation
1. **manifest.json** - Basic setup with all permissions
2. **background.js** - Tab counting and event listeners
3. **utils/storage.js** - Storage API wrapper

### Phase 2: Core Functionality  
4. **popup.html/js/css** - Settings interface
5. **selector.html/js/css** - Tab selection window

### Phase 3: Integration & Polish
6. Integration testing
7. Edge cases handling
8. UI polish

## Technical Implementation Details

### Tab Tracking Logic (background.js)
```javascript
// Pseudocode structure
const tabLimits = new Map(); // windowId -> limit
const currentTabs = new Map(); // windowId -> count

chrome.tabs.onCreated.addListener(async (tab) => {
  const windowId = tab.windowId;
  const limit = await getTabLimit(windowId);
  const currentCount = await getCurrentTabCount(windowId);
  
  if (currentCount > limit) {
    // Open selector window
    const selection = await openTabSelector(windowId);
    if (selection) {
      await chrome.tabs.remove(selection.tabId);
    }
  }
});
```

### Selector Window Creation
```javascript
// Create popup window with tab list
const openTabSelector = async (windowId) => {
  const popup = await chrome.windows.create({
    url: 'selector.html?windowId=' + windowId,
    type: 'popup',
    width: 400,
    height: 500,
    focused: true
  });
  
  // Wait for user selection via message passing
  return waitForSelection(popup.id);
};
```

### Storage Structure
```javascript
// chrome.storage.sync structure
{
  "defaultLimit": 10,
  "windowLimits": {
    "window_123": 8,
    "window_456": 12
  }
}
```

## Key Considerations

### Edge Cases to Handle
1. **Rapid tab creation**: User opens multiple tabs quickly
2. **Window closing**: Clean up stored limits for closed windows
3. **Tab dragging**: Moving tabs between windows
4. **Restore sessions**: Browser restart with many tabs
5. **Incognito mode**: Separate limits or same?

### User Experience
1. **First run**: Set default limit (suggest 10)
2. **Popup positioning**: Center the selector window
3. **Keyboard shortcuts**: ESC to cancel, Enter to confirm
4. **Visual feedback**: Highlight tab count when near limit

### Performance
1. Use event debouncing for rapid tab creation
2. Cache tab counts to avoid repeated queries
3. Clean up closed window data periodically

## Testing Checklist
- [ ] Tab limit enforced correctly per window
- [ ] Selector popup appears when limit exceeded
- [ ] Tab closes when selected
- [ ] New tab opens after selection
- [ ] Settings persist across browser restarts
- [ ] Multiple windows work independently
- [ ] Cancel option works correctly
- [ ] No errors in service worker console

## Next Steps
1. Record these decisions in context
2. Create component specs
3. Generate handoff for manifest component
4. Begin implementation with CC