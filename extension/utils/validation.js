// Pure validation helpers for the background service worker.
// Kept free of chrome.* calls so they can be unit tested in Node.

export const VALID_ACTIONS = Object.freeze([
    'getState',
    'closeSelected',
    'closePending',
    'keepThese',
    'startEnforcing',
    'setGroupLimit'
]);

// Accept messages only from this extension's own pages (popup, options).
// `self` is { id: chrome.runtime.id, origin: chrome.runtime.getURL('') }.
export function isTrustedSender(sender, self) {
    if (!sender || !self || sender.id !== self.id) {
        return false;
    }
    return typeof sender.url === 'string' && sender.url.startsWith(self.origin);
}

const MAX_SELECTION = 1000;

// Fields each action needs. `startEnforcing` is global (D4): it has no window,
// operation or revision, because it must work when no operation exists.
const REQUIRED_FIELDS = Object.freeze({
    getState: ['windowId'],
    closeSelected: ['windowId', 'opId', 'revision', 'tabIds'],
    closePending: ['windowId', 'opId', 'revision'],
    keepThese: ['windowId', 'opId', 'revision'],
    startEnforcing: [],
    setGroupLimit: ['windowId', 'groupId', 'limit']
});

// Validate the shape of a runtime message before acting on it
export function validateMessageRequest(request) {
    if (!request || typeof request !== 'object') {
        return { valid: false, error: 'Invalid message format' };
    }

    const { action } = request;
    if (!VALID_ACTIONS.includes(action)) {
        return { valid: false, error: 'Invalid action' };
    }

    for (const field of REQUIRED_FIELDS[action]) {
        if (request[field] === undefined) {
            return { valid: false, error: `Missing required field ${field} for ${action}` };
        }
    }

    if (request.windowId !== undefined && !(Number.isSafeInteger(request.windowId) && request.windowId > 0)) {
        return { valid: false, error: 'Invalid window ID' };
    }

    if (request.opId !== undefined && !(typeof request.opId === 'string' && request.opId.length >= 1 && request.opId.length <= 64)) {
        return { valid: false, error: 'Invalid operation ID' };
    }

    if (request.revision !== undefined && !(Number.isSafeInteger(request.revision) && request.revision >= 0)) {
        return { valid: false, error: 'Invalid revision' };
    }

    // A tab group ID, or -1 for the window's ungrouped tabs
    if (request.groupId !== undefined && !(Number.isSafeInteger(request.groupId) && request.groupId >= -1)) {
        return { valid: false, error: 'Invalid group ID' };
    }

    if (request.limit !== undefined && !(Number.isInteger(request.limit) && request.limit >= 1 && request.limit <= 100)) {
        return { valid: false, error: 'Invalid limit' };
    }

    if (request.tabIds !== undefined) {
        const { tabIds } = request;
        const valid =
            Array.isArray(tabIds) &&
            tabIds.length >= 1 &&
            tabIds.length <= MAX_SELECTION &&
            tabIds.every((id) => Number.isSafeInteger(id) && id > 0) &&
            new Set(tabIds).size === tabIds.length;
        if (!valid) {
            return { valid: false, error: 'Invalid tab IDs' };
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
