// Popup script for Tab Limiter extension
import { escapeHtml } from './utils/sanitize.js';
import { parseLimitInput } from './utils/validation.js';
import { remainingNeeds, canCloseSelection } from './utils/selection.js';
import { groupOverridesOf } from './utils/group-overrides.js';

// Debug logging configuration
const DEBUG_MODE = false; // Set to false in production

function debugLog(...args) {
    if (DEBUG_MODE) {
        console.log('[Tab Limiter Popup]', ...args);
    }
}

// Privacy-focused error handling - never log user data
function safeErrorLog(message, error) {
    if (DEBUG_MODE) {
        console.error(message, error?.name || 'Unknown error');
    } else {
        console.error(message);
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
let welcomeNotice;

// Current window ID
let currentWindowId = null;
// After a browser start, until the extension has started a new session for group
// limits, no custom group limit applies (the background's startup gate)
let groupLimitsPaused = false;
// A refresh of the group list waits while a group row is being edited
let groupListStale = false;

// Initialize popup when DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
    debugLog('Popup initializing...');

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
    welcomeNotice = document.getElementById('welcomeNotice');

    // Set up event listeners
    saveButton.addEventListener('click', handleSaveTabLimit);
    saveDefaultButton.addEventListener('click', handleSaveDefaultLimit);
    refreshButton.addEventListener('click', handleRefresh);
    settingsButton.addEventListener('click', handleOpenSettings);
    setupDecisionListeners();

    // Add input validation
    tabLimitInput.addEventListener('input', validateTabLimitInput);
    defaultLimitInput.addEventListener('input', validateDefaultLimitInput);

    // Initial data load
    await loadInitialData();
    await refreshDecisionState();
    connectToBackground();
    chrome.storage.onChanged.addListener(handleStoredLimitsChanged);
    groupsListElement.addEventListener('focusout', handleGroupRowsFocusOut);
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
            await checkFirstRun();

    } catch (error) {
        safeErrorLog('Error refreshing data', error);
        showMessage('Error refreshing data', 'error');
    } finally {
        refreshButton.disabled = false;
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

// Limits are whole numbers from 1 to 100, for windows and groups alike
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

// Parse the whole input value. Never rewrite it (1.5 must not become 15).
function sanitizeNumericInput(input) {
    return parseLimitInput(input, MIN_LIMIT, MAX_LIMIT) ?? NaN;
}

function validateLimit(limit) {
    return Number.isSafeInteger(limit) && limit >= MIN_LIMIT && limit <= MAX_LIMIT;
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
    // Everything but the title is a number or a fixed color; coerce so that nothing
    // stored or reported can ever add markup to an attribute
    groupId = Number(groupId);
    count = Number(count);
    limit = Number(limit);
    color = escapeHtml(color);
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
                   value="${limit}" min="1" max="100" data-group-id="${groupId}">
            <button class="group-save-btn" data-group-id="${groupId}">Save</button>
        </div>
    `;
}

// The limit that applies to a group now. A group's custom limit is stored by group
// ID under the current session tag (utils/group-overrides.js), so it follows the
// group between windows; the ungrouped limit belongs to this window.
async function getGroupLimitLocal(groupId) {
    try {
        const local = await chrome.storage.local.get(null);
        const stored =
            groupId === -1
                ? local[`groupLimit_${currentWindowId}_ungrouped`]
                : groupLimitsPaused
                  ? undefined
                  : groupOverridesOf(local)[groupId];

        // Only a whole number in range is ever shown; anything else falls back
        const asLimit = (value) => (Number.isInteger(value) && value >= 1 && value <= 100 ? value : null);
        return asLimit(stored) ?? asLimit(local.defaultTabLimit) ?? 10;
    } catch (error) {
        return 10;
    }
}

// A limit changed (saved here, in another window's popup, or by the options page):
// show the limits that apply now. A group row being edited is left alone.
function handleStoredLimitsChanged(changes, area) {
    if (area !== 'local') {
        return;
    }
    const relevant = Object.keys(changes).some(
        (key) => key === 'defaultTabLimit' || key === 'groupLimitSession' || key.startsWith('groupLimit_') || key.startsWith('groupOverride_')
    );
    if (relevant) {
        refreshGroupList();
    }
}

const isGroupInput = (element) => Boolean(element?.classList?.contains('group-limit-input'));
const isInGroupRow = (element) => isGroupInput(element) || Boolean(element?.classList?.contains('group-save-btn'));

// Show the limits that apply now, unless a group row is in use (a limit being typed,
// or its Save button about to be clicked): then wait until the focus leaves the rows
function refreshGroupList() {
    if (isInGroupRow(document.activeElement)) {
        groupListStale = true;
        return;
    }
    groupListStale = false;
    loadTabGroups();
}

// The focus left a group row. Moving to another row's input or Save button keeps
// the wait: re-rendering then would drop the click or the value being typed.
function handleGroupRowsFocusOut(event) {
    if (groupListStale && !isInGroupRow(event.relatedTarget)) {
        groupListStale = false;
        loadTabGroups();
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
            showMessage('Please enter a valid limit (1-100)', 'error');
            return;
        }

        button.disabled = true;
        button.textContent = 'Saving...';

        // The background saves it, on the same queue as everything else that writes
        // group limits. On a failure the typed value stays in the input.
        const response = await send({ action: 'setGroupLimit', windowId: currentWindowId, groupId, limit });
        if (!response.success) {
            showMessage(response.error || 'Error saving group limit', 'error');
            return;
        }

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
    const isValid = validateLimit(value);

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

// ----------------------------------------------------------------------------
// Decision view: what to do when a window is over a limit (docs/review.md plan §6)
// ----------------------------------------------------------------------------

let decisionState = null; // latest getState response
const selectedTabIds = new Set();
let port = null;

// Send a command to the background and always return a response object.
// B-07: callers check `success`; nothing is cleared on a rejection.
async function send(request) {
    try {
        const response = await chrome.runtime.sendMessage(request);
        return response && typeof response === 'object' ? response : { success: false, error: 'No response from the extension' };
    } catch (error) {
        safeErrorLog('Error sending message', error);
        return { success: false, error: 'Could not reach the extension' };
    }
}

// Build an element without ever touching innerHTML (titles come from web pages)
function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (key === 'className') {
            node.className = value;
        } else if (key === 'text') {
            node.textContent = value;
        } else if (key === 'disabled' || key === 'checked' || key === 'hidden') {
            node[key] = value;
        } else if (key.startsWith('on')) {
            node.addEventListener(key.slice(2).toLowerCase(), value);
        } else {
            node.setAttribute(key, value);
        }
    }
    for (const child of children) {
        node.appendChild(child);
    }
    return node;
}

function byId(id) {
    return document.getElementById(id);
}

function setupDecisionListeners() {
    byId('startEnforcingButton').addEventListener('click', handleStartEnforcing);
    byId('closeSelectedButton').addEventListener('click', handleCloseSelected);
    byId('closePendingButton').addEventListener('click', handleClosePending);
    byId('keepTheseButton').addEventListener('click', handleKeepThese);
    byId('decideLaterButton').addEventListener('click', () => window.close());
}

// Keep a port open so the background can tell us when anything changed
function connectToBackground() {
    try {
        port = chrome.runtime.connect({ name: 'popup' });
        port.onMessage.addListener(handleBackgroundPush);
    } catch (error) {
        safeErrorLog('Error connecting to the background', error);
    }
}

function noteGroupLimitsPaused(paused) {
    if (typeof paused === 'boolean' && paused !== groupLimitsPaused) {
        groupLimitsPaused = paused;
        refreshGroupList();
    }
}

function handleBackgroundPush(message) {
    if (message?.type === 'groupLimits') {
        noteGroupLimitsPaused(message.paused);
        return;
    }
    if (message?.type !== 'state') {
        return;
    }
    noteGroupLimitsPaused(message.groupLimitsPaused);
    if (!decisionState) {
        return;
    }
    const current = decisionState.operation ? decisionState.operation.revision : null;
    const pushed = message.revisions?.[currentWindowId] ?? null;
    if (message.startupMode !== decisionState.startupMode || pushed !== current) {
        refreshDecisionState(); // clears the selection
    }
}

async function refreshDecisionState() {
    const response = await send({ action: 'getState', windowId: currentWindowId });
    if (!response.success) {
        showMessage(response.error || 'Error loading tab limits', 'error');
        return false;
    }
    applyDecisionState(response);
    return true;
}

function applyDecisionState(state) {
    const previous = decisionState?.operation;
    decisionState = state;
    noteGroupLimitsPaused(state.groupLimitsPaused);
    if (!state.operation || !previous || previous.opId !== state.operation.opId || previous.revision !== state.operation.revision) {
        selectedTabIds.clear(); // the tabs changed under the selection
    }

    renderStartEnforcing(state);
    const decisionView = byId('decisionView');
    const settingsView = byId('settingsView');
    if (state.operation) {
        renderDecision(state.operation);
        decisionView.hidden = false;
        settingsView.hidden = true;
    } else {
        decisionView.hidden = true;
        settingsView.hidden = false;
    }
}

// "Start enforcing now" (D4): shown in both views while startup mode is on
function renderStartEnforcing(state) {
    byId('startEnforcingSection').hidden = !state.startupMode;
    byId('startEnforcingNote').hidden = !(state.startupMode && state.startupOperations > 0);
}

function plural(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function describeConstraint(constraint) {
    const name = constraint.scope === 'window' ? 'Window' : constraint.title;
    return `${name}: ${constraint.excess} over (limit ${constraint.limit})`;
}

function renderDecision(operation) {
    byId('decisionTitle').textContent =
        operation.kind === 'startup' ? 'Tabs left over from the last browser start' : 'Tab limit reached';

    byId('constraintList').replaceChildren(
        ...operation.constraints.map((constraint) => h('li', { text: describeConstraint(constraint) }))
    );

    const rejected = byId('rejectedNotice');
    rejected.hidden = operation.rejectedCount === 0;
    rejected.textContent = `${plural(operation.rejectedCount, 'new tab')} ${operation.rejectedCount === 1 ? 'was' : 'were'} closed. Decide here before opening more.`;

    byId('decisionHint').textContent =
        operation.kind === 'startup'
            ? 'Nothing is closed automatically. Keep these tabs, or choose which to close.'
            : 'Choose tabs to close, or close the new tabs. Tabs you have open close only when you confirm.';

    byId('tabChoiceList').replaceChildren(
        ...operation.tabs.map((tab) => {
            const checkbox = h('input', { type: 'checkbox', checked: selectedTabIds.has(tab.id) });
            checkbox.addEventListener('change', () => handleTabToggled(tab.id, checkbox.checked));
            const children = [checkbox, h('span', { className: 'tab-choice-title', text: tab.title || 'Untitled' })];
            if (tab.status === 'pending' || tab.status === 'moved') {
                children.push(h('span', { className: `tab-choice-tag ${tab.status}`, text: tab.status === 'pending' ? 'New' : 'Moved' }));
            }
            return h('li', {}, h('label', {}, ...children));
        })
    );

    const closePending = byId('closePendingButton');
    closePending.hidden = operation.pendingCount === 0 || !operation.canClosePending;
    closePending.textContent = `Close the ${plural(operation.pendingCount, 'new tab')}`;
    byId('closePendingNote').hidden = !(operation.pendingCount > 0 && !operation.canClosePending);
    byId('keepTheseButton').hidden = !operation.canKeep;

    updateSelectionSummary();
}

function handleTabToggled(tabId, checked) {
    if (checked) {
        selectedTabIds.add(tabId);
    } else {
        selectedTabIds.delete(tabId);
    }
    updateSelectionSummary();
}

function updateSelectionSummary() {
    const operation = decisionState?.operation;
    if (!operation) {
        return;
    }
    const needs = remainingNeeds(operation.constraints, operation.tabs, selectedTabIds);
    const stillNeeded = needs.filter((entry) => entry.need > 0);
    byId('selectionSummary').textContent =
        stillNeeded.length === 0
            ? `${selectedTabIds.size} selected.`
            : `${selectedTabIds.size} selected. ${stillNeeded.map((entry) => {
                  const constraint = operation.constraints.find((c) => c.id === entry.id);
                  return `${describeConstraint({ ...constraint, excess: entry.need }).replace(' over', ' more to close')}`;
              }).join('; ')}.`;
    byId('closeSelectedButton').disabled = !canCloseSelection(operation.constraints, operation.tabs, selectedTabIds);
}

// Run a decision command. On rejection nothing is discarded: show the reason
// and refresh so the user can choose again (B-07).
async function runDecision(request, successMessage) {
    const operation = decisionState?.operation;
    if (!operation) {
        return;
    }
    const response = await send({ ...request, windowId: currentWindowId, opId: operation.opId, revision: operation.revision });
    if (!response.success) {
        showMessage(response.error || 'That did not work', 'error');
        await refreshDecisionState();
        return;
    }
    showMessage(successMessage, 'success');
    await refreshDecisionState();
    if (!decisionState?.operation) {
        window.close(); // resolved
    }
}

function handleCloseSelected() {
    return runDecision({ action: 'closeSelected', tabIds: [...selectedTabIds] }, 'Tabs closed');
}

function handleClosePending() {
    return runDecision({ action: 'closePending' }, 'New tabs closed');
}

function handleKeepThese() {
    return runDecision({ action: 'keepThese' }, 'Tabs kept');
}

async function handleStartEnforcing() {
    const response = await send({ action: 'startEnforcing' });
    if (!response.success) {
        showMessage(response.error || 'Could not start enforcing', 'error');
        await refreshDecisionState();
        return;
    }
    showMessage('Limits are now enforced for new tabs', 'success');
    await refreshDecisionState();
}
