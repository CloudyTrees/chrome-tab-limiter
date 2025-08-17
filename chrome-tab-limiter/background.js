// Background service worker for Tab Limiter extension
import { getTabLimit, removeWindowData, getGroupLimit, removeAllGroupData } from './utils/storage.js';

// Data structures to track tab counts and pending operations
const tabCounts = new Map(); // windowId -> current tab count
const groupCounts = new Map(); // windowId -> { groupId: count }
const pendingTabs = new Set(); // tabs waiting for user selection
const grandfatheredCounts = new Map(); // windowId -> grandfathered tab count for existing tabs

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

// Privacy-focused error handling - never log user data
function safeErrorLog(message, error) {
    if (DEBUG_MODE) {
        console.error(message, error?.name || 'Unknown error');
    } else {
        console.error(message);
    }
}

// Helper functions for tab group tracking
async function getTabsByGroup(windowId) {
    try {
        const tabs = await chrome.tabs.query({ windowId });
        const groups = {};
        
        tabs.forEach(tab => {
            const groupKey = tab.groupId === -1 ? 'ungrouped' : `group_${tab.groupId}`;
            if (!groups[groupKey]) {
                groups[groupKey] = [];
            }
            groups[groupKey].push(tab);
        });
        
        return groups;
    } catch (error) {
        safeErrorLog('Error getting tabs by group', error);
        return {};
    }
}

function getGroupCount(windowId, groupId) {
    const windowGroups = groupCounts.get(windowId) || {};
    return windowGroups[groupId] || 0;
}

function updateGroupCount(windowId, groupId, delta) {
    if (!groupCounts.has(windowId)) {
        groupCounts.set(windowId, {});
    }
    
    const windowGroups = groupCounts.get(windowId);
    const currentCount = windowGroups[groupId] || 0;
    const newCount = Math.max(0, currentCount + delta);
    windowGroups[groupId] = newCount;
    
    debugLog(`Window ${windowId}, Group ${groupId}: ${currentCount} -> ${newCount} tabs`);
    return newCount;
}

async function checkGroupLimit(windowId, groupId) {
    const currentCount = getGroupCount(windowId, groupId);
    const limit = await getGroupLimit(windowId, groupId);
    return currentCount >= limit;
}

// Initialize tab counts for all windows on startup
async function initializeTabCounts() {
    try {
        const windows = await chrome.windows.getAll();
        
        for (const window of windows) {
            const tabs = await chrome.tabs.query({ windowId: window.id });
            const currentCount = tabs.length;
            tabCounts.set(window.id, currentCount);
            
            // Check if current tabs exceed the limit - if so, grandfather them
            const limit = await getTabLimit(window.id);
            if (currentCount > limit) {
                grandfatheredCounts.set(window.id, currentCount);
                debugLog(`Window ${window.id}: Grandfathering ${currentCount} existing tabs (limit: ${limit})`);
            }
            
            // Initialize group counts
            const windowGroups = {};
            tabs.forEach(tab => {
                const groupId = tab.groupId === -1 ? -1 : tab.groupId;
                windowGroups[groupId] = (windowGroups[groupId] || 0) + 1;
            });
            groupCounts.set(window.id, windowGroups);
            
            debugLog(`Window ${window.id}: ${currentCount} tabs, Groups:`, Object.keys(windowGroups).length);
        }
        
        debugLog('Tab counts initialized:', Object.fromEntries(tabCounts));
        debugLog('Grandfathered counts:', Object.fromEntries(grandfatheredCounts));
    } catch (error) {
        safeErrorLog('Error initializing tab counts', error);
    }
}

// Get current tab count for a window
function getTabCount(windowId) {
    return tabCounts.get(windowId) || 0;
}

// Update tab count for a window and adjust grandfathered count if needed
async function updateTabCount(windowId, delta) {
    const currentCount = getTabCount(windowId);
    const newCount = Math.max(0, currentCount + delta);
    tabCounts.set(windowId, newCount);
    
    // Update grandfathered count when tabs are closed
    if (delta < 0 && grandfatheredCounts.has(windowId)) {
        const grandfatheredCount = grandfatheredCounts.get(windowId);
        const configuredLimit = await getTabLimit(windowId);
        
        // If we're now below the grandfathered count, adjust it down
        if (newCount < grandfatheredCount) {
            if (newCount <= configuredLimit) {
                // We've reached the configured limit - remove grandfathering
                grandfatheredCounts.delete(windowId);
                debugLog(`Window ${windowId}: Grandfathering removed - now at configured limit`);
            } else {
                // Still above limit but below grandfathered count - adjust grandfathering down
                grandfatheredCounts.set(windowId, newCount);
                debugLog(`Window ${windowId}: Grandfathered count adjusted to ${newCount}`);
            }
        }
    }
    
    debugLog(`Window ${windowId}: ${currentCount} -> ${newCount} tabs`);
    return newCount;
}

