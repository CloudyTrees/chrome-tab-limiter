// Pure validation helpers for the background service worker.
// Kept free of chrome.* calls so they can be unit tested in Node.

export const VALID_ACTIONS = Object.freeze([
    'tabSelected',
    'cancelSelection',
    'tabSelectedForReplacement',
    'cancelReplacement',
    'getGrandfatheredStatus',
    'getSelectorState',
    'clearSelectorState'
]);

// URL schemes the extension is willing to reopen after a replacement
const SAFE_REOPEN_PROTOCOLS = Object.freeze(['http:', 'https:', 'file:', 'chrome:', 'about:']);

// Accept messages only from this extension's own pages (popup, selector, options).
// `self` is { id: chrome.runtime.id, origin: chrome.runtime.getURL('') }.
export function isTrustedSender(sender, self) {
    if (!sender || !self || sender.id !== self.id) {
        return false;
    }
    return typeof sender.url === 'string' && sender.url.startsWith(self.origin);
}

// Only reopen URLs with safe schemes
export function isSafeReopenUrl(url) {
    try {
        return SAFE_REOPEN_PROTOCOLS.includes(new URL(url).protocol);
    } catch {
        return false;
    }
}

// Validate the shape of a runtime message before acting on it
export function validateMessageRequest(request) {
    if (!request || typeof request !== 'object') {
        return { valid: false, error: 'Invalid message format' };
    }

    const { action, tabId, windowId, newTabId } = request;

    if (!VALID_ACTIONS.includes(action)) {
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

    // Action-specific required fields
    const required = {
        tabSelected: ['tabId', 'windowId', 'newTabId'],
        cancelSelection: ['newTabId', 'windowId'],
        tabSelectedForReplacement: ['tabId', 'windowId'],
        cancelReplacement: ['windowId']
    }[action] || [];

    for (const field of required) {
        if (!request[field]) {
            return { valid: false, error: `Missing required field ${field} for ${action}` };
        }
    }

    return { valid: true };
}

// Parse a limit typed into a number field. The whole value must be a plain
// decimal number (no hex, no stray characters) that is an integer in range.
// Returns the integer, or null. Never "repairs" input: 1.5 is rejected, not 15.
const DECIMAL_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

export function parseLimitInput(input, min = 1, max = 100) {
    if (typeof input === 'number') {
        input = String(input);
    }
    if (typeof input !== 'string') {
        return null;
    }
    const text = input.trim();
    if (!DECIMAL_NUMBER.test(text)) {
        return null;
    }
    const value = Number(text);
    return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}
