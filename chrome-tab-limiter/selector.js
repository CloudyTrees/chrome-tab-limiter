// Selector window script for Tab Limiter extension

// Global variables
let windowId = null;
let newTabId = null;
let allTabs = [];
let selectedTabId = null;
let currentFocusIndex = -1;

// DOM elements
let tabListElement;
let confirmButton;
let cancelButton;
let tabLimitElement;

// Initialize selector window when DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
    console.log('Tab selector initializing...');
    
    // Get DOM elements
    tabListElement = document.getElementById('tabList');
    confirmButton = document.getElementById('confirmButton');
    cancelButton = document.getElementById('cancelButton');
    tabLimitElement = document.getElementById('tabLimit');
    
    // Set up event listeners
    confirmButton.addEventListener('click', handleConfirm);
    cancelButton.addEventListener('click', handleCancel);
    
    // Set up keyboard navigation
    document.addEventListener('keydown', handleKeyNavigation);
    
    // Get parameters from URL
    const params = new URLSearchParams(window.location.search);
    windowId = parseInt(params.get('windowId'));
    newTabId = parseInt(params.get('newTabId'));
    
    if (!windowId || !newTabId) {
        console.error('Missing required parameters: windowId or newTabId');
        showError('Invalid parameters provided');
        return;
    }
    
    console.log(`Selector opened for window ${windowId}, new tab ${newTabId}`);
    
    // Load tabs and display
    await loadAndDisplayTabs();
    
    console.log('Tab selector initialized');
});

// Load tabs for the current window and display them
async function loadAndDisplayTabs() {
    try {
        // Get all tabs in the window
        const tabs = await chrome.tabs.query({ windowId: windowId });
        
        // Filter out the new tab
        allTabs = tabs.filter(tab => tab.id !== newTabId);
        
        console.log(`Found ${allTabs.length} tabs to display (excluding new tab)`);
        
        // Get the tab limit for this window
        await loadTabLimit();
        
        // Display the tabs
        displayTabs(allTabs);
        
    } catch (error) {
        console.error('Error loading tabs:', error);
        showError('Failed to load tabs');
    }
}

// Load and display the tab limit
async function loadTabLimit() {
    try {
        const windowLimitKey = `tabLimit_${windowId}`;
        const result = await chrome.storage.sync.get([windowLimitKey, 'defaultTabLimit']);
        
        const limit = result[windowLimitKey] || result.defaultTabLimit || 10;
        tabLimitElement.textContent = limit;
        
    } catch (error) {
        console.error('Error loading tab limit:', error);
        tabLimitElement.textContent = '--';
    }
}

// Display tabs in the list
function displayTabs(tabs) {
    // Clear loading state
    tabListElement.innerHTML = '';
    
    if (tabs.length === 0) {
        showError('No tabs found to display');
        return;
    }
    
    // Create tab items
    tabs.forEach((tab, index) => {
        const tabItem = createTabItem(tab, index);
        tabListElement.appendChild(tabItem);
    });
    
    // Focus first item
    if (tabs.length > 0) {
        currentFocusIndex = 0;
        updateKeyboardFocus();
    }
}

// Create a tab item element
function createTabItem(tab, index) {
    const tabItem = document.createElement('div');
    tabItem.className = 'tab-item';
    tabItem.dataset.tabId = tab.id;
    tabItem.dataset.index = index;
    
    const radioId = `tab-${tab.id}`;
    
    // Create favicon element
    const faviconElement = createFaviconElement(tab);
    
    // Truncate title and URL for display
    const title = tab.title || 'Untitled';
    const url = getDisplayUrl(tab.url);
    
    tabItem.innerHTML = `
        <input type="radio" name="tab" id="${radioId}" value="${tab.id}">
        <label for="${radioId}">
            ${faviconElement}
            <div class="tab-info">
                <div class="tab-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
                <div class="tab-url" title="${escapeHtml(tab.url)}">${escapeHtml(url)}</div>
            </div>
        </label>
    `;
    
    // Add click handler
    const radio = tabItem.querySelector('input[type="radio"]');
    radio.addEventListener('change', () => handleTabSelection(tab.id, index));
    
    return tabItem;
}

