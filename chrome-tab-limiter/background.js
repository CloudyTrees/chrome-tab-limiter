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

// Placeholder function to open tab selector window
async function openTabSelector(windowId) {
    console.log(`LIMIT EXCEEDED: Window ${windowId} has reached its tab limit`);
    console.log(`Would open tab selector for window ${windowId}`);
    
    // TODO: Implement actual tab selector window
    // For now, just log the event
    const tabs = await chrome.tabs.query({ windowId });
    console.log('Current tabs in window:', tabs.map(tab => ({ id: tab.id, title: tab.title, url: tab.url })));
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
            
            // Open selector (placeholder for now)
            await openTabSelector(tab.windowId);
            
            // For now, just allow the tab but log the event
            // In full implementation, we would prevent the tab creation
            // and wait for user selection
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

// Set up event listeners
chrome.tabs.onCreated.addListener(handleTabCreated);
chrome.tabs.onRemoved.addListener(handleTabRemoved);
chrome.windows.onRemoved.addListener(handleWindowRemoved);

// Initialize on service worker startup
initializeTabCounts();

console.log('Tab Limiter background service worker initialized');