// Check if adding a tab would exceed the limit (accounting for grandfathered tabs)
async function wouldExceedLimit(windowId) {
    const currentCount = getTabCount(windowId);
    const configuredLimit = await getTabLimit(windowId);
    const grandfatheredCount = grandfatheredCounts.get(windowId);
    
    // Use the higher of configured limit or grandfathered count as effective limit
    const effectiveLimit = grandfatheredCount ? Math.max(configuredLimit, grandfatheredCount) : configuredLimit;
    
    return currentCount >= effectiveLimit;
}

// Store selector state for popup access
const selectorState = {
    isActive: false,
    windowId: null,
    mode: null,
    newTabUrl: null,
    newTabId: null
};

// Open tab selector for replacement (when new tab was already removed)
async function openTabSelectorForReplacement(windowId, newTabUrl) {
    try {
        // Rate limiting check
        if (!rateLimiter.isAllowed('selectorOpen')) {
            console.warn('Selector opening rate limited');
            return;
        }
        
        debugLog(`LIMIT EXCEEDED: Setting up popup selector for window ${windowId} to replace: ${newTabUrl}`);
        
        // Store state for popup access
        selectorState.isActive = true;
        selectorState.windowId = windowId;
        selectorState.mode = 'replace';
        selectorState.newTabUrl = newTabUrl;
        selectorState.newTabId = null;
        
        // Open the extension popup
        await chrome.action.openPopup();
        
        debugLog(`Selector popup triggered for window ${windowId}`);
        return true;
        
    } catch (error) {
        console.error('Error opening replacement tab selector:', error);
        debugLog('Failed to trigger selector popup:', error.message);
    }
}

