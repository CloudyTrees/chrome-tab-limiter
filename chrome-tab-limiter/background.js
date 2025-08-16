// Background service worker for Tab Limiter extension
import { getTabLimit, removeWindowData } from './utils/storage.js';

// Data structures to track tab counts and pending operations
const tabCounts = new Map(); // windowId -> current tab count
const pendingTabs = new Set(); // tabs waiting for user selection

// Rate limiting for security
const rateLimiter = {
    operations: new Map(), // operation type -> array of timestamps
    limits: {
        tabCreation: { maxOps: 10, windowMs: 1000 }, // Max 10 tab creations per second
        selectorOpen: { maxOps: 3, windowMs: 5000 },  // Max 3 selector opens per 5 seconds
    },
    
    isAllowed(operationType) {
        const now = Date.now();
        const limit = this.limits[operationType];
        
        if (!limit) return true; // No limit defined
        
        if (!this.operations.has(operationType)) {
            this.operations.set(operationType, []);
        }
        
        const timestamps = this.operations.get(operationType);
        
        // Remove old timestamps outside the window
        const cutoff = now - limit.windowMs;
        const recentOps = timestamps.filter(ts => ts > cutoff);
        
        // Update the array
        this.operations.set(operationType, recentOps);
        
        // Check if we're under the limit
        if (recentOps.length >= limit.maxOps) {
            console.warn(`Rate limit exceeded for ${operationType}`);
            return false;
        }
        
        // Add current operation
        recentOps.push(now);
        return true;
    }
};

// Initialize service worker
const DEBUG_MODE = false; // Set to false in production

function debugLog(...args) {
    if (DEBUG_MODE) {
        console.log('[Tab Limiter]', ...args);
    }
}

debugLog('Background service worker starting...');

// Initialize tab counts for all windows on startup
async function initializeTabCounts() {
    try {
        const windows = await chrome.windows.getAll();
        
        for (const window of windows) {
            const tabs = await chrome.tabs.query({ windowId: window.id });
            tabCounts.set(window.id, tabs.length);
            debugLog(`Window ${window.id}: ${tabs.length} tabs`);
        }
        
        debugLog('Tab counts initialized:', Object.fromEntries(tabCounts));
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
    debugLog(`Window ${windowId}: ${currentCount} -> ${newCount} tabs`);
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
        // Rate limiting check
        if (!rateLimiter.isAllowed('selectorOpen')) {
            console.warn('Selector opening rate limited - closing new tab');
            await chrome.tabs.remove(newTabId);
            return;
        }
        
        debugLog(`LIMIT EXCEEDED: Opening tab selector for window ${windowId}, new tab ${newTabId}`);
        
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
        
        debugLog(`Tab selector window created: ${popup.id}`);
        return popup.id;
        
    } catch (error) {
        console.error('Error opening tab selector:', error);
        
        // Fallback: just close the new tab
        try {
            await chrome.tabs.remove(newTabId);
            debugLog(`Fallback: Closed new tab ${newTabId}`);
        } catch (removeError) {
            console.error('Error removing tab in fallback:', removeError);
        }
    }
}

