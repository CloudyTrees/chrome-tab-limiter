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

// Display tabs in the list, organized by groups
async function displayTabs(tabs) {
    // Clear loading state
    tabListElement.innerHTML = '';
    
    if (tabs.length === 0) {
        showError('No tabs found to display');
        return;
    }
    
    try {
        // Get group information
        const groups = await chrome.tabGroups.query({ windowId: windowId });
        const groupMap = new Map();
        groups.forEach(group => groupMap.set(group.id, group));
        
        // Organize tabs by group
        const groupedTabs = organizeTabs(tabs, groupMap);
        
        // Display grouped tabs
        let tabIndex = 0;
        for (const [groupKey, groupData] of groupedTabs) {
            // Add group header if it's a real group
            if (groupKey !== 'ungrouped') {
                const groupHeader = createGroupHeader(groupData.group);
                tabListElement.appendChild(groupHeader);
            } else if (groupedTabs.size > 1) {
                // Only show ungrouped header if there are also grouped tabs
                const ungroupedHeader = createUngroupedHeader(groupData.tabs.length);
                tabListElement.appendChild(ungroupedHeader);
            }
            
            // Add tabs in this group
            groupData.tabs.forEach(tab => {
                const tabItem = createTabItem(tab, tabIndex);
                tabListElement.appendChild(tabItem);
                tabIndex++;
            });
            
            // Add separator between groups (except for last group)
            if (groupKey !== Array.from(groupedTabs.keys()).pop() && groupedTabs.size > 1) {
                const separator = document.createElement('div');
                separator.className = 'group-separator';
                tabListElement.appendChild(separator);
            }
        }
        
        // Focus first item
        if (tabs.length > 0) {
            currentFocusIndex = 0;
            updateKeyboardFocus();
        }
        
    } catch (error) {
        debugLog('Error organizing tabs by groups, falling back to simple list');
        // Fallback to simple list
        tabs.forEach((tab, index) => {
            const tabItem = createTabItem(tab, index);
            tabListElement.appendChild(tabItem);
        });
        
        if (tabs.length > 0) {
            currentFocusIndex = 0;
            updateKeyboardFocus();
        }
    }
}

// Organize tabs by groups
function organizeTabs(tabs, groupMap) {
    const organized = new Map();
    
    tabs.forEach(tab => {
        let groupKey, groupData;
        
        if (tab.groupId === -1) {
            groupKey = 'ungrouped';
            if (!organized.has(groupKey)) {
                organized.set(groupKey, { 
                    tabs: [], 
                    group: null 
                });
            }
        } else {
            groupKey = `group_${tab.groupId}`;
            if (!organized.has(groupKey)) {
                organized.set(groupKey, { 
                    tabs: [], 
                    group: groupMap.get(tab.groupId) || null 
                });
            }
        }
        
        organized.get(groupKey).tabs.push(tab);
    });
    
    // Sort: grouped tabs first, then ungrouped
    const sorted = new Map();
    
    // Add grouped tabs first
    for (const [key, data] of organized) {
        if (key !== 'ungrouped') {
            sorted.set(key, data);
        }
    }
    
    // Add ungrouped tabs last
    if (organized.has('ungrouped')) {
        sorted.set('ungrouped', organized.get('ungrouped'));
    }
    
    return sorted;
}

// Create group header element
function createGroupHeader(group) {
    const header = document.createElement('div');
    header.className = 'group-header';
    
    const color = getGroupColor(group?.color || 'grey');
    const title = group?.title || `Group ${group?.id || ''}`;
    
    const headerContent = document.createElement('div');\n    headerContent.className = 'group-header-content';\n    \n    const colorDiv = document.createElement('div');\n    colorDiv.className = 'group-color';\n    colorDiv.style.backgroundColor = color;\n    \n    const titleSpan = document.createElement('span');\n    titleSpan.className = 'group-title';\n    titleSpan.textContent = title;\n    \n    headerContent.appendChild(colorDiv);\n    headerContent.appendChild(titleSpan);\n    header.appendChild(headerContent);
    
    return header;
}

// Create ungrouped header element
function createUngroupedHeader(tabCount) {
    const header = document.createElement('div');
    header.className = 'group-header ungrouped';
    
    const headerContent = document.createElement('div');\n    headerContent.className = 'group-header-content';\n    \n    const colorDiv = document.createElement('div');\n    colorDiv.className = 'group-color';\n    colorDiv.style.backgroundColor = '#888888';\n    \n    const titleSpan = document.createElement('span');\n    titleSpan.className = 'group-title';\n    titleSpan.textContent = `Ungrouped Tabs (${tabCount})`;\n    \n    headerContent.appendChild(colorDiv);\n    headerContent.appendChild(titleSpan);\n    header.appendChild(headerContent);
    
    return header;
}

// Get Chrome tab group color
function getGroupColor(chromeColor) {
    const colorMap = {
        'grey': '#5f6368',
        'blue': '#1a73e8', 
        'red': '#d93025',
        'yellow': '#fbbc04',
        'green': '#34a853',
        'pink': '#e91e63',
        'purple': '#9c27b0',
        'cyan': '#00bcd4',
        'orange': '#ff9800'
    };
    
    return colorMap[chromeColor] || '#5f6368';
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
    
    // Privacy-conscious display - show minimal information
    const title = sanitizeTabTitle(tab.title) || 'Tab';
    
    tabItem.innerHTML = `
        <input type="radio" name="tab" id="${radioId}" value="${tab.id}">
        <label for="${radioId}">
            ${faviconElement}
            <div class="tab-info">
                <div class="tab-title">${escapeHtml(title)}</div>
                <div class="tab-meta">Tab ${index + 1}</div>
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
        const img = document.createElement('img');\n        img.src = tab.favIconUrl;\n        img.className = 'favicon';\n        img.alt = 'favicon';\n        \n        const fallback = document.createElement('div');\n        fallback.className = 'favicon default';\n        fallback.textContent = '🌐';\n        fallback.style.display = 'none';\n        \n        img.addEventListener('error', () => {\n            img.style.display = 'none';\n            fallback.style.display = 'block';\n        });\n        \n        const container = document.createElement('div');\n        container.appendChild(img);\n        container.appendChild(fallback);\n        return container.innerHTML;
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
    tabListElement.innerHTML = '';\n    \n    const errorDiv = document.createElement('div');\n    errorDiv.className = 'error-message';\n    errorDiv.style.cssText = 'display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: #d93025; text-align: center; padding: 20px;';\n    \n    const iconDiv = document.createElement('div');\n    iconDiv.style.cssText = 'font-size: 24px; margin-bottom: 12px;';\n    iconDiv.textContent = '❌';\n    \n    const titleDiv = document.createElement('div');\n    titleDiv.style.cssText = 'font-weight: 500; margin-bottom: 8px;';\n    titleDiv.textContent = 'Error';\n    \n    const messageDiv = document.createElement('div');\n    messageDiv.style.cssText = 'font-size: 12px; color: #5f6368;';\n    messageDiv.textContent = message;\n    \n    errorDiv.appendChild(iconDiv);\n    errorDiv.appendChild(titleDiv);\n    errorDiv.appendChild(messageDiv);\n    tabListElement.appendChild(errorDiv);
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