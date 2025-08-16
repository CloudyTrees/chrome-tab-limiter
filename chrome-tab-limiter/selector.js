// Selector window script for Tab Limiter extension

// Debug logging configuration
const DEBUG_MODE = false; // Set to false in production

function debugLog(...args) {
    if (DEBUG_MODE) {
        console.log('[Tab Limiter Selector]', ...args);
    }
}

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
    debugLog('Selector initializing...');

// Privacy-focused error handling - never log user data
function safeErrorLog(message, error) {
    if (DEBUG_MODE) {
        console.error(message, error?.name || 'Unknown error');
    } else {
        console.error(message);
    }
}
    
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
        safeErrorLog('Missing required parameters');
        showError('Invalid parameters provided');
        return;
    }
    
    debugLog(`Selector opened for window ${windowId}`);
    
    // Load tabs and display
    await loadAndDisplayTabs();
    
    debugLog('Selector initialized');
});

// Load tabs for the current window and display them
async function loadAndDisplayTabs() {
    try {
        // Get all tabs in the window
        const tabs = await chrome.tabs.query({ windowId: windowId });
        
        // Filter out the new tab
        allTabs = tabs.filter(tab => tab.id !== newTabId);
        
        debugLog(`Found ${allTabs.length} tabs to display (excluding new tab)`);
        
        // Get the tab limit for this window
        await loadTabLimit();
        
        // Display the tabs
        displayTabs(allTabs);
        
    } catch (error) {
        safeErrorLog('Error loading tabs', error);
        showError('Failed to load tabs');
    }
}

// Load and display the tab limit
async function loadTabLimit() {
    try {
        const windowLimitKey = `tabLimit_${windowId}`;
        const result = await chrome.storage.local.get([windowLimitKey, 'defaultTabLimit']);
        
        const limit = result[windowLimitKey] || result.defaultTabLimit || 10;
        tabLimitElement.textContent = limit;
        
    } catch (error) {
        safeErrorLog('Error loading tab limit', error);
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
    
    // Sanitize and truncate title and URL for display
    const title = sanitizeTabTitle(tab.title);
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
    if (tab.favIconUrl && isValidFaviconUrl(tab.favIconUrl)) {
        return `<img src="${escapeHtml(tab.favIconUrl)}" class="favicon" alt="favicon" onerror="this.style.display='none';this.nextElementSibling.style.display='block';">
                <div class="favicon default" style="display:none;">🌐</div>`;
    } else {
        // Use default icon
        return '<div class="favicon default">🌐</div>';
    }
}

// Validate favicon URLs to prevent malicious content
function isValidFaviconUrl(url) {
    try {
        const urlObj = new URL(url);
        
        // Only allow specific schemes
        const allowedSchemes = ['http:', 'https:', 'data:', 'chrome://'];
        if (!allowedSchemes.includes(urlObj.protocol)) {
            return false;
        }
        
        // Block chrome:// URLs except favicon
        if (urlObj.protocol === 'chrome:' && !url.startsWith('chrome://favicon/')) {
            return false;
        }
        
        // For data URLs, only allow image types
        if (urlObj.protocol === 'data:') {
            const mimeMatch = url.match(/^data:([^;]+)/);
            if (!mimeMatch || !mimeMatch[1].startsWith('image/')) {
                return false;
            }
        }
        
        // Basic length check to prevent excessively long URLs
        if (url.length > 2048) {
            return false;
        }
        
        return true;
    } catch (error) {
        return false;
    }
}

// Get display-friendly URL with security validation
function getDisplayUrl(url) {
    try {
        // Validate URL first
        if (!isValidDisplayUrl(url)) {
            return '[Invalid URL]';
        }
        
        const urlObj = new URL(url);
        return urlObj.hostname || '[Unknown Host]';
    } catch (error) {
        return '[Invalid URL]';
    }
}

// Validate URLs before displaying to prevent malicious content
function isValidDisplayUrl(url) {
    try {
        const urlObj = new URL(url);
        
        // Only allow standard web schemes and some chrome schemes
        const allowedSchemes = ['http:', 'https:', 'file:', 'ftp:', 'chrome:', 'chrome-extension:'];
        if (!allowedSchemes.includes(urlObj.protocol)) {
            return false;
        }
        
        // Basic length check
        if (url.length > 2048) {
            return false;
        }
        
        // Don't allow URLs with suspicious characters that could be used for homograph attacks
        const suspiciousPattern = /[\u0000-\u001f\u007f-\u009f\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/;
        if (suspiciousPattern.test(url)) {
            return false;
        }
        
        return true;
    } catch (error) {
        return false;
    }
}

// Handle tab selection
function handleTabSelection(tabId, index) {
    selectedTabId = tabId;
    currentFocusIndex = index;
    
    // Enable confirm button
    confirmButton.disabled = false;
    
    debugLog('Tab selected');
}

// Handle confirm button click
async function handleConfirm() {
    if (!selectedTabId) {
        safeErrorLog('No tab selected');
        return;
    }
    
    try {
        confirmButton.disabled = true;
        confirmButton.textContent = 'Closing...';
        
        debugLog('Sending message to close selected tab');
        
        // Send message to background script with error handling
        const response = await chrome.runtime.sendMessage({
            action: 'tabSelected',
            tabId: selectedTabId,
            windowId: windowId,
            newTabId: newTabId
        });
        
        if (!response || !response.success) {
            throw new Error(response?.error || 'Failed to close tab');
        }
        
        // Close this selector window
        window.close();
        
    } catch (error) {
        safeErrorLog('Error closing tab', error);
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
        
        debugLog('Sending message to cancel and close new tab');
        
        // Send message to background script with error handling
        const response = await chrome.runtime.sendMessage({
            action: 'cancelSelection',
            newTabId: newTabId,
            windowId: windowId
        });
        
        if (!response || !response.success) {
            throw new Error(response?.error || 'Failed to cancel');
        }
        
        // Close this selector window
        window.close();
        
    } catch (error) {
        safeErrorLog('Error canceling', error);
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

// Enhanced HTML escaping and input sanitization to prevent XSS
function escapeHtml(text) {
    if (typeof text !== 'string') {
        text = String(text);
    }
    
    // Limit length to prevent DoS
    if (text.length > 1000) {
        text = text.substring(0, 997) + '...';
    }
    
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Sanitize tab titles for display
function sanitizeTabTitle(title) {
    if (!title || typeof title !== 'string') {
        return 'Untitled';
    }
    
    // Remove control characters and other problematic characters
    const sanitized = title
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
        .replace(/[\u200B-\u200D\uFEFF]/g, '') // Zero-width characters
        .trim();
    
    // Limit length
    if (sanitized.length > 100) {
        return sanitized.substring(0, 97) + '...';
    }
    
    return sanitized || 'Untitled';
}