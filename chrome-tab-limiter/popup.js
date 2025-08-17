// Popup script for Tab Limiter extension

// Debug logging configuration
const DEBUG_MODE = false; // Set to false in production

function debugLog(...args) {
    if (DEBUG_MODE) {
        console.log('[Tab Limiter Popup]', ...args);
    }
}

// Import storage functions (note: in Chrome extensions, import/export works differently)
// We'll access the storage functions directly from chrome.storage.local (local storage only)

// DOM elements
let currentTabCountElement;
let currentLimitElement;
let tabLimitInput;
let defaultLimitInput;
let saveButton;
let saveDefaultButton;
let refreshButton;
let settingsButton;
let statusMessage;
let groupsListElement;
let grandfatheredNotice;
let welcomeNotice;

// Current window ID
let currentWindowId = null;

// Initialize popup when DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
    debugLog('Popup initializing...');
    
    // Check if selector mode is active
    try {
        const selectorResponse = await chrome.runtime.sendMessage({ action: 'getSelectorState' });
        if (selectorResponse?.success && selectorResponse.selectorState?.isActive) {
            debugLog('Selector mode active, switching to selector interface');
            await initializeSelectorMode(selectorResponse.selectorState);
            return;
        }
    } catch (error) {
        debugLog('Error checking selector state:', error);
    }

// Privacy-focused error handling - never log user data
function safeErrorLog(message, error) {
    if (DEBUG_MODE) {
        console.error(message, error?.name || 'Unknown error');
    } else {
        console.error(message);
    }
}

    // Get DOM elements
    currentTabCountElement = document.getElementById('currentTabCount');
    currentLimitElement = document.getElementById('currentLimit');
    tabLimitInput = document.getElementById('tabLimitInput');
    defaultLimitInput = document.getElementById('defaultLimitInput');
    saveButton = document.getElementById('saveButton');
    saveDefaultButton = document.getElementById('saveDefaultButton');
    refreshButton = document.getElementById('refreshButton');
    settingsButton = document.getElementById('settingsButton');
    statusMessage = document.getElementById('statusMessage');
    groupsListElement = document.getElementById('groupsList');
    grandfatheredNotice = document.getElementById('grandfatheredNotice');
    welcomeNotice = document.getElementById('welcomeNotice');

    // Set up event listeners
    saveButton.addEventListener('click', handleSaveTabLimit);
    saveDefaultButton.addEventListener('click', handleSaveDefaultLimit);
    refreshButton.addEventListener('click', handleRefresh);
    settingsButton.addEventListener('click', handleOpenSettings);

    // Add input validation
    tabLimitInput.addEventListener('input', validateTabLimitInput);
    defaultLimitInput.addEventListener('input', validateDefaultLimitInput);

    // Initial data load
    await loadInitialData();
    await checkGrandfatheredStatus();
    await checkFirstRun();

    debugLog('Popup initialized');
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

        // Load tab groups
        await loadTabGroups();

        showMessage('Data loaded successfully', 'success');
        setTimeout(() => clearMessage(), 2000);

    } catch (error) {
        safeErrorLog('Error loading initial data', error);
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
        safeErrorLog('Error updating tab count', error);
        currentTabCountElement.textContent = 'Error';
        return 0;
    }
}

// Load current limits from storage
async function loadLimits() {
    try {
        // Get current window limit
        const windowLimitKey = `tabLimit_${currentWindowId}`;
        const result = await chrome.storage.local.get([windowLimitKey, 'defaultTabLimit']);

        const currentLimit = result[windowLimitKey] || result.defaultTabLimit || 10;
        const defaultLimit = result.defaultTabLimit || 10;

        // Update display
        currentLimitElement.textContent = currentLimit;

        // Update input fields
        tabLimitInput.value = currentLimit;
        defaultLimitInput.value = defaultLimit;

    } catch (error) {
        safeErrorLog('Error loading limits', error);
        currentLimitElement.textContent = 'Error';
        showMessage('Error loading limits', 'error');
    }
}

// Handle saving tab limit for current window
async function handleSaveTabLimit() {
    try {
        const limit = sanitizeNumericInput(tabLimitInput.value);

        if (!validateLimit(limit)) {
            showMessage('Please enter a valid limit (1-100)', 'error');
            return;
        }

        saveButton.disabled = true;
        showMessage('Saving...', 'info');

        // Save to storage
        const windowLimitKey = `tabLimit_${currentWindowId}`;
        await chrome.storage.local.set({ [windowLimitKey]: limit });

        // Update display
        currentLimitElement.textContent = limit;

        showMessage('Tab limit saved successfully', 'success');
        setTimeout(() => clearMessage(), 2000);

    } catch (error) {
        safeErrorLog('Error saving tab limit', error);
        showMessage('Error saving tab limit', 'error');
    } finally {
        saveButton.disabled = false;
    }
}