// Open tab selector window (legacy mode - for existing tabs)
async function openTabSelector(windowId, newTabId) {
    try {
        // Rate limiting check
        if (!rateLimiter.isAllowed('selectorOpen')) {
            console.warn('Selector opening rate limited - closing new tab');
            await chrome.tabs.remove(newTabId);
            return;
        }
        
        debugLog('Rate limiting passed, creating selector window...');
        
        debugLog(`LIMIT EXCEEDED: Opening tab selector for window ${windowId}`);
        
        // Create selector popup window with simplified positioning
        const selectorUrl = chrome.runtime.getURL(`selector.html?windowId=${windowId}&newTabId=${newTabId}`);
        debugLog('Creating window with URL:', selectorUrl);
        
        const popup = await chrome.windows.create({
            url: selectorUrl,
            type: 'popup',
            width: 400,
            height: 500,
            // Let Chrome position the window automatically instead of using display API
            focused: true
        });
        
        debugLog(`Tab selector window created: ${popup.id}`);
        return popup.id;
        
    } catch (error) {
        console.error('Error opening tab selector:', error);
        debugLog('Failed to create selector window:', error.message);
        
        // Fallback: just close the new tab
        try {
            await chrome.tabs.remove(newTabId);
            debugLog('Fallback: Closed new tab');
        } catch (removeError) {
            safeErrorLog('Error removing tab in fallback', removeError);
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
        
        debugLog(`Tab created in window ${tab.windowId}, group ${tab.groupId || 'ungrouped'}`);
        
        // Get current counts for debugging
        const currentTabCount = getTabCount(tab.windowId);
        const tabLimit = await getTabLimit(tab.windowId);
        debugLog(`Current tabs: ${currentTabCount}, Limit: ${tabLimit}`);
        
        // Check if limit would be exceeded (before counting the new tab)
        const wouldExceedGroupLimit = await checkGroupLimit(tab.windowId, tab.groupId === -1 ? -1 : tab.groupId);
        const wouldExceedWindowLimit = await wouldExceedLimit(tab.windowId);
        
        if (wouldExceedGroupLimit || wouldExceedWindowLimit) {
            const limitType = wouldExceedGroupLimit ? 'group' : 'window';
            debugLog(`Tab creation would exceed ${limitType} limit for window ${tab.windowId}`);
            
            // IMMEDIATELY remove the new tab to enforce limit
            await chrome.tabs.remove(tab.id);
            debugLog(`Removed new tab ${tab.id} due to limit violation`);
            
            // Store the URL that was being opened so we can recreate it later
            const newTabUrl = tab.url || tab.pendingUrl || 'chrome://newtab/';
            
            // Open selector to choose which existing tab to close
            await openTabSelectorForReplacement(tab.windowId, newTabUrl);
            
            // Don't update counts - the tab was removed
            return;
        }
        
        // Update both counts
        await updateTabCount(tab.windowId, 1);
        updateGroupCount(tab.windowId, tab.groupId === -1 ? -1 : tab.groupId, 1);
        
    } catch (error) {
        safeErrorLog('Error handling tab creation', error);
    }
}

// Handle tab removal
async function handleTabRemoved(tabId, removeInfo) {
    try {
        debugLog(`Tab removed from window ${removeInfo.windowId}`);
        
        // Remove from pending tabs if it was pending
        pendingTabs.delete(tabId);
        
        // Update counts (only if window still exists)
        if (!removeInfo.isWindowClosing) {
            await updateTabCount(removeInfo.windowId, -1);
            
            // For group count, we need to find which group the tab was in
            // This is tricky since the tab is already removed
            // We'll update all group counts to be safe
            try {
                const tabs = await chrome.tabs.query({ windowId: removeInfo.windowId });
                const windowGroups = {};
                tabs.forEach(tab => {
                    const groupId = tab.groupId === -1 ? -1 : tab.groupId;
                    windowGroups[groupId] = (windowGroups[groupId] || 0) + 1;
                });
                groupCounts.set(removeInfo.windowId, windowGroups);
            } catch (error) {
                // Fallback: just decrement ungrouped count
                updateGroupCount(removeInfo.windowId, -1, -1);
            }
        }
        
    } catch (error) {
        safeErrorLog('Error handling tab removal', error);
    }
}

// Handle window removal
async function handleWindowRemoved(windowId) {
    try {
        debugLog(`Window removed: ${windowId}`);
        
        // Clean up tab count tracking
        tabCounts.delete(windowId);
        groupCounts.delete(windowId);
        grandfatheredCounts.delete(windowId);
        
        // Clean up storage data for this window
        await removeWindowData(windowId);
        await removeAllGroupData(windowId);
        
        debugLog('Window cleanup completed for:', windowId);
        
    } catch (error) {
        safeErrorLog('Error handling window removal', error);
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
            console.warn('Message validation failed');
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
            
            case 'tabSelectedForReplacement':
                handleTabSelectedForReplacement(request.tabId, request.windowId, request.newTabUrl)
                    .then(() => sendResponse({ success: true }))
                    .catch((error) => {
                        console.error('Error handling replacement tab selection:', error.name);
                        sendResponse({ success: false, error: 'Failed to replace tab' });
                    });
                break;
                
            case 'cancelReplacement':
                handleCancelReplacement(request.windowId)
                    .then(() => sendResponse({ success: true }))
                    .catch((error) => {
                        console.error('Error handling replacement cancellation:', error.name);
                        sendResponse({ success: false, error: 'Failed to cancel replacement' });
                    });
                break;
            
            case 'getGrandfatheredStatus':
                const grandfatheredCount = grandfatheredCounts.get(request.windowId);
                sendResponse({ 
                    success: true, 
                    isGrandfathered: !!grandfatheredCount,
                    grandfatheredCount: grandfatheredCount || 0
                });
                break;
            
            case 'getSelectorState':
                sendResponse({
                    success: true,
                    selectorState: selectorState
                });
                break;
                
            case 'clearSelectorState':
                selectorState.isActive = false;
                selectorState.windowId = null;
                selectorState.mode = null;
                selectorState.newTabUrl = null;
                selectorState.newTabId = null;
                sendResponse({ success: true });
                break;
                
            default:
                console.warn('Unknown message action received');
                sendResponse({ success: false, error: 'Unknown action' });
        }
        
        // Return true to indicate async response
        return true;
        
    } catch (error) {
        safeErrorLog('Error processing message', error);
        sendResponse({ success: false, error: 'Internal error' });
    }
});

