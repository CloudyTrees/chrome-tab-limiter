// Popup script for Tab Limiter extension

// Import storage functions (note: in Chrome extensions, import/export works differently)
// We'll access the storage functions directly from chrome.storage

// DOM elements
let currentTabCountElement;
let currentLimitElement;
let tabLimitInput;
let defaultLimitInput;
let saveButton;
let saveDefaultButton;
let refreshButton;
let statusMessage;

// Current window ID
let currentWindowId = null;

// Initialize popup when DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
    console.log('Tab Limiter popup initializing...');
    
    // Get DOM elements
    currentTabCountElement = document.getElementById('currentTabCount');
    currentLimitElement = document.getElementById('currentLimit');
    tabLimitInput = document.getElementById('tabLimitInput');
    defaultLimitInput = document.getElementById('defaultLimitInput');
    saveButton = document.getElementById('saveButton');
    saveDefaultButton = document.getElementById('saveDefaultButton');
    refreshButton = document.getElementById('refreshButton');
    statusMessage = document.getElementById('statusMessage');
    
    // Set up event listeners
    saveButton.addEventListener('click', handleSaveTabLimit);
    saveDefaultButton.addEventListener('click', handleSaveDefaultLimit);
    refreshButton.addEventListener('click', handleRefresh);
    
    // Add input validation
    tabLimitInput.addEventListener('input', validateTabLimitInput);
    defaultLimitInput.addEventListener('input', validateDefaultLimitInput);
    
    // Initial data load
    await loadInitialData();
    
    console.log('Tab Limiter popup initialized');
});

// Load initial data for the popup
async function loadInitialData() {
    try {
        showMessage('Loading...', 'info');
        
        // Get current window
        const currentWindow = await chrome.windows.getCurrent();
        currentWindowId = currentWindow.id;
        
        // Load current tab count
        await updateTabCount();
        
        // Load current limits
        await loadLimits();
        
        showMessage('Data loaded successfully', 'success');
        setTimeout(() => clearMessage(), 2000);
        
    } catch (error) {
        console.error('Error loading initial data:', error);
        showMessage('Error loading data', 'error');
    }
}

// Update the current tab count display
async function updateTabCount() {
    try {
        const tabs = await chrome.tabs.query({ windowId: currentWindowId });
        const tabCount = tabs.length;
        
        currentTabCountElement.textContent = tabCount;
        
        return tabCount;
    } catch (error) {
        console.error('Error updating tab count:', error);
        currentTabCountElement.textContent = 'Error';
        return 0;
    }
}

// Load current limits from storage
async function loadLimits() {
    try {
        // Get current window limit
        const windowLimitKey = `tabLimit_${currentWindowId}`;
        const result = await chrome.storage.sync.get([windowLimitKey, 'defaultTabLimit']);
        
        const currentLimit = result[windowLimitKey] || result.defaultTabLimit || 10;
        const defaultLimit = result.defaultTabLimit || 10;
        
        // Update display
        currentLimitElement.textContent = currentLimit;
        
        // Update input fields
        tabLimitInput.value = currentLimit;
        defaultLimitInput.value = defaultLimit;
        
    } catch (error) {
        console.error('Error loading limits:', error);
        currentLimitElement.textContent = 'Error';
        showMessage('Error loading limits', 'error');
    }
}

// Handle saving tab limit for current window
async function handleSaveTabLimit() {
    try {
        const limit = parseInt(tabLimitInput.value);
        
        if (!validateLimit(limit)) {
            showMessage('Please enter a valid limit (1-100)', 'error');
            return;
        }
        
        saveButton.disabled = true;
        showMessage('Saving...', 'info');
        
        // Save to storage
        const windowLimitKey = `tabLimit_${currentWindowId}`;
        await chrome.storage.sync.set({ [windowLimitKey]: limit });
        
        // Update display
        currentLimitElement.textContent = limit;
        
        showMessage('Tab limit saved successfully', 'success');
        setTimeout(() => clearMessage(), 2000);
        
    } catch (error) {
        console.error('Error saving tab limit:', error);
        showMessage('Error saving tab limit', 'error');
    } finally {
        saveButton.disabled = false;
    }
}

// Handle saving default limit for new windows
async function handleSaveDefaultLimit() {
    try {
        const limit = parseInt(defaultLimitInput.value);
        
        if (!validateLimit(limit)) {
            showMessage('Please enter a valid default limit (1-100)', 'error');
            return;
        }
        
        saveDefaultButton.disabled = true;
        showMessage('Saving default...', 'info');
        
        // Save to storage
        await chrome.storage.sync.set({ defaultTabLimit: limit });
        
        showMessage('Default limit saved successfully', 'success');
        setTimeout(() => clearMessage(), 2000);
        
    } catch (error) {
        console.error('Error saving default limit:', error);
        showMessage('Error saving default limit', 'error');
    } finally {
        saveDefaultButton.disabled = false;
    }
}

// Handle refresh button click
async function handleRefresh() {
    try {
        refreshButton.disabled = true;
        showMessage('Refreshing...', 'info');
        
        await loadInitialData();
        
    } catch (error) {
        console.error('Error refreshing data:', error);
        showMessage('Error refreshing data', 'error');
    } finally {
        refreshButton.disabled = false;
    }
}

// Validate limit value
function validateLimit(limit) {
    return Number.isInteger(limit) && limit >= 1 && limit <= 100;
}

// Validate tab limit input
function validateTabLimitInput() {
    const value = parseInt(tabLimitInput.value);
    const isValid = validateLimit(value);
    
    saveButton.disabled = !isValid;
    
    if (tabLimitInput.value && !isValid) {
        tabLimitInput.style.borderColor = '#ea4335';
    } else {
        tabLimitInput.style.borderColor = '#dadce0';
    }
}

// Validate default limit input
function validateDefaultLimitInput() {
    const value = parseInt(defaultLimitInput.value);
    const isValid = validateLimit(value);
    
    saveDefaultButton.disabled = !isValid;
    
    if (defaultLimitInput.value && !isValid) {
        defaultLimitInput.style.borderColor = '#ea4335';
    } else {
        defaultLimitInput.style.borderColor = '#dadce0';
    }
}

// Show status message
function showMessage(message, type = 'info') {
    statusMessage.textContent = message;
    statusMessage.className = `status-message ${type}`;
}

// Clear status message
function clearMessage() {
    statusMessage.textContent = '';
    statusMessage.className = 'status-message';
}

// Handle keyboard shortcuts
document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        if (document.activeElement === tabLimitInput) {
            handleSaveTabLimit();
        } else if (document.activeElement === defaultLimitInput) {
            handleSaveDefaultLimit();
        }
    }
});