// Handle saving default limit for new windows
async function handleSaveDefaultLimit() {
    try {
        const limit = sanitizeNumericInput(defaultLimitInput.value);

        if (!validateLimit(limit)) {
            showMessage('Please enter a valid default limit (1-100)', 'error');
            return;
        }

        saveDefaultButton.disabled = true;
        showMessage('Saving default...', 'info');

        // Save to storage
        await chrome.storage.local.set({ defaultTabLimit: limit });

        showMessage('Default limit saved successfully', 'success');
        setTimeout(() => clearMessage(), 2000);

    } catch (error) {
        safeErrorLog('Error saving default limit', error);
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
        await checkGrandfatheredStatus();
        await checkFirstRun();

    } catch (error) {
        safeErrorLog('Error refreshing data', error);
        showMessage('Error refreshing data', 'error');
    } finally {
        refreshButton.disabled = false;
    }
}

// Check grandfathered status and show notice if applicable
async function checkGrandfatheredStatus() {
    try {
        const response = await chrome.runtime.sendMessage({
            action: 'getGrandfatheredStatus',
            windowId: currentWindowId
        });
        
        if (response && response.success && response.isGrandfathered) {
            grandfatheredNotice.style.display = 'block';
            debugLog(`Window has grandfathered tabs: ${response.grandfatheredCount}`);
        } else {
            grandfatheredNotice.style.display = 'none';
        }
    } catch (error) {
        safeErrorLog('Error checking grandfathered status', error);
        grandfatheredNotice.style.display = 'none';
    }
}

// Handle opening settings page
function handleOpenSettings() {
    chrome.runtime.openOptionsPage();
}

// Check if this is the first run and show welcome message
async function checkFirstRun() {
    try {
        const result = await chrome.storage.local.get(['hasSeenWelcome']);
        
        if (!result.hasSeenWelcome) {
            // Show welcome message for first-time users
            welcomeNotice.style.display = 'block';
            
            // Mark as seen after a delay
            setTimeout(async () => {
                await chrome.storage.local.set({ hasSeenWelcome: true });
                
                // Hide welcome message after 10 seconds
                setTimeout(() => {
                    if (welcomeNotice) {
                        welcomeNotice.style.display = 'none';
                    }
                }, 10000);
            }, 1000);
        }
    } catch (error) {
        safeErrorLog('Error checking first run status', error);
    }
}

// Enhanced limit validation with input sanitization
function validateLimit(limit) {
    // Ensure it's a safe integer
    if (!Number.isSafeInteger(limit)) {
        return false;
    }

    // Check range
    return limit >= 1 && limit <= 100;
}

// Sanitize numeric input to prevent injection
function sanitizeNumericInput(input) {
    if (typeof input !== 'string' && typeof input !== 'number') {
        return NaN;
    }

    // Convert to string and remove any non-digit characters
    const sanitized = String(input).replace(/[^\d]/g, '');

    // Parse as integer
    const num = parseInt(sanitized, 10);

    // Return NaN for invalid inputs
    return isNaN(num) ? NaN : num;
}

