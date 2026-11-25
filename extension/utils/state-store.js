// Enforcement state for Tab Limiter (docs/review.md plan §3), kept in
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

// `lastWindow` maps a tab ID to the window the tab was last settled in (R5). It sits
// outside the window records, so it survives a window's record being deleted when
// its last tab leaves. `arrivals` maps a tab ID to { window, at } for a tab that
// arrived in that window by a move whose verdict can still change (R4): the tabs of
// one group move are judged together when the move ends, even across a restart.
// An arrival names the group move it belongs to (`group`). `openMoves` maps a group ID
// to { from, at }: the window it left and when its tabGroups.onRemoved was handled, for
// a group move that has started and not yet ended (tabGroups.onCreated). Absent fields
// are read as {}.
export function createState(startupMode) {
    return { schema: SCHEMA_VERSION, startupMode: Boolean(startupMode), windows: {}, lastWindow: {}, arrivals: {}, openMoves: {} };
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

function isTabWindowMap(map) {
    return (
        map !== null &&
        typeof map === 'object' &&
        !Array.isArray(map) &&
        Object.entries(map).every(([tabId, windowId]) => /^\d{1,15}$/.test(tabId) && Number.isSafeInteger(windowId))
    );
}

function isArrivalMap(map) {
    return (
        map !== null &&
        typeof map === 'object' &&
        !Array.isArray(map) &&
        Object.entries(map).every(
            ([tabId, arrival]) =>
                /^\d{1,15}$/.test(tabId) &&
                arrival !== null &&
                typeof arrival === 'object' &&
                Number.isSafeInteger(arrival.window) &&
                Number.isSafeInteger(arrival.at) &&
                Number.isSafeInteger(arrival.group)
        )
    );
}

function isOpenMoveMap(map) {
    return (
        map !== null &&
        typeof map === 'object' &&
        !Array.isArray(map) &&
        Object.entries(map).every(
            ([groupId, move]) =>
                /^\d{1,15}$/.test(groupId) &&
                move !== null &&
                typeof move === 'object' &&
                Number.isSafeInteger(move.from) &&
                Number.isSafeInteger(move.at)
        )
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
        Object.values(state.windows).every(isValidWindowState) &&
        (state.lastWindow === undefined || isTabWindowMap(state.lastWindow)) &&
        (state.arrivals === undefined || isArrivalMap(state.arrivals)) &&
        (state.openMoves === undefined || isOpenMoveMap(state.openMoves))
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
