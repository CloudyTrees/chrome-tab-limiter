// Enforcement state for Tab Limiter (REVIEW.md plan §3), kept in
// chrome.storage.session under one key. Session storage is in memory only:
// it survives a service worker restart and is cleared when the browser exits or
// the extension is reloaded or updated. It holds only tab and window IDs, counts
// and operation bookkeeping, never a URL or a title.

export const STATE_KEY = 'tl_state';
export const SCHEMA_VERSION = 1;

export function createWindowState() {
    return {
        allowance: { window: null, groups: {} },
        pending: [],
        moved: [],
        startup: [],
        op: null
    };
}

export function createState(startupMode) {
    return { schema: SCHEMA_VERSION, startupMode: Boolean(startupMode), windows: {} };
}

const isIdList = (list) => Array.isArray(list) && list.every(Number.isSafeInteger);

function isValidOperation(op) {
    return (
        op === null ||
        (typeof op === 'object' &&
            typeof op.opId === 'string' &&
            Number.isSafeInteger(op.revision) &&
            (op.kind === 'startup' || op.kind === 'normal') &&
            (op.phase === 'open' || op.phase === 'closing') &&
            isIdList(op.closing) &&
            Number.isSafeInteger(op.rejectedCount))
    );
}

function isValidWindowState(win) {
    return (
        win !== null &&
        typeof win === 'object' &&
        win.allowance !== null &&
        typeof win.allowance === 'object' &&
        isIdAllowance(win.allowance) &&
        isIdList(win.pending) &&
        isIdList(win.moved) &&
        isIdList(win.startup) &&
        isValidOperation(win.op ?? null)
    );
}

function isIdAllowance(allowance) {
    return (
        (allowance.window === null || Number.isSafeInteger(allowance.window)) &&
        allowance.groups !== null &&
        typeof allowance.groups === 'object' &&
        Object.values(allowance.groups).every(Number.isSafeInteger)
    );
}

export function isValidState(state) {
    return (
        state !== null &&
        typeof state === 'object' &&
        state.schema === SCHEMA_VERSION &&
        typeof state.startupMode === 'boolean' &&
        state.windows !== null &&
        typeof state.windows === 'object' &&
        Object.values(state.windows).every(isValidWindowState)
    );
}

// Returns the stored state, or null when it is missing or does not match the schema
// (browser start, extension reload or update, or a future schema).
export async function loadState(area) {
    const stored = (await area.get(STATE_KEY))[STATE_KEY];
    return isValidState(stored) ? stored : null;
}

export async function saveState(area, state) {
    await area.set({ [STATE_KEY]: state });
}
