// Background service worker for Tab Limiter extension
import { getTabLimit, removeWindowData } from './utils/storage.js';

// Data structures to track tab counts and pending operations
const tabCounts = new Map(); // windowId -> current tab count
const pendingTabs = new Set(); // tabs waiting for user selection

// Initialize service worker
console.log('Tab Limiter background service worker starting...');

// Initialize tab counts for all windows on startup
async function initializeTabCounts() {
    try {
        const windows = await chrome.windows.getAll();
        
        for (const window of windows) {
            const tabs = await chrome.tabs.query({ windowId: window.id });
            tabCounts.set(window.id, tabs.length);
            console.log(`Window ${window.id}: ${tabs.length} tabs`);
        }
        
        console.log('Tab counts initialized:', Object.fromEntries(tabCounts));
    } catch (error) {
        console.error('Error initializing tab counts:', error);
    }
}

// Get current tab count for a window
function getTabCount(windowId) {
    return tabCounts.get(windowId) || 0;
}

// Update tab count for a window
function updateTabCount(windowId, delta) {
    const currentCount = getTabCount(windowId);
    const newCount = Math.max(0, currentCount + delta);
    tabCounts.set(windowId, newCount);
    console.log(`Window ${windowId}: ${currentCount} -> ${newCount} tabs`);
    return newCount;
}

// Check if adding a tab would exceed the limit
async function wouldExceedLimit(windowId) {
    const currentCount = getTabCount(windowId);
    const limit = await getTabLimit(windowId);
    return currentCount >= limit;
}

// Open tab selector window
async function openTabSelector(windowId, newTabId) {
    try {
        console.log(`LIMIT EXCEEDED: Opening tab selector for window ${windowId}, new tab ${newTabId}`);
        
        // Create selector popup window
        const popup = await chrome.windows.create({
            url: `selector.html?windowId=${windowId}&newTabId=${newTabId}`,
            type: 'popup',
            width: 400,
            height: 500,
            left: Math.round((await chrome.system.display.getInfo())[0].workArea.width / 2 - 200),
            top: Math.round((await chrome.system.display.getInfo())[0].workArea.height / 2 - 250),
            focused: true
        });
        
        console.log(`Tab selector window created: ${popup.id}`);
        return popup.id;
        
    } catch (error) {
        console.error('Error opening tab selector:', error);
        
        // Fallback: just close the new tab
        try {
            await chrome.tabs.remove(newTabId);
            console.log(`Fallback: Closed new tab ${newTabId}`);
        } catch (removeError) {
            console.error('Error removing tab in fallback:', removeError);
        }
    }
}

// Handle tab creation
async function handleTabCreated(tab) {
    try {
        console.log(`Tab created: ${tab.id} in window ${tab.windowId}`);
        
        // Check if this would exceed the limit
        if (await wouldExceedLimit(tab.windowId)) {
            console.log(`Tab creation would exceed limit for window ${tab.windowId}`);
            
            // Add to pending tabs
            pendingTabs.add(tab.id);
            
            // Open selector window
            await openTabSelector(tab.windowId, tab.id);
            
            // Don't update tab count yet - wait for user selection
            return;
        }
        
        // Update tab count
        updateTabCount(tab.windowId, 1);
        
    } catch (error) {
        console.error('Error handling tab creation:', error);
    }
}

// Handle tab removal
function handleTabRemoved(tabId, removeInfo) {
    try {
        console.log(`Tab removed: ${tabId} from window ${removeInfo.windowId}`);
        
        // Remove from pending tabs if it was pending
        pendingTabs.delete(tabId);
        
        // Update tab count (only if window still exists)
        if (!removeInfo.isWindowClosing) {
            updateTabCount(removeInfo.windowId, -1);
        }
        
    } catch (error) {
        console.error('Error handling tab removal:', error);
    }
}

// Handle window removal
async function handleWindowRemoved(windowId) {
    try {
        console.log(`Window removed: ${windowId}`);
        
        // Clean up tab count tracking
        tabCounts.delete(windowId);
        
        // Clean up storage data for this window
        await removeWindowData(windowId);
        
        console.log('Window cleanup completed for:', windowId);
        
    } catch (error) {
        console.error('Error handling window removal:', error);
    }
}

// Handle messages from selector window
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('Received message:', request);
    
    switch (request.action) {
        case 'tabSelected':
            handleTabSelected(request.tabId, request.windowId, request.newTabId);
            break;
            
        case 'cancelSelection':
            handleCancelSelection(request.newTabId, request.windowId);
            break;
            
        default:
            console.warn('Unknown message action:', request.action);
    }
    
    // Send response to acknowledge receipt
    sendResponse({ success: true });
});

// Handle tab selection from selector window
async function handleTabSelected(selectedTabId, windowId, newTabId) {
    try {
        console.log(`User selected tab ${selectedTabId} to close, keeping new tab ${newTabId}`);
        
        // Remove the selected tab
        await chrome.tabs.remove(selectedTabId);
        console.log(`Closed selected tab: ${selectedTabId}`);
        
        // Remove new tab from pending
        pendingTabs.delete(newTabId);
        
        // Update tab count (net zero change - one removed, one added)
        console.log(`Tab counts remain unchanged for window ${windowId}`);
        
    } catch (error) {
        console.error('Error handling tab selection:', error);
        
        // Fallback: remove the new tab
        try {
            await chrome.tabs.remove(newTabId);
            pendingTabs.delete(newTabId);
            console.log(`Fallback: Removed new tab ${newTabId}`);
        } catch (fallbackError) {
            console.error('Error in fallback tab removal:', fallbackError);
        }
    }
}

// Handle cancel selection from selector window
async function handleCancelSelection(newTabId, windowId) {
    try {
        console.log(`User canceled, removing new tab ${newTabId}`);
        
        // Remove the new tab
        await chrome.tabs.remove(newTabId);
        console.log(`Canceled: Removed new tab ${newTabId}`);
        
        // Remove from pending
        pendingTabs.delete(newTabId);
        
        // No need to update tab count as the new tab is removed
        console.log(`Tab count unchanged for window ${windowId}`);
        
    } catch (error) {
        console.error('Error handling cancel selection:', error);
    }
}

// Set up event listeners
chrome.tabs.onCreated.addListener(handleTabCreated);
chrome.tabs.onRemoved.addListener(handleTabRemoved);
chrome.windows.onRemoved.addListener(handleWindowRemoved);

// Initialize on service worker startup
initializeTabCounts();

console.log('Tab Limiter background service worker initialized');