// Create favicon element with fallback
function createFaviconElement(tab) {
    if (tab.favIconUrl && !tab.favIconUrl.startsWith('chrome://')) {
        return `<img src="${escapeHtml(tab.favIconUrl)}" class="favicon" alt="favicon">`;
    } else {
        // Use default icon
        return '<div class="favicon default">🌐</div>';
    }
}

// Get display-friendly URL
function getDisplayUrl(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.hostname || url;
    } catch (error) {
        return url;
    }
}

// Handle tab selection
function handleTabSelection(tabId, index) {
    selectedTabId = tabId;
    currentFocusIndex = index;
    
    // Enable confirm button
    confirmButton.disabled = false;
    
    console.log(`Tab selected: ${tabId}`);
}

// Handle confirm button click
async function handleConfirm() {
    if (!selectedTabId) {
        console.error('No tab selected');
        return;
    }
    
    try {
        confirmButton.disabled = true;
        confirmButton.textContent = 'Closing...';
        
        console.log(`Sending message to close tab ${selectedTabId}`);
        
        // Send message to background script
        await chrome.runtime.sendMessage({
            action: 'tabSelected',
            tabId: selectedTabId,
            windowId: windowId,
            newTabId: newTabId
        });
        
        // Close this selector window
        window.close();
        
    } catch (error) {
        console.error('Error closing tab:', error);
        confirmButton.disabled = false;
        confirmButton.textContent = 'Close Selected Tab';
        showError('Failed to close tab');
    }
}

// Handle cancel button click
async function handleCancel() {
    try {
        cancelButton.disabled = true;
        cancelButton.textContent = 'Canceling...';
        
        console.log(`Sending message to cancel and close new tab ${newTabId}`);
        
        // Send message to background script
        await chrome.runtime.sendMessage({
            action: 'cancelSelection',
            newTabId: newTabId,
            windowId: windowId
        });
        
        // Close this selector window
        window.close();
        
    } catch (error) {
        console.error('Error canceling:', error);
        cancelButton.disabled = false;
        cancelButton.textContent = 'Cancel (Close New Tab)';
        showError('Failed to cancel');
    }
}

// Handle keyboard navigation
function handleKeyNavigation(event) {
    const tabItems = document.querySelectorAll('.tab-item');
    
    switch (event.key) {
        case 'ArrowDown':
        case 'ArrowRight':
            event.preventDefault();
            if (currentFocusIndex < tabItems.length - 1) {
                currentFocusIndex++;
                updateKeyboardFocus();
            }
            break;
            
        case 'ArrowUp':
        case 'ArrowLeft':
            event.preventDefault();
            if (currentFocusIndex > 0) {
                currentFocusIndex--;
                updateKeyboardFocus();
            }
            break;
            
        case 'Enter':
        case ' ':
            event.preventDefault();
            if (currentFocusIndex >= 0 && currentFocusIndex < tabItems.length) {
                const radio = tabItems[currentFocusIndex].querySelector('input[type="radio"]');
                radio.checked = true;
                const tabId = parseInt(radio.value);
                handleTabSelection(tabId, currentFocusIndex);
            }
            break;
            
        case 'Escape':
            event.preventDefault();
            handleCancel();
            break;
            
        case 'Enter':
            if (event.target === confirmButton || (selectedTabId && !event.target.matches('input, button'))) {
                event.preventDefault();
                handleConfirm();
            }
            break;
    }
}

// Update keyboard focus visual indicator
function updateKeyboardFocus() {
    const tabItems = document.querySelectorAll('.tab-item');
    
    // Remove focus from all items
    tabItems.forEach(item => item.classList.remove('keyboard-focus'));
    
    // Add focus to current item
    if (currentFocusIndex >= 0 && currentFocusIndex < tabItems.length) {
        const currentItem = tabItems[currentFocusIndex];
        currentItem.classList.add('keyboard-focus');
        
        // Scroll into view if needed
        currentItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}

// Show error message
function showError(message) {
    tabListElement.innerHTML = `
        <div class="error-message" style="
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: #d93025;
            text-align: center;
            padding: 20px;
        ">
            <div style="font-size: 24px; margin-bottom: 12px;">❌</div>
            <div style="font-weight: 500; margin-bottom: 8px;">Error</div>
            <div style="font-size: 12px; color: #5f6368;">${escapeHtml(message)}</div>
        </div>
    `;
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}