// Validate tab limit input
function validateTabLimitInput() {
    const value = sanitizeNumericInput(tabLimitInput.value);
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
    const value = sanitizeNumericInput(defaultLimitInput.value);
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

// Load and display tab groups
async function loadTabGroups() {
    try {
        // Get all tab groups in current window
        const groups = await chrome.tabGroups.query({ windowId: currentWindowId });

        // Get tabs to count per group
        const tabs = await chrome.tabs.query({ windowId: currentWindowId });

        // Count tabs per group
        const groupCounts = {};
        let ungroupedCount = 0;

        tabs.forEach(tab => {
            if (tab.groupId === -1) {
                ungroupedCount++;
            } else {
                groupCounts[tab.groupId] = (groupCounts[tab.groupId] || 0) + 1;
            }
        });

        await displayTabGroups(groups, groupCounts, ungroupedCount);

    } catch (error) {
        safeErrorLog('Error loading tab groups', error);
        groupsListElement.innerHTML = '<div class="no-groups">Error loading groups</div>';
    }
}

// Display tab groups in the popup
async function displayTabGroups(groups, groupCounts, ungroupedCount) {
    try {
        if (groups.length === 0 && ungroupedCount === 0) {
            groupsListElement.innerHTML = '<div class="no-groups">No tabs found</div>';
            return;
        }

        let html = '';

        // Add ungrouped tabs if any
        if (ungroupedCount > 0) {
            const ungroupedLimit = await getGroupLimitLocal(-1);
            html += createGroupItemHTML(-1, 'Ungrouped Tabs', '#888888', ungroupedCount, ungroupedLimit);
        }

        // Add grouped tabs
        for (const group of groups) {
            const count = groupCounts[group.id] || 0;
            const limit = await getGroupLimitLocal(group.id);
            const color = getGroupColor(group.color);
            const title = group.title || `Group ${group.id}`;

            html += createGroupItemHTML(group.id, title, color, count, limit);
        }

        groupsListElement.innerHTML = html;

        // Apply colors to group-color elements (CSP-compliant)
        document.querySelectorAll('.group-color[data-color]').forEach(el => {
            el.style.backgroundColor = el.dataset.color;
        });
        
        // Add event listeners to save buttons
        setupGroupEventListeners();

    } catch (error) {
        safeErrorLog('Error displaying tab groups', error);
        groupsListElement.innerHTML = '<div class="no-groups">Error displaying groups</div>';
    }
}

// Create HTML for a group item
function createGroupItemHTML(groupId, title, color, count, limit) {
    const safeTitle = escapeHtml(title);
    const inputId = `group-${groupId}`;

    return `
        <div class="group-item" data-group-id="${groupId}">
            <div class="group-info">
                <div class="group-name">
                    <div class="group-color" data-color="${color}"></div>
                    ${safeTitle}
                </div>
                <div class="group-count">${count} tab${count !== 1 ? 's' : ''}</div>
            </div>
            <input type="number" class="group-limit-input" id="${inputId}"
                   value="${limit}" min="1" max="50" data-group-id="${groupId}">
            <button class="group-save-btn" data-group-id="${groupId}">Save</button>
        </div>
    `;
}

// Get group limit from local storage
async function getGroupLimitLocal(groupId) {
    try {
        const key = groupId === -1
            ? `groupLimit_${currentWindowId}_ungrouped`
            : `groupLimit_${currentWindowId}_${groupId}`;
        const result = await chrome.storage.local.get([key, 'defaultTabLimit']);

        return result[key] || result.defaultTabLimit || 10;
    } catch (error) {
        return 10;
    }
}

// Set up event listeners for group controls
function setupGroupEventListeners() {
    // Save buttons
    const saveButtons = document.querySelectorAll('.group-save-btn');
    saveButtons.forEach(button => {
        button.addEventListener('click', () => {
            const groupId = parseInt(button.dataset.groupId);
            handleSaveGroupLimit(groupId);
        });
    });

    // Input validation
    const inputs = document.querySelectorAll('.group-limit-input');
    inputs.forEach(input => {
        input.addEventListener('input', () => {
            const groupId = parseInt(input.dataset.groupId);
            validateGroupInput(groupId);
        });

        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                const groupId = parseInt(input.dataset.groupId);
                handleSaveGroupLimit(groupId);
            }
        });
    });
}

// Handle saving group limit
async function handleSaveGroupLimit(groupId) {
    try {
        const input = document.getElementById(`group-${groupId}`);
        const button = document.querySelector(`[data-group-id="${groupId}"].group-save-btn`);

        const limit = sanitizeNumericInput(input.value);

        if (!validateLimit(limit)) {
            showMessage('Please enter a valid limit (1-50)', 'error');
            return;
        }

        button.disabled = true;
        button.textContent = 'Saving...';

        // Save to storage
        const key = groupId === -1
            ? `groupLimit_${currentWindowId}_ungrouped`
            : `groupLimit_${currentWindowId}_${groupId}`;
        await chrome.storage.local.set({ [key]: limit });

        showMessage('Group limit saved', 'success');
        setTimeout(() => clearMessage(), 1500);

    } catch (error) {
        safeErrorLog('Error saving group limit', error);
        showMessage('Error saving group limit', 'error');
    } finally {
        const button = document.querySelector(`[data-group-id="${groupId}"].group-save-btn`);
        if (button) {
            button.disabled = false;
            button.textContent = 'Save';
        }
    }
}