// Validate message requests for security
function validateMessageRequest(request) {
    const { action, tabId, windowId, newTabId } = request;
    
    // Check action is valid
    const validActions = ['tabSelected', 'cancelSelection', 'tabSelectedForReplacement', 'cancelReplacement', 'getGrandfatheredStatus', 'getSelectorState', 'clearSelectorState'];
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
    
    if (action === 'tabSelectedForReplacement') {
        if (!tabId || !windowId || !request.newTabUrl) {
            return { valid: false, error: 'Missing required fields for tabSelectedForReplacement' };
        }
    }
    
    if (action === 'cancelReplacement') {
        if (!windowId) {
            return { valid: false, error: 'Missing required fields for cancelReplacement' };
        }
    }
    
    return { valid: true };
}

// Handle tab selection from selector window
async function handleTabSelected(selectedTabId, windowId, newTabId) {
    try {
        debugLog('User selected tab to close');
        
        // Remove the selected tab
        await chrome.tabs.remove(selectedTabId);
        debugLog('Closed selected tab');
        
        // Remove new tab from pending
        pendingTabs.delete(newTabId);
        
        // Update tab count (net zero change - one removed, one added)
        debugLog(`Tab counts remain unchanged for window ${windowId}`);
        
    } catch (error) {
        safeErrorLog('Error handling tab selection', error);
        
        // Fallback: remove the new tab
        try {
            await chrome.tabs.remove(newTabId);
            pendingTabs.delete(newTabId);
            debugLog('Fallback: Removed new tab');
        } catch (fallbackError) {
            safeErrorLog('Error in fallback tab removal', fallbackError);
        }
    }
}

// Handle cancel selection from selector window
async function handleCancelSelection(newTabId, windowId) {
    try {
        debugLog('User canceled, removing new tab');
        
        // Remove the new tab
        await chrome.tabs.remove(newTabId);
        debugLog('Canceled: Removed new tab');
        
        // Remove from pending
        pendingTabs.delete(newTabId);
        
        // No need to update tab count as the new tab is removed
        debugLog(`Tab count unchanged for window ${windowId}`);
        
    } catch (error) {
        safeErrorLog('Error handling cancel selection', error);
    }
}

// Handle tab selection for replacement from selector window
async function handleTabSelectedForReplacement(selectedTabId, windowId, newTabUrl) {
    try {
        debugLog('User selected tab to close for replacement');
        
        // Remove the selected tab
        await chrome.tabs.remove(selectedTabId);
        debugLog('Closed selected tab for replacement');
        
        // Create the new tab with the requested URL
        const newTab = await chrome.tabs.create({
            windowId: windowId,
            url: newTabUrl,
            active: true
        });
        debugLog(`Created replacement tab ${newTab.id} with URL: ${newTabUrl}`);
        
        // Tab counts remain the same (one removed, one added)
        debugLog(`Tab counts remain unchanged for window ${windowId}`);
        
    } catch (error) {
        safeErrorLog('Error handling replacement tab selection', error);
        throw error; // Re-throw to show error in selector
    }
}

// Handle cancel replacement from selector window
async function handleCancelReplacement(windowId) {
    try {
        debugLog('User canceled replacement - no action needed');
        
        // In replacement mode, the new tab was already removed
        // Nothing else to do
        debugLog(`No tab changes for window ${windowId} - replacement canceled`);
        
    } catch (error) {
        safeErrorLog('Error handling cancel replacement', error);
    }
}

// Handle tab updates (including group changes)
async function handleTabUpdated(tabId, changeInfo, tab) {
    try {
        // Only care about group changes
        if (changeInfo.groupId !== undefined) {
            debugLog(`Tab ${tabId} moved to group ${changeInfo.groupId}`);
            
            // Recalculate group counts for this window to ensure accuracy
            const tabs = await chrome.tabs.query({ windowId: tab.windowId });
            const windowGroups = {};
            tabs.forEach(t => {
                const groupId = t.groupId === -1 ? -1 : t.groupId;
                windowGroups[groupId] = (windowGroups[groupId] || 0) + 1;
            });
            groupCounts.set(tab.windowId, windowGroups);
        }
    } catch (error) {
        safeErrorLog('Error handling tab update', error);
    }
}

// Set up event listeners
chrome.tabs.onCreated.addListener(handleTabCreated);
chrome.tabs.onRemoved.addListener(handleTabRemoved);
chrome.tabs.onUpdated.addListener(handleTabUpdated);
chrome.windows.onRemoved.addListener(handleWindowRemoved);

// Initialize on service worker startup
initializeTabCounts();

debugLog('Background service worker initialized');