// Handle tab creation
async function handleTabCreated(tab) {
    try {
        // Rate limiting check for tab creation
        if (!rateLimiter.isAllowed('tabCreation')) {
            console.warn('Tab creation rate limited');
            return;
        }
        
        debugLog(`Tab created: ${tab.id} in window ${tab.windowId}`);
        
        // Check if this would exceed the limit
        if (await wouldExceedLimit(tab.windowId)) {
            debugLog(`Tab creation would exceed limit for window ${tab.windowId}`);
            
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
        debugLog(`Tab removed: ${tabId} from window ${removeInfo.windowId}`);
        
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
        debugLog(`Window removed: ${windowId}`);
        
        // Clean up tab count tracking
        tabCounts.delete(windowId);
        
        // Clean up storage data for this window
        await removeWindowData(windowId);
        
        debugLog('Window cleanup completed for:', windowId);
        
    } catch (error) {
        console.error('Error handling window removal:', error);
    }
}

// Handle messages from selector window with security validation
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    try {
        debugLog('Received message:', request);
        
        // Validate message structure
        if (!request || typeof request !== 'object') {
            console.warn('Invalid message format received');
            sendResponse({ success: false, error: 'Invalid message format' });
            return;
        }
        
        // Validate required fields based on action
        const validationResult = validateMessageRequest(request);
        if (!validationResult.valid) {
            console.warn('Message validation failed:', validationResult.error);
            sendResponse({ success: false, error: 'Invalid message data' });
            return;
        }
        
        switch (request.action) {
            case 'tabSelected':
                handleTabSelected(request.tabId, request.windowId, request.newTabId)
                    .then(() => sendResponse({ success: true }))
                    .catch((error) => {
                        console.error('Error handling tab selection:', error.name);
                        sendResponse({ success: false, error: 'Failed to close tab' });
                    });
                break;
                
            case 'cancelSelection':
                handleCancelSelection(request.newTabId, request.windowId)
                    .then(() => sendResponse({ success: true }))
                    .catch((error) => {
                        console.error('Error handling cancellation:', error.name);
                        sendResponse({ success: false, error: 'Failed to cancel' });
                    });
                break;
                
            default:
                console.warn('Unknown message action:', request.action);
                sendResponse({ success: false, error: 'Unknown action' });
        }
        
        // Return true to indicate async response
        return true;
        
    } catch (error) {
        console.error('Error processing message:', error.name);
        sendResponse({ success: false, error: 'Internal error' });
    }
});

// Validate message requests for security
function validateMessageRequest(request) {
    const { action, tabId, windowId, newTabId } = request;
    
    // Check action is valid
    const validActions = ['tabSelected', 'cancelSelection'];
    if (!validActions.includes(action)) {
        return { valid: false, error: 'Invalid action' };
    }
    
    // Validate IDs are safe integers
    if (tabId !== undefined && !Number.isSafeInteger(tabId)) {
        return { valid: false, error: 'Invalid tab ID' };
    }
    
    if (windowId !== undefined && !Number.isSafeInteger(windowId)) {
        return { valid: false, error: 'Invalid window ID' };
    }
    
    if (newTabId !== undefined && !Number.isSafeInteger(newTabId)) {
        return { valid: false, error: 'Invalid new tab ID' };
    }
    
    // Action-specific validation
    if (action === 'tabSelected') {
        if (!tabId || !windowId || !newTabId) {
            return { valid: false, error: 'Missing required fields for tabSelected' };
        }
    }
    
    if (action === 'cancelSelection') {
        if (!newTabId || !windowId) {
            return { valid: false, error: 'Missing required fields for cancelSelection' };
        }
    }
    
    return { valid: true };
}

// Handle tab selection from selector window
async function handleTabSelected(selectedTabId, windowId, newTabId) {
    try {
        debugLog(`User selected tab ${selectedTabId} to close, keeping new tab ${newTabId}`);
        
        // Remove the selected tab
        await chrome.tabs.remove(selectedTabId);
        debugLog(`Closed selected tab: ${selectedTabId}`);
        
        // Remove new tab from pending
        pendingTabs.delete(newTabId);
        
        // Update tab count (net zero change - one removed, one added)
        debugLog(`Tab counts remain unchanged for window ${windowId}`);
        
    } catch (error) {
        console.error('Error handling tab selection:', error);
        
        // Fallback: remove the new tab
        try {
            await chrome.tabs.remove(newTabId);
            pendingTabs.delete(newTabId);
            debugLog(`Fallback: Removed new tab ${newTabId}`);
        } catch (fallbackError) {
            console.error('Error in fallback tab removal:', fallbackError);
        }
    }
}

// Handle cancel selection from selector window
async function handleCancelSelection(newTabId, windowId) {
    try {
        debugLog(`User canceled, removing new tab ${newTabId}`);
        
        // Remove the new tab
        await chrome.tabs.remove(newTabId);
        debugLog(`Canceled: Removed new tab ${newTabId}`);
        
        // Remove from pending
        pendingTabs.delete(newTabId);
        
        // No need to update tab count as the new tab is removed
        debugLog(`Tab count unchanged for window ${windowId}`);
        
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

debugLog('Background service worker initialized');