// Validate group input
function validateGroupInput(groupId) {
    const input = document.getElementById(`group-${groupId}`);
    const button = document.querySelector(`[data-group-id="${groupId}"].group-save-btn`);

    const value = sanitizeNumericInput(input.value);
    const isValid = validateLimit(value) && value <= 50; // Groups have lower max

    if (button) {
        button.disabled = !isValid;
    }

    if (input.value && !isValid) {
        input.style.borderColor = '#ea4335';
    } else {
        input.style.borderColor = '#dadce0';
    }
}

// Get Chrome tab group color mapping
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

// Enhanced HTML escaping for group display
function escapeHtml(text) {
    if (typeof text !== 'string') {
        text = String(text);
    }

    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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

// Initialize selector mode interface
async function initializeSelectorMode(selectorState) {
    debugLog('Initializing selector mode interface');
    
    // Hide normal popup content and show selector interface
    document.body.innerHTML = `
        <div class="selector-container">
            <div class="selector-header">
                <h2>⚠️ Tab Limit Reached!</h2>
                <p>Select a tab to close:</p>
            </div>
            <div id="selectorTabList" class="selector-tab-list">
                <div class="loading">Loading tabs...</div>
            </div>
            <div class="selector-actions">
                <button id="selectorCancel" class="cancel-btn">Cancel</button>
            </div>
        </div>
    `;
    
    // Load and display tabs for selection
    await loadTabsForSelector(selectorState);
    
    // Set up cancel handler
    document.getElementById('selectorCancel').addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ action: 'clearSelectorState' });
        window.close();
    });
}

// Load tabs for selector
async function loadTabsForSelector(selectorState) {
    try {
        const tabListEl = document.getElementById('selectorTabList');
        const tabs = await chrome.tabs.query({ windowId: selectorState.windowId });
        
        tabListEl.innerHTML = '';
        
        tabs.forEach(tab => {
            const tabEl = document.createElement('div');
            tabEl.className = 'selector-tab-item';
            
            // Use chrome://favicon/ for external URLs to comply with CSP
            const faviconUrl = tab.favIconUrl ? 
                `chrome://favicon/size/16@1x/${tab.url}` : 
                'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="%23ddd"/></svg>';
            
            tabEl.innerHTML = `
                <div class="tab-info">
                    <img src="${faviconUrl}" class="tab-favicon" width="16" height="16">
                    <span class="tab-title">${tab.title || 'Untitled'}</span>
                </div>
            `;
            
            tabEl.addEventListener('click', () => {
                showConfirmation(tab, selectorState);
            });
            
            tabListEl.appendChild(tabEl);
        });
        
    } catch (error) {
        console.error('Error loading tabs for selector:', error);
        document.getElementById('selectorTabList').innerHTML = '<div class="error">Error loading tabs</div>';
    }
}

// Show confirmation dialog for tab selection
function showConfirmation(tab, selectorState) {
    const container = document.querySelector('.selector-container');
    
    // Use chrome://favicon/ for external URLs to comply with CSP
    const faviconUrl = tab.favIconUrl ? 
        `chrome://favicon/size/16@1x/${tab.url}` : 
        'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="%23ddd"/></svg>';
    
    container.innerHTML = `
        <div class="confirmation-header">
            <h2>⚠️ Confirm Tab Closure</h2>
            <p>Are you sure you want to close this tab?</p>
        </div>
        <div class="selected-tab">
            <div class="tab-info">
                <img src="${faviconUrl}" class="tab-favicon" width="16" height="16">
                <span class="tab-title">${tab.title || 'Untitled'}</span>
            </div>
        </div>
        <div class="confirmation-actions">
            <button id="confirmClose" class="confirm-btn">Yes, Close Tab</button>
            <button id="cancelClose" class="cancel-btn">Cancel</button>
        </div>
    `;
    
    document.getElementById('confirmClose').addEventListener('click', async () => {
        await handleTabSelected(tab.id, selectorState);
    });
    
    document.getElementById('cancelClose').addEventListener('click', () => {
        initializeSelectorMode(selectorState); // Go back to tab list
    });
}

// Handle tab selection in popup selector
async function handleTabSelected(tabId, selectorState) {
    try {
        if (selectorState.mode === 'replace') {
            await chrome.runtime.sendMessage({
                action: 'tabSelectedForReplacement',
                tabId: tabId,
                windowId: selectorState.windowId,
                newTabUrl: selectorState.newTabUrl
            });
        }
        
        await chrome.runtime.sendMessage({ action: 'clearSelectorState' });
        window.close();
        
    } catch (error) {
        console.error('Error handling tab selection:', error);
    }
}
