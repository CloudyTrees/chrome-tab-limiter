// Background service worker for Tab Limiter.
//
// Enforcement model: "keep-pending" (docs/review.md, consolidated plan). A new tab
// that would exceed a limit stays open as *pending* until the user decides in
// the popup; at most `maxPendingPerWindow` tabs wait, and later ones are
// rejected. Nothing is closed automatically after a browser start until the
// user's first decision ("startup mode"). No URL is ever stored or recreated.
//
// Every event and popup command is a task on one serial queue. A task loads the
// state, reads the real tabs, decides, saves, performs side effects, reconciles
// from the real tabs and saves again.

import { DEFAULT_TAB_LIMIT } from './utils/storage.js';
import {
    SESSION_TAG_KEY,
    INITIAL_TAG,
    groupOverridesOf,
    planAdoption,
    sessionTagOf,
    groupOverrideKey,
    parseGroupOverrideKey,
    parseLegacyGroupLimitKey
} from './utils/group-overrides.js';
import { isTrustedSender, validateMessageRequest } from './utils/validation.js';
import {
    computeExcess,
    decideCreation,
    resolvesAll,
    shrinkAllowance,
    keepAllowance,
    keepEligibleIds
} from './utils/limits.js';
import { createSerialQueue } from './utils/serial-queue.js';
import { STATE_KEY, createState, createWindowState, loadState, saveState } from './utils/state-store.js';

const DEBUG_MODE = false; // Set to false in production

function debugLog(...args) {
    if (DEBUG_MODE) {
        console.log('[Tab Limiter]', ...args);
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

const DEFAULT_MAX_PENDING = 5;
const POPUP_THROTTLE_MS = 5000;

const queue = createSerialQueue();

// Tabs whose creation task has not finished. In memory only: the one worker
// global the rules depend on. Losing it on a restart shows up as unexplained
// excess that the user reviews (plan §7).
const undecided = new Set();

// Old tab ID -> new tab ID for a tab Chrome replaced (REG-03). A task that is
// still working on the old ID follows this to the replacement, so the new tab
// gets exactly one admission decision. Cleared by the replacement's own task.
const replacedBy = new Map();

// Navigations are noted the moment the event arrives, not when its queued task
// runs (REG-02). `navSeq` counts them and `navigatedAt` remembers the latest one
// per tab. A close command compares against the count when its message arrived.
// Only numbers are kept, never a URL.
let navSeq = 0;
const navigatedAt = new Map(); // tab ID -> latest navigation number
const windowNavAt = new Map(); // window ID -> latest navigation number of any tab in it (R3)

// Moves and settings changes are noted the same way, so a task that is waiting on
// the browser can tell that one happened while it waited, even if the tab ended
// up where it started (REG-01a) or a limit was raised mid-decision (REG-04a).
let moveSeq = 0;
const movedAt = new Map(); // tab ID -> latest move number
// A whole group moving to another window (docs/review.md "Group moves between windows")
// is reported as tabGroups.onRemoved in the source, then each tab's detach, attach
// and group update (groupId = the group, after the attach), then tabGroups.onCreated
// in the destination. All three are noted when the event arrives:
//   - onRemoved opens the group's move, at the current move number
//   - a tab that moved after that and then reports the group joins the move
//   - onCreated closes it, so a tab that joins the group later is not part of it
// The tabs of one move share one verdict at the destination (R3).
const openGroupMoves = new Map(); // group ID -> move number when its move started
const groupMoveOf = new Map(); // tab ID -> the move it arrived with ("groupId:number")
let settingsSeq = 0;
let globalSettingsAt = 0; // default limit or pending cap: affects every window
const windowSettingsAt = new Map(); // window ID -> latest change of a limit that is specific to it

// Did a setting that affects this window's admission change after `since`?
// (A limit stored for another window does not.)
const settingsChangedSince = (windowId, since) =>
    globalSettingsAt > since || (windowSettingsAt.get(windowId) ?? 0) > since;

// Changes to what a window holds are noted the same way (R2a): a tab attached,
// detached or removed, a tab's group changed, or a group created or removed there.
// An admission that counted the window before such a change decides again before
// it closes anything, so a group that arrives or leaves mid-decision is counted.
let topologySeq = 0;
const windowTopologyAt = new Map(); // window ID -> latest change to its tabs or groups
function noteWindowChange(windowId) {
    if (Number.isInteger(windowId) && windowId >= 0) {
        topologySeq += 1;
        windowTopologyAt.set(windowId, topologySeq);
    }
}
const windowChangedSince = (windowId, since) => (windowTopologyAt.get(windowId) ?? 0) > since;

// Highest tab ID whose creation we have heard about. Chrome assigns tab IDs in
// increasing order and delivers onCreated in that order, so a tab with a higher
// ID exists but has not been announced yet: it is not counted until its own
// creation task runs. Without this, a burst of new tabs would be counted
// before it was decided, and the first tabs would wrongly look like excess.
let announcedUpTo = 0;

// The startup gate (plan: "Startup rotation gates group overrides"). Group IDs are
// unique only within a browser session, so at a browser start the session tag that
// custom group limits are stored under is replaced (rotateSessionTag). From the moment
// runtime.onStartup arrives until the corrected state is saved:
//   - no group override applies (restored groups have new IDs: none can be theirs)
//   - no decision can be confirmed, so nothing chosen under an old limit is carried out
// `tag` is the new tag. A marker in storage.session (ROTATION_KEY) carries both across
// a worker restart. `correcting` lets the rotation itself see the new tag's limits.
const ROTATION_KEY = 'tl_rotation_pending';
const GATE_MESSAGE = 'Limits are being updated after the browser start; please review again';
const ROTATION_RETRY_MS = 5000;
const gate = { pending: false, tag: null, correcting: false };
let rotationRetry = null;

// Total excess per window, for the badge. Rebuilt by every reconciliation.
const excessByWindow = new Map();

// Popup ports that want to hear about state changes
const ports = new Set();

// Last time the popup was opened automatically, per window
const lastPresented = new Map();

// ---------------------------------------------------------------- settings

// A group's custom limit is stored by group ID (utils/group-overrides.js), so it
// applies in whatever window the group's tabs are in, from the moment they report
// the group: limits are looked up per tab by its group ID. The limit for ungrouped
// tabs and the window limit stay with their window.
// While the startup gate is on, no custom group limit applies
const groupLimitsPaused = () => gate.pending && !gate.correcting;

function configFor(local, windowId) {
    const defaultLimit = local.defaultTabLimit || DEFAULT_TAB_LIMIT;
    const groupLimits = groupLimitsPaused() ? {} : groupOverridesOf(local);
    const ungrouped = local[`groupLimit_${windowId}_ungrouped`];
    if (ungrouped) {
        groupLimits[-1] = ungrouped;
    }

    return { windowLimit: local[`tabLimit_${windowId}`] ?? defaultLimit, groupLimits, defaultLimit };
}

function pendingCapFor(local) {
    const cap = local.maxPendingPerWindow;
    return Number.isInteger(cap) && cap >= 1 && cap <= 10 ? cap : DEFAULT_MAX_PENDING;
}

const toLimitTab = (tab) => ({ id: tab.id, groupId: tab.groupId ?? -1 });

// Real tabs of a window that count toward its limits: not tabs still being
// decided, and not tabs that exist but have not been announced yet
async function readWindow(windowId) {
    const all = await chrome.tabs.query({ windowId });
    const counted = all.filter((tab) => !undecided.has(tab.id) && tab.id <= announcedUpTo).map(toLimitTab);
    return { all, counted };
}

// Tabs that exist when the worker starts are all known
function announceExisting(tabs) {
    for (const tab of tabs) {
        announcedUpTo = Math.max(announcedUpTo, tab.id);
    }
}

// ------------------------------------------------------------------- state

function windowOf(state, windowId) {
    return (state.windows[windowId] ??= createWindowState());
}

function newOperation(kind) {
    return { opId: crypto.randomUUID(), revision: 1, kind, phase: 'open', closing: [], rejectedCount: 0 };
}

function ensureOperation(win, kind) {
    win.op ??= newOperation(kind);
    return win.op;
}

// Any change the prompt shows must invalidate selections made on an older view
function touch(win) {
    if (win.op) {
        win.op.revision += 1;
    }
}

function clearStatus(win, tabId) {
    for (const list of ['pending', 'moved', 'startup']) {
        win[list] = win[list].filter((id) => id !== tabId);
    }
    if (win.op) {
        win.op.closing = win.op.closing.filter((id) => id !== tabId);
    }
}

function setStatus(win, tabId, status) {
    clearStatus(win, tabId);
    win[status].push(tabId);
}

// Where each tab was last settled (R5): a restart that finds a tab elsewhere knows it
// moved without its move being handled. Changed only by seeding (settleWindow, for
// tabs with no entry), where a move's status is saved (handleAttached), at a restart
// (reconcileAll), and when a tab is removed or replaced.
const lastWindowOf = (state) => (state.lastWindow ??= {});

// Tabs that arrived in a window by a group move that has not ended yet (R4). The
// in-memory move tracking (openGroupMoves, groupMoveOf) judges a group's tabs together
// as they arrive, but a worker restart in the middle of a move loses it. So the saved
// state records each group move from its start (tabGroups.onRemoved) to its end
// (tabGroups.onCreated in the destination), with the window it left. A tab that arrives
// from that window while the move is open (its lastWindow entry, not yet updated, is the
// window it came from) is marked as part of that group's move. When the move ends, or a
// new worker starts, the move's marked tabs are judged on the window as it is then: the
// same verdict for the whole group. A tab that moves on its own (from a window no open
// group move left) is judged once, at its attach, and that verdict stands: it gets no
// marker, so nothing judges it again against later activity, even while an unrelated
// group's removal is open elsewhere (Codex). Markers and open moves are dropped when the move ends,
// when the tab leaves or is removed, and after ARRIVAL_MS (a move, even a two-hop drag,
// takes under a second).
const ARRIVAL_MS = 10_000;
const arrivalsOf = (state) => (state.arrivals ??= {});
const openMovesOf = (state) => (state.openMoves ??= {});
const isFreshArrival = (state, tabId, windowId, now) => {
    const arrival = arrivalsOf(state)[tabId];
    return arrival?.window === windowId && now - arrival.at <= ARRIVAL_MS;
};
// A marker whose window is DEPARTING notes a tab that left a window while a group move
// from it was open: Chrome's detach event names the window it left, which a task run
// later can no longer read from the browser (the tab may be two hops on by then). Its
// next attach turns it into an arrival marker for that move.
const DEPARTING = -1;
function departingMove(state, tabId) {
    const arrival = arrivalsOf(state)[tabId];
    return arrival?.window === DEPARTING && arrival.group in openMovesOf(state) ? arrival.group : undefined;
}

// The open group move an arriving tab belongs to: the move of the group it reports
// now, if that group's move is open. A tab can arrive before Chrome reports its group
// in the destination; then it belongs to a move that left the window it came from
// (`from`, its lastWindow entry), the latest if several did. Any other tab moved on its
// own.
function groupMoveFrom(state, from, groupId) {
    const moves = openMovesOf(state);
    if (groupId !== -1 && groupId in moves) {
        return groupId;
    }
    if (groupId !== -1) {
        return undefined; // in a group that is not moving
    }
    const candidates = Object.entries(moves).filter(([, move]) => move.from === from);
    if (candidates.length === 0) {
        return undefined;
    }
    return Number(candidates.sort((a, b) => b[1].at - a[1].at)[0][0]);
}
function dropStaleArrivals(state, now) {
    for (const map of [arrivalsOf(state), openMovesOf(state)]) {
        for (const [key, value] of Object.entries(map)) {
            if (now - (typeof value === 'number' ? value : value.at) > ARRIVAL_MS) {
                delete map[key];
            }
        }
    }
}

function forgetTab(state, tabId) {
    for (const win of Object.values(state.windows)) {
        clearStatus(win, tabId);
    }
}

async function loadSettings() {
    return chrome.storage.local.get(null);
}

// The stored state, or a fresh one built from the open windows (startup mode)
async function loadOrInitialize(local) {
    return (await loadState(chrome.storage.session)) ?? (await initializeState(local));
}

async function persist(state) {
    await saveState(chrome.storage.session, state);
}

// Reconcile one window with its real tabs and the current settings, and save
// and publish if that changed anything (REG-04). Used before any decision or
// command, so a raised limit is never judged against an out-of-date operation.
async function refreshWindow(state, local, windowId) {
    const before = JSON.stringify(state);
    await settleWindow(state, local, windowId);
    if (JSON.stringify(state) !== before) {
        await persist(state);
        await publish(state);
    }
}

// The tab now, following a replacement if Chrome swapped its ID. null if it is gone.
async function currentTab(tabId) {
    let id = tabId;
    for (let hops = 0; hops < 5; hops++) {
        try {
            return await chrome.tabs.get(id);
        } catch {
            const next = replacedBy.get(id);
            if (next === undefined) {
                return null;
            }
            id = next;
        }
    }
    return null;
}

// The tab's ID and the IDs of whatever replaced it, in order
function identityChain(tabId) {
    const chain = [tabId];
    for (let id = replacedBy.get(tabId); id !== undefined && chain.length < 6; id = replacedBy.get(id)) {
        chain.push(id);
    }
    return chain;
}

// Stop treating a tab, and anything that replaced it, as undecided
function forgetUndecided(tabId) {
    let id = tabId;
    for (let hops = 0; hops < 5 && id !== undefined; hops++) {
        undecided.delete(id);
        id = replacedBy.get(id);
    }
}

// ------------------------------------------------------------ reconciliation

// Bring one window's record in line with its real tabs: forget tabs that no
// longer exist, shrink allowances, and keep an operation open exactly while the
// window is over. Does not save. `bump` invalidates selections if an operation
// remains; `endClosing` finishes a `closing` phase.
async function settleWindow(state, local, windowId, { bump = false, endClosing = false } = {}) {
    const { all, counted } = await readWindow(windowId);

    if (all.length === 0) {
        delete state.windows[windowId];
        excessByWindow.delete(windowId);
        return null;
    }

    // Seed only: an existing entry is never moved to another window here. Another task
    // can settle the destination before the attach is handled, and overwriting the
    // entry then would hide the move from a restart.
    const lastWindow = lastWindowOf(state);
    for (const tab of all) {
        if (!(tab.id in lastWindow)) {
            lastWindow[tab.id] = windowId;
        }
    }

    const win = windowOf(state, windowId);
    const exists = new Set(all.map((tab) => tab.id));
    for (const list of ['pending', 'moved', 'startup']) {
        win[list] = win[list].filter((id) => exists.has(id));
    }
    if (win.op) {
        win.op.closing = win.op.closing.filter((id) => exists.has(id));
    }

    const config = configFor(local, windowId);
    win.allowance = shrinkAllowance(win.allowance, counted, config) ?? { window: null, groups: {} };
    const excess = computeExcess(counted, config, win.allowance);
    excessByWindow.set(windowId, excess.totalExcess);

    if (!excess.over) {
        // Resolved: everything that was waiting becomes an ordinary tab
        win.op = null;
        win.pending = [];
        win.moved = [];
        win.startup = [];
        return { win, excess, config };
    }

    if (!win.op) {
        // Excess nobody explained (e.g. a restart before a pending ID was saved)
        win.op = newOperation(state.startupMode ? 'startup' : 'normal');
    } else {
        if (endClosing && win.op.phase === 'closing') {
            win.op.phase = 'open';
            win.op.closing = [];
            touch(win);
        } else if (bump) {
            touch(win);
        }
    }

    return { win, excess, config };
}

// After a window's record changed: refresh the badge and tell open popups
async function publish(state) {
    await updateBadge();
    broadcast(state);
}

async function updateBadge() {
    let total = 0;
    for (const value of excessByWindow.values()) {
        total += value;
    }
    try {
        await chrome.action.setBadgeText({ text: total > 0 ? String(total) : '' });
        await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
    } catch (error) {
        safeErrorLog('Error updating badge', error);
    }
}

// The startup gate turned on: open popups show default group limits until the
// rotation's publish tells them otherwise
function announceGroupLimitsPaused() {
    for (const port of [...ports]) {
        try {
            port.postMessage({ type: 'groupLimits', paused: groupLimitsPaused() });
        } catch {
            ports.delete(port);
        }
    }
}

function broadcast(state) {
    const revisions = {};
    for (const [windowId, win] of Object.entries(state.windows)) {
        revisions[windowId] = win.op ? win.op.revision : null;
    }
    for (const port of [...ports]) {
        try {
            port.postMessage({ type: 'state', startupMode: state.startupMode, groupLimitsPaused: groupLimitsPaused(), revisions });
        } catch {
            ports.delete(port);
        }
    }
}

// Open the popup for the user (Chrome 127+). Failure is fine: the badge shows.
function present(windowId) {
    const now = Date.now();
    if (now - (lastPresented.get(windowId) ?? -Infinity) < POPUP_THROTTLE_MS) {
        return;
    }
    lastPresented.set(windowId, now);
    try {
        Promise.resolve(chrome.action.openPopup({ windowId })).catch(() => {});
    } catch {
        // ignored
    }
}

// A move opens the popup only in a window that holds a tab from outside the current
// move. Chrome's temporary drag window, or a window a group was just torn off into,
// holds nothing but the moving tabs, and opening the popup there would end the user's
// drag (seen in real Chrome once group limits followed their group: a group over its
// own limit made the drag window over). The badge still counts it, and the popup opens
// once the tabs land among others. The current move is `current` (the tabs being
// handled), plus tabs not yet handled here or still marked as arriving with an open
// move. A tab that arrived by an earlier move and settled here counts as the window's
// own, even if it is still flagged moved (Codex).
async function presentAfterMove(state, windowId, current = new Set()) {
    let tabs;
    try {
        tabs = await chrome.tabs.query({ windowId });
    } catch {
        return;
    }
    const lastWindow = lastWindowOf(state);
    const arrivals = arrivalsOf(state);
    const resident = tabs.some(
        (tab) => lastWindow[tab.id] === windowId && !current.has(tab.id) && arrivals[tab.id]?.window !== windowId && !undecided.has(tab.id)
    );
    if (resident) {
        present(windowId);
    }
}

// ------------------------------------------------------ initialization (§7)

// No state yet (browser start, extension install, reload or update): startup
// mode on, every over-limit window gets a startup operation, nothing is closed.
async function initializeState(local) {
    const state = createState(true);
    const windows = await chrome.windows.getAll();

    for (const { id: windowId } of windows) {
        announceExisting(await chrome.tabs.query({ windowId }));
    }
    for (const { id: windowId } of windows) {
        const { all, counted } = await readWindow(windowId);
        for (const tab of all) {
            state.lastWindow[tab.id] = windowId;
        }
        const config = configFor(local, windowId);
        const excess = computeExcess(counted, config, null);
        excessByWindow.set(windowId, excess.totalExcess);

        if (excess.over) {
            const win = windowOf(state, windowId);
            win.startup = counted.map((tab) => tab.id);
            win.op = newOperation('startup');
        }
    }

    await persist(state);
    await updateBadge();
    return state;
}

// State exists (worker restart): reconcile without changing allowances,
// startupMode or any operation's kind.
async function reconcileAll(state, local) {
    const windows = await chrome.windows.getAll();
    const realIds = new Set(windows.map((w) => w.id));

    const tabWindow = new Map();
    const tabGroupOf = new Map();
    for (const { id: windowId } of windows) {
        const tabs = await chrome.tabs.query({ windowId });
        announceExisting(tabs);
        for (const tab of tabs) {
            tabWindow.set(tab.id, windowId);
            tabGroupOf.set(tab.id, tab.groupId ?? -1);
        }
    }

    // A tab moved while the worker was gone if a window record tracks it elsewhere, or
    // it was last settled elsewhere (R5). Either way it is judged where it is now by the
    // destination rule (R3), like a move handled live: its status in the old window
    // does not carry over (Codex).
    const unhandled = new Set();
    for (const [windowKey, win] of Object.entries(state.windows)) {
        const windowId = Number(windowKey);
        const tracked = new Set([...win.pending, ...win.moved, ...win.startup, ...(win.op?.closing ?? [])]);
        for (const tabId of tracked) {
            const real = tabWindow.get(tabId);
            if (real !== undefined && real !== windowId) {
                clearStatus(win, tabId);
                unhandled.add(tabId);
            }
        }
        if (!realIds.has(windowId)) {
            delete state.windows[windowKey];
        }
    }
    const now = Date.now();
    dropStaleArrivals(state, now);
    const lastWindow = lastWindowOf(state);
    for (const [tabId, windowId] of tabWindow) {
        const last = lastWindow[tabId];
        if (last !== undefined && last !== windowId) {
            unhandled.add(tabId);
        }
    }

    // While a group move is open, these arrivals may be part of it: they are marked, to
    // be judged with the rest of the group when it ends. Every live tab's lastWindow
    // entry is then its current window; entries of gone tabs drop.
    const arrivals = arrivalsOf(state);
    for (const tabId of unhandled) {
        const group = departingMove(state, tabId) ?? groupMoveFrom(state, lastWindow[tabId], tabGroupOf.get(tabId));
        if (group !== undefined) {
            arrivals[tabId] = { window: tabWindow.get(tabId), at: now, group };
        }
    }
    for (const tabId of Object.keys(arrivals)) {
        const where = tabWindow.get(Number(tabId));
        const departing = arrivals[tabId].window === DEPARTING;
        if (departing ? where !== undefined || departingMove(state, tabId) === undefined : where !== arrivals[tabId].window) {
            delete arrivals[tabId]; // a departing tab in no window is still on its way
        }
    }
    // A tab in no window may be between windows in an open group move: it keeps its
    // entry, so its attach still shows where it came from. Other unseen tabs are gone.
    const inTransit = Object.entries(lastWindow).filter(
        ([tabId, from]) =>
            !tabWindow.has(Number(tabId)) && (departingMove(state, Number(tabId)) !== undefined || groupMoveFrom(state, from, -1) !== undefined)
    );
    state.lastWindow = Object.fromEntries([...inTransit, ...[...tabWindow].map(([tabId, windowId]) => [tabId, windowId])]);

    excessByWindow.clear();
    for (const windowId of realIds) {
        await judgeArrivals(state, local, windowId, { now, also: unhandled });
        await settleWindow(state, local, windowId, { endClosing: true });
    }

    await persist(state);
    await publish(state);
}

// Group limits stored by an earlier version (groupLimit_<windowId>_<groupId>) are
// adopted under the current tag only when their group is live in the window the key
// names, and removed otherwise (utils/group-overrides.js). Runs first in the first
// task of every worker start, so no popup save can land in between. Best effort: a
// failure leaves the keys for the next start, and they are never read as limits.
async function adoptLegacyGroupLimits() {
    try {
        const local = await loadSettings();
        const { writes, removes } = planAdoption(local, await chrome.tabs.query({}));
        if (removes.length === 0) {
            return;
        }
        if (Object.keys(writes).length > 0) {
            await chrome.storage.local.set(writes);
        }
        await chrome.storage.local.remove(removes);
    } catch (error) {
        safeErrorLog('Error adopting stored group limits', error);
    }
}

// Remove group limits that can never apply: entries under a tag other than the
// current one, and legacy keys once the tag has changed (before that, they are
// adoption's). The tag and the candidate keys come from ONE read, so a limit saved
// under a newer tag (after a reset, say) is either not seen or seen with its own tag:
// it is never removed. Best effort; correctness never depends on it.
async function cleanupStaleGroupLimits() {
    try {
        const local = await loadSettings();
        const tag = sessionTagOf(local);
        const stale = Object.keys(local).filter((key) => {
            const override = parseGroupOverrideKey(key);
            if (override) {
                return override.tag !== tag;
            }
            return tag !== INITIAL_TAG && parseLegacyGroupLimitKey(key) !== null;
        });
        if (stale.length > 0) {
            await chrome.storage.local.remove(stale);
        }
    } catch (error) {
        safeErrorLog('Error removing old group limits', error);
    }
}

async function readRotationMarker() {
    try {
        const marker = (await chrome.storage.session.get(ROTATION_KEY))[ROTATION_KEY];
        return typeof marker?.tag === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(marker.tag) ? marker : null;
    } catch {
        return null;
    }
}

// The rotation after a browser start (plan steps 1-5). Every step can be repeated:
// a new worker that finds the marker runs it again with the marker's tag.
async function rotateSessionTag() {
    if (!gate.pending) {
        return true;
    }
    const { tag } = gate;
    try {
        // 1. The marker, so a worker restart before step 4 still gates (best effort)
        try {
            await chrome.storage.session.set({ [ROTATION_KEY]: { tag } });
        } catch (error) {
            safeErrorLog('Error recording the session start', error);
        }
        // 2. The new tag: from now on only limits saved under it can apply
        await chrome.storage.local.set({ [SESSION_TAG_KEY]: tag });
        // 3. Correct what was decided before, under the old tag
        gate.correcting = true;
        const local = await loadSettings();
        const state = await loadOrInitialize(local);
        await correctAfterRotation(state, local);
        // 4. The corrected state and the end of the marker, in one write
        await chrome.storage.session.set({ [STATE_KEY]: state, [ROTATION_KEY]: null });
        gate.pending = false;
        gate.correcting = false;
        gate.tag = null;
        clearTimeout(rotationRetry);
        await publish(state);
        await cleanupStaleGroupLimits();
        return true;
    } catch (error) {
        // 5. Stay gated, and try again
        gate.correcting = false;
        safeErrorLog('Error starting a new session for group limits', error);
        clearTimeout(rotationRetry);
        rotationRetry = setTimeout(() => runEvent('browser start retry', rotateSessionTag), ROTATION_RETRY_MS);
        return false;
    }
}

// After the tag changes, every window is settled again as after a change of the
// default limit. Every open operation's revision is bumped, so nothing chosen in a
// view from before the rotation can be confirmed. A window that is over only now,
// in startup mode, gets its tabs listed as startup tabs, as a browser start would.
async function correctAfterRotation(state, local) {
    for (const { id: windowId } of await chrome.windows.getAll()) {
        const hadOperation = Boolean(state.windows[windowId]?.op);
        const result = await settleWindow(state, local, windowId);
        if (!result?.win.op) {
            continue;
        }
        touch(result.win);
        if (!hadOperation && state.startupMode && result.win.startup.length === 0) {
            const tracked = new Set([...result.win.pending, ...result.win.moved]);
            const { counted } = await readWindow(windowId);
            result.win.startup = counted.filter((tab) => !tracked.has(tab.id)).map((tab) => tab.id);
        }
    }
}

function initialize() {
    return queue.enqueue(async () => {
        // A rotation interrupted by a worker restart: gate before anything is reconciled
        const marker = await readRotationMarker();
        if (marker && !gate.pending) {
            gate.pending = true;
            gate.tag = marker.tag;
            announceGroupLimitsPaused();
        }
        await adoptLegacyGroupLimits();
        await cleanupStaleGroupLimits();
        const local = await loadSettings();
        const state = await loadState(chrome.storage.session);
        if (state) {
            await reconcileAll(state, local);
        } else {
            await initializeState(local);
        }
        if (gate.pending) {
            await rotateSessionTag();
        }
    });
}

// --------------------------------------------------------- event handlers

// Run a task for an event; an error in one task never stops the queue
function runEvent(name, task) {
    queue.enqueue(task).catch((error) => safeErrorLog(`Error handling ${name}`, error));
}

const movedSince = (ids, since) => ids.some((id) => (movedAt.get(id) ?? 0) > since);
const MAX_ATTEMPTS = 3;

// `createdAfterMove` is the move counter when the tab was announced: any move of
// this tab (or of whatever replaced it) after that point makes it a moved tab,
// never a rejectable new one.
async function handleCreated(originalId, createdAfterMove) {
    let tabId = originalId;
    let deferred = false;

    // Settings kept changing for the whole attempt budget. Never close a tab on
    // out-of-date limits and never let it past the pending cap: hand it to a
    // follow-up task queued behind the pending settings changes. That task owns
    // the tab, which stays undecided (uncounted, unclassified) until it decides
    // it, once, under the then-current rules (REG-04d).
    const deferDecision = () => {
        deferred = true;
        runEvent('tab creation retry', () => handleCreated(tabId, createdAfterMove));
    };

    try {
        for (let attempt = 1; ; attempt++) {
            // Everything the decision rests on is read inside this loop. If a
            // setting that affects the window changes while we wait, start over.
            const settingsAt = settingsSeq;
            const topologyAt = topologySeq;

            let tab = await currentTab(tabId);
            if (!tab) {
                return; // gone before we looked at it
            }
            tabId = tab.id;

            const local = await loadSettings();
            const state = await loadOrInitialize(local);
            await settleWindow(state, local, tab.windowId); // judge against current limits (REG-04)
            const win = windowOf(state, tab.windowId);
            const { all, counted } = await readWindow(tab.windowId);

            // Look again right before deciding: the tab may have moved to another
            // window (its move is handled on its own, REG-01), been regrouped, or
            // been replaced (REG-03)
            const fresh = await currentTab(tabId);
            if (!fresh || fresh.windowId !== tab.windowId) {
                return;
            }
            tab = fresh;
            tabId = fresh.id;
            const windowId = tab.windowId;

            if (movedSince(identityChain(originalId), createdAfterMove)) {
                return; // it was moved, even if it came back: the move handler protects it (REG-01a)
            }
            if (settingsChangedSince(windowId, settingsAt) || windowChangedSince(windowId, topologyAt)) {
                if (attempt < MAX_ATTEMPTS) {
                    continue;
                }
                return deferDecision();
            }

            // The tab is judged on the window it was opened into. Tabs that moved in after
            // Chrome reported it are the move's to answer for: their own handling flags them
            // moved if they put the window over (R3), and an operation they alone opened does
            // not make this earlier tab pending or rejected.
            const config = configFor(local, windowId);
            const before = counted.filter((t) => (movedAt.get(t.id) ?? 0) <= createdAfterMove);
            const activeBefore = Boolean(win.op) && (before.length === counted.length || computeExcess(before, config, win.allowance).over);
            const decision = decideCreation({
                tabs: before,
                groupId: tab.groupId ?? -1,
                config,
                allowance: win.allowance,
                startupMode: state.startupMode,
                hasOperation: activeBefore,
                pendingCount: win.pending.length,
                cap: pendingCapFor(local)
            });

            let { action } = decision;
            if (action === 'reject' && all.length <= 1) {
                action = 'admit'; // never close the last tab in a window
            }

            if (action === 'reject') {
                // Last look, with nothing saved yet: only close a tab that is still
                // where it was decided, was not moved, and was decided on settings
                // that are still current. The close follows with no wait in between.
                const last = await currentTab(tabId);
                const inPlace =
                    last &&
                    last.windowId === windowId &&
                    (last.groupId ?? -1) === (tab.groupId ?? -1) &&
                    !movedSince(identityChain(originalId), createdAfterMove);
                if (!inPlace) {
                    return; // its move or change is handled by its own event
                }
                tabId = last.id;

                if (settingsChangedSince(windowId, settingsAt) || windowChangedSince(windowId, topologyAt)) {
                    if (attempt < MAX_ATTEMPTS) {
                        continue; // decide again under the new settings, or on the window as it is now
                    }
                    return deferDecision();
                }
                try {
                    await chrome.tabs.remove(last.id);
                } catch (error) {
                    safeErrorLog('Error rejecting tab', error);
                }
                forgetUndecided(originalId);
                win.op.rejectedCount += 1;
                await persist(state);
                present(windowId);
                await finishCreation(state, local, windowId);
                return;
            }

            forgetUndecided(originalId);
            if (action === 'admit') {
                touch(win);
            } else {
                ensureOperation(win, decision.opKind);
                win[action].push(tabId);
                touch(win);
            }
            await persist(state);
            if (action !== 'admit') {
                present(windowId);
            }
            await finishCreation(state, local, windowId);
            return;
        }
    } finally {
        if (!deferred) {
            forgetUndecided(originalId);
            forgetUndecided(tabId);
        }
    }
}

async function finishCreation(state, local, windowId) {
    await settleWindow(state, local, windowId);
    await persist(state);
    await publish(state);
}

async function handleRemoved(tabId, windowId) {
    const local = await loadSettings();
    const state = await loadOrInitialize(local);
    forgetTab(state, tabId);
    delete lastWindowOf(state)[tabId];
    delete arrivalsOf(state)[tabId];
    await settleWindow(state, local, windowId, { bump: true });
    await persist(state);
    await publish(state);
}

async function handleDetached(tabId, oldWindowId) {
    const local = await loadSettings();
    const state = await loadOrInitialize(local);
    forgetTab(state, tabId);
    const now = Date.now();
    dropStaleArrivals(state, now);
    const group = groupMoveFrom(state, oldWindowId, -1); // a group move that left this window
    if (group !== undefined) {
        arrivalsOf(state)[tabId] = { window: DEPARTING, at: now, group };
    } else {
        delete arrivalsOf(state)[tabId];
    }
    await settleWindow(state, local, oldWindowId, { bump: true });
    await persist(state);
    await publish(state);
}

// True when `tab` counts toward an over-limit window or an over-limit group
async function destinationIsOver(state, local, tab) {
    const { counted } = await readWindow(tab.windowId);
    const win = windowOf(state, tab.windowId);
    const excess = computeExcess(counted, configFor(local, tab.windowId), win.allowance);
    return excess.window.excess > 0 || (excess.groups[tab.groupId ?? -1]?.excess ?? 0) > 0;
}

// R3 for a group that arrives by a move: the tabs of that one move share one verdict,
// the rule for a single moved tab (destinationIsOver), set or cleared. Without this,
// the result would depend on how far the move had got when each tab's event was
// handled: the first tabs can fit and only the last push the window over, and a tab
// is judged as ungrouped until Chrome reports its group after the attach. Tabs
// already in the window, including ones that arrived by an earlier move, keep their
// own verdicts. Returns true if any is moved.
function judgeGroupArrival(win, counted, excess, groupId, move) {
    const over = excess.window.excess > 0 || (excess.groups[groupId]?.excess ?? 0) > 0;
    let flagged = false;
    for (const tab of counted) {
        if (tab.groupId !== groupId || groupMoveOf.get(tab.id) !== move || undecided.has(tab.id)) {
            continue;
        }
        if (over) {
            setStatus(win, tab.id, 'moved');
            flagged = true;
        } else if (win.moved.includes(tab.id)) {
            clearStatus(win, tab.id); // flagged while Chrome still reported it ungrouped
        }
    }
    return flagged;
}

async function handleAttached(tabId) {
    // Follow a replacement: this event may be about an ID Chrome has since swapped
    const tab = await currentTab(tabId);
    if (!tab) {
        return;
    }
    tabId = tab.id;
    const local = await loadSettings();
    const state = await loadOrInitialize(local);
    forgetTab(state, tabId); // a pending tab that moves is moved, not pending

    const win = windowOf(state, tab.windowId);
    if (!undecided.has(tabId) && (await destinationIsOver(state, local, tab))) {
        ensureOperation(win, state.startupMode ? 'startup' : 'normal');
        setStatus(win, tabId, 'moved'); // its group, if it moved with one, is judged when Chrome reports it
        touch(win);
        await presentAfterMove(state, tab.windowId, new Set([tabId]));
    } else if (win.op) {
        touch(win);
    }

    const now = Date.now();
    dropStaleArrivals(state, now);
    const group = departingMove(state, tabId) ?? groupMoveFrom(state, lastWindowOf(state)[tabId], tab.groupId ?? -1);
    if (group !== undefined) {
        arrivalsOf(state)[tabId] = { window: tab.windowId, at: now, group }; // judged again when its move ends
    } else {
        delete arrivalsOf(state)[tabId];
    }
    lastWindowOf(state)[tabId] = tab.windowId; // its move is handled: saved with its status
    await settleWindow(state, local, tab.windowId);
    await persist(state);
    await publish(state);
}

// Judge the marked arrivals in a window (all, or those `inCohort` accepts) under R3, on
// the window as it is now: moved if the window or the tab's own group is over,
// otherwise not. At one moment every tab of one group gets the same verdict. With
// `finish`, their markers are dropped: the move is over. Returns how many were judged
// and whether any status changed or a tab was flagged.
async function judgeArrivals(state, local, windowId, { now = Date.now(), inCohort = () => true, finish = false, also = new Set() } = {}) {
    const result = { judged: 0, ids: new Set(), changed: false, flagged: false };
    const { all } = await readWindow(windowId);
    const win = windowOf(state, windowId);
    for (const tab of all) {
        const marked = isFreshArrival(state, tab.id, windowId, now) || also.has(tab.id);
        if (!marked || undecided.has(tab.id) || !inCohort(tab)) {
            continue;
        }
        result.judged += 1;
        result.ids.add(tab.id);
        const wasMoved = win.moved.includes(tab.id);
        if (await destinationIsOver(state, local, tab)) {
            ensureOperation(win, state.startupMode ? 'startup' : 'normal');
            setStatus(win, tab.id, 'moved');
            result.flagged = true;
            result.changed ||= !wasMoved;
        } else if (wasMoved) {
            clearStatus(win, tab.id);
            result.changed = true;
        }
        if (finish) {
            delete arrivalsOf(state)[tab.id];
        }
    }
    if (result.changed) {
        touch(win);
    }
    return result;
}

// Chrome reports a group created in a window after all its tabs have arrived there, so
// for a group that moved this is where its move ends: its arrivals get their verdict
// together and their markers go. A group created from tabs already in the window has
// no marked tabs, and nothing changes.
async function handleGroupArrived(groupId, windowId) {
    const local = await loadSettings();
    const state = await loadOrInitialize(local);
    // A tab is judged with the group only if it is in the group: a lone tab that left
    // the same window while the move was open was marked with it provisionally (Codex)
    const result = await judgeArrivals(state, local, windowId, {
        inCohort: (tab) => arrivalsOf(state)[tab.id]?.group === groupId && (tab.groupId ?? -1) === groupId,
        finish: true
    });
    // The move has ended: no marker of it is left in this window, so nothing judges
    // again, at a restart, a tab that never joined the group (its own attach decided it)
    const arrivals = arrivalsOf(state);
    for (const [tabId, arrival] of Object.entries(arrivals)) {
        if (arrival.group === groupId && arrival.window === windowId) {
            delete arrivals[tabId];
        }
    }
    const wasOpen = groupId in openMovesOf(state);
    delete openMovesOf(state)[groupId];
    if (result.judged === 0 && !wasOpen) {
        return;
    }
    if (result.flagged && result.changed) {
        await presentAfterMove(state, windowId, result.ids);
    }
    await settleWindow(state, local, windowId);
    await persist(state);
    await publish(state);
}

// A group left a window: if it is moving, its tabs arrive elsewhere next, and their
// verdict waits for the move's end (handleGroupArrived)
async function handleGroupLeft(groupId, windowId) {
    const state = await loadOrInitialize(await loadSettings());
    openMovesOf(state)[groupId] = { from: windowId, at: Date.now() };
    await persist(state);
}

async function handleGroupChanged(tabId) {
    // Follow a replacement: this event may be about an ID Chrome has since swapped
    const tab = await currentTab(tabId);
    if (!tab) {
        return;
    }
    tabId = tab.id;
    if (undecided.has(tabId)) {
        return; // the creation task reads the group itself
    }

    const local = await loadSettings();
    const state = await loadOrInitialize(local);
    const win = windowOf(state, tab.windowId);
    const { counted } = await readWindow(tab.windowId);
    const excess = computeExcess(counted, configFor(local, tab.windowId), win.allowance);
    const groupId = tab.groupId ?? -1;
    const move = groupMoveOf.get(tabId);

    if (move !== undefined && move.startsWith(`${groupId}:`)) {
        // Its group arrived by a move and Chrome now reports the group (it does so after
        // the attach): the tabs of that move are judged together under R3, at their real
        // destination group
        ensureOperation(win, state.startupMode ? 'startup' : 'normal');
        if (judgeGroupArrival(win, counted, excess, groupId, move)) {
            const thisMove = counted.filter((t) => groupMoveOf.get(t.id) === move).map((t) => t.id);
            await presentAfterMove(state, tab.windowId, new Set([tabId, ...thisMove]));
        }
        touch(win);
    } else if ((excess.groups[groupId]?.excess ?? 0) > 0) {
        // Moving into an over group protects the tab; it is no longer pending (C2)
        ensureOperation(win, state.startupMode ? 'startup' : 'normal');
        setStatus(win, tabId, 'moved');
        touch(win);
        await presentAfterMove(state, tab.windowId, new Set([tabId]));
    } else if (win.op) {
        touch(win);
    }

    await settleWindow(state, local, tab.windowId);
    await persist(state);
    await publish(state);
}

// A tab navigated: any selection made on the old view is stale (R3).
// Only the revision changes; the URL is never stored.
async function handleNavigated(tabId) {
    // Follow a replacement: this event may be about an ID Chrome has since swapped
    const tab = await currentTab(tabId);
    if (!tab) {
        return;
    }
    tabId = tab.id;
    const state = await loadState(chrome.storage.session);
    const win = state?.windows[tab.windowId];
    if (!win?.op) {
        return;
    }
    touch(win);
    await persist(state);
    broadcast(state);
}

async function handleReplaced(addedTabId, removedTabId) {
    const local = await loadSettings();
    const state = await loadOrInitialize(local);
    for (const win of Object.values(state.windows)) {
        let changed = false;
        const swap = (id) => {
            if (id === removedTabId) {
                changed = true;
                return addedTabId;
            }
            return id;
        };
        win.pending = win.pending.map(swap);
        win.moved = win.moved.map(swap);
        win.startup = win.startup.map(swap);
        if (win.op) {
            win.op.closing = win.op.closing.map(swap);
        }
        if (changed) {
            touch(win);
        }
    }
    for (const map of [lastWindowOf(state), arrivalsOf(state)]) {
        if (removedTabId in map) {
            map[addedTabId] ??= map[removedTabId];
            delete map[removedTabId];
        }
    }
    replacedBy.delete(removedTabId); // any task holding the old ID has finished: it ran earlier in the queue
    await persist(state);
    broadcast(state);
}

// Settings changed (limits or the pending cap): reconcile every window now, so
// the badge and an open popup are current and no stale operation is left (REG-04).
// An operation that stays open may now show different constraints, so its
// revision advances and the popup refreshes and drops its selection (REG-04b).
async function handleSettingsChanged(changedKeys) {
    // A group's custom limit names no window (its group may be anywhere), so a change
    // to one, or to the session tag, affects every window like the default does
    const everyWindow = changedKeys.some(
        (key) => key === 'defaultTabLimit' || key === 'maxPendingPerWindow' || key === 'groupLimitSession' || key.startsWith('groupOverride_')
    );
    const affected = new Set();
    for (const key of changedKeys) {
        const match = /^(?:tabLimit_|groupLimit_)(\d+)/.exec(key);
        if (match) {
            affected.add(Number(match[1]));
        }
    }

    const local = await loadSettings();
    const state = await loadOrInitialize(local);
    for (const { id: windowId } of await chrome.windows.getAll()) {
        const result = await settleWindow(state, local, windowId);
        if (result?.win.op && (everyWindow || affected.has(windowId))) {
            touch(result.win);
        }
    }
    await persist(state);
    await publish(state);
}

async function handleWindowRemoved(windowId) {
    const state = await loadOrInitialize(await loadSettings());
    delete state.windows[windowId];
    excessByWindow.delete(windowId);
    lastPresented.delete(windowId);

    // This window's own limits are no longer needed. Custom group limits are kept:
    // they name no window, and the group may be alive in another one (it may be the
    // source of a move, or a temporary drag window).
    try {
        await chrome.storage.local.remove([`tabLimit_${windowId}`, `groupLimit_${windowId}_ungrouped`]);
    } catch (error) {
        safeErrorLog('Error removing window settings', error);
    }

    await persist(state);
    await publish(state);
}

// ------------------------------------------------------- popup commands (§6)

const fail = (error) => ({ success: false, error });
const STALE_MESSAGE = 'The tabs changed; please review again';

// A per-window command must match the open operation exactly
function checkOperation(state, request) {
    if (gate.pending) {
        return { error: GATE_MESSAGE };
    }
    const win = state.windows[request.windowId];
    if (!win?.op) {
        return { error: 'There is nothing to decide in this window' };
    }
    if (win.op.opId !== request.opId || win.op.revision !== request.revision) {
        return { error: STALE_MESSAGE };
    }
    if (win.op.phase !== 'open') {
        return { error: 'A closing operation is already running' };
    }
    return { win };
}

// Close tabs one at a time, re-checking each. A tab that moved, vanished or
// changed group is skipped, and the last tab in the window is never closed.
// A tab that navigated after the command arrived is skipped: the page the user
// chose to close is no longer the page they saw (R3, REG-02). Returns how many
// tabs were closed and whether any was skipped for that reason.
const navigatedSince = (tabId, since) => (navigatedAt.get(tabId) ?? 0) > since;

// R3: a URL change on ANY tab in the window invalidates a selection made on the
// view the user saw, because every tab in it is selectable
const windowNavigatedSince = (windowId, since) => (windowNavAt.get(windowId) ?? 0) > since;

async function closeTabsGuarded(windowId, expected, since) {
    let closed = 0;
    let stale = false;
    let gated = false;
    for (const { id, groupId } of expected) {
        if (gate.pending) {
            gated = true; // the browser started while this ran: stop (startup gate)
            break;
        }
        if (navigatedSince(id, since) || windowNavigatedSince(windowId, since)) {
            stale = true;
            continue;
        }
        let tab;
        try {
            tab = await chrome.tabs.get(id);
        } catch {
            continue;
        }
        if (tab.windowId !== windowId || (tab.groupId ?? -1) !== groupId) {
            continue;
        }
        const remaining = await chrome.tabs.query({ windowId });
        if (remaining.length <= 1) {
            break;
        }
        if (navigatedSince(id, since) || windowNavigatedSince(windowId, since)) {
            stale = true;
            continue;
        }
        if (gate.pending) {
            gated = true;
            break;
        }
        try {
            await chrome.tabs.remove(id);
            closed += 1;
        } catch (error) {
            safeErrorLog('Error closing tab', error);
        }
    }
    return { closed, stale, gated };
}

// Record the decision, close the tabs, then reconcile from the real tabs
async function carryOutClosing(state, local, windowId, expected, since) {
    if (windowNavigatedSince(windowId, since) || expected.some((tab) => navigatedSince(tab.id, since))) {
        return fail(STALE_MESSAGE); // a tab in this window navigated while the command waited
    }
    if (gate.pending) {
        return fail(GATE_MESSAGE); // the browser started while the command waited
    }
    const win = state.windows[windowId];
    const wasStartupMode = state.startupMode;
    win.op.phase = 'closing';
    win.op.closing = expected.map((tab) => tab.id);
    state.startupMode = false; // the user's first decision
    await persist(state);

    const { closed, stale, gated } = await closeTabsGuarded(windowId, expected, since);
    if (gated && closed === 0) {
        state.startupMode = wasStartupMode; // stopped before acting: no decision was made
    }

    await settleWindow(state, local, windowId, { endClosing: true, bump: true });
    await persist(state);
    await publish(state);
    if (gated) {
        return fail(GATE_MESSAGE);
    }
    return stale ? fail(STALE_MESSAGE) : { success: true };
}

async function cmdCloseSelected(request, since) {
    const local = await loadSettings();
    const state = await loadOrInitialize(local);
    await refreshWindow(state, local, request.windowId);
    const checked = checkOperation(state, request);
    if (checked.error) {
        return fail(checked.error);
    }

    const { all, counted } = await readWindow(request.windowId);
    const byId = new Map(counted.map((tab) => [tab.id, tab]));
    const selection = request.tabIds;

    if (!selection.every((id) => byId.has(id))) {
        return fail('A selected tab is no longer in this window');
    }
    if (selection.length >= all.length) {
        return fail('This would close every tab in the window');
    }
    const config = configFor(local, request.windowId);
    if (!resolvesAll(counted, selection, config, checked.win.allowance)) {
        return fail('Closing these tabs would not resolve every limit');
    }

    return carryOutClosing(state, local, request.windowId, selection.map((id) => byId.get(id)), since);
}

async function cmdClosePending(request, since) {
    const local = await loadSettings();
    const state = await loadOrInitialize(local);
    await refreshWindow(state, local, request.windowId);
    const checked = checkOperation(state, request);
    if (checked.error) {
        return fail(checked.error);
    }

    const { win } = checked;
    const { all, counted } = await readWindow(request.windowId);
    const pendingIds = new Set(win.pending);
    const byId = new Map(counted.map((tab) => [tab.id, tab]));
    const targets = win.pending.filter((id) => byId.has(id)).map((id) => byId.get(id));

    if (targets.length === 0) {
        return fail('There are no new tabs to close');
    }
    if (!all.some((tab) => !pendingIds.has(tab.id))) {
        return fail('Closing these would close the window; choose tabs instead');
    }

    return carryOutClosing(state, local, request.windowId, targets, since);
}

async function cmdKeepThese(request) {
    const local = await loadSettings();
    const state = await loadOrInitialize(local);
    await refreshWindow(state, local, request.windowId);
    const checked = checkOperation(state, request);
    if (checked.error) {
        return fail(checked.error);
    }

    const { win } = checked;
    if (win.op.kind !== 'startup') {
        return fail('Only tabs left over from a browser start can be kept');
    }

    const { counted } = await readWindow(request.windowId);
    if (gate.pending) {
        return fail(GATE_MESSAGE); // the browser started while the command waited: no allowance
    }
    const eligible = keepEligibleIds(counted, { pending: win.pending, moved: win.moved });
    const config = configFor(local, request.windowId);
    win.allowance = keepAllowance(win.allowance, counted, eligible, config) ?? { window: null, groups: {} };
    win.startup = [];
    state.startupMode = false; // the user's first decision
    touch(win);

    await settleWindow(state, local, request.windowId);
    await persist(state);
    await publish(state);
    return { success: true };
}

// Global (D4): no window, operation or revision. Changes nothing but the mode.
async function cmdStartEnforcing() {
    const state = await loadOrInitialize(await loadSettings());
    state.startupMode = false;
    await persist(state);
    broadcast(state);
    return { success: true };
}

async function titleOfGroup(windowId, groupId) {
    try {
        const groups = await chrome.tabGroups.query({ windowId });
        return groups.find((g) => g.id === groupId)?.title || `Group ${groupId}`;
    } catch {
        return `Group ${groupId}`;
    }
}

// What the popup shows. Titles and icons are read live and never stored.
async function cmdGetState(request) {
    const local = await loadSettings();
    const state = await loadOrInitialize(local);
    await refreshWindow(state, local, request.windowId);
    const win = state.windows[request.windowId];
    const response = {
        success: true,
        startupMode: state.startupMode,
        groupLimitsPaused: groupLimitsPaused(),
        maxPending: pendingCapFor(local),
        // Windows still holding a startup operation: "Start enforcing now" leaves them open (D4)
        startupOperations: Object.values(state.windows).filter((w) => w.op?.kind === 'startup').length,
        operation: null
    };

    if (!win?.op) {
        return response;
    }

    const { all, counted } = await readWindow(request.windowId);
    const config = configFor(local, request.windowId);
    const excess = computeExcess(counted, config, win.allowance);
    const countedIds = new Set(counted.map((tab) => tab.id));
    const pendingIds = new Set(win.pending);

    const constraints = [];
    if (excess.window.excess > 0) {
        constraints.push({ id: 'window', scope: 'window', ...excess.window });
    }
    for (const [groupId, info] of Object.entries(excess.groups)) {
        if (info.excess > 0) {
            constraints.push({
                id: `group:${groupId}`,
                scope: 'group',
                groupId: Number(groupId),
                title: Number(groupId) === -1 ? 'Ungrouped tabs' : await titleOfGroup(request.windowId, Number(groupId)),
                ...info
            });
        }
    }

    const statusOf = (id) => (win.pending.includes(id) ? 'pending' : win.moved.includes(id) ? 'moved' : win.startup.includes(id) ? 'startup' : 'ordinary');
    const tabs = all
        .filter((tab) => countedIds.has(tab.id))
        .map((tab) => {
            const groupId = tab.groupId ?? -1;
            const reduces = constraints
                .filter((c) => c.scope === 'window' || c.groupId === groupId)
                .map((c) => c.id);
            return {
                id: tab.id,
                title: tab.title || '',
                groupId,
                status: statusOf(tab.id),
                reduces
            };
        });

    response.operation = {
        opId: win.op.opId,
        revision: win.op.revision,
        kind: win.op.kind,
        phase: win.op.phase,
        rejectedCount: win.op.rejectedCount,
        constraints,
        tabs,
        canKeep: win.op.kind === 'startup',
        pendingCount: win.pending.length,
        canClosePending: win.pending.length > 0 && all.some((tab) => !pendingIds.has(tab.id))
    };
    return response;
}

// Save a custom limit from the popup. Every write of a group's custom limit goes
// through this queue, so it never interleaves with adoption at a worker start. A
// group's limit is stored under the current session tag and replaces any legacy key
// for that group; the ungrouped limit stays with its window.
async function cmdSetGroupLimit(request) {
    const { windowId, groupId, limit } = request;
    // Saved under the new session's tag, never one about to be replaced. The rotation
    // runs ahead of this in the queue; if it failed, it is tried again first.
    if (gate.pending && !(await rotateSessionTag())) {
        return fail('Limits are being updated after the browser start; please try again');
    }
    try {
        if (groupId === -1) {
            await chrome.storage.local.set({ [`groupLimit_${windowId}_ungrouped`]: limit });
            return { success: true };
        }
        const local = await loadSettings();
        await chrome.storage.local.set({ [groupOverrideKey(sessionTagOf(local), groupId)]: limit });
        await removeLegacyKeysOf(local, groupId);
        return { success: true };
    } catch (error) {
        safeErrorLog('Error saving group limit', error);
        return fail('The limit could not be saved; please try again');
    }
}

// Best effort: the limit is already saved, and a legacy key is never read as a limit
async function removeLegacyKeysOf(local, groupId) {
    const legacy = Object.keys(local).filter((key) => parseLegacyGroupLimitKey(key)?.groupId === groupId);
    if (legacy.length === 0) {
        return;
    }
    try {
        await chrome.storage.local.remove(legacy);
    } catch (error) {
        safeErrorLog('Error removing an old group limit', error);
    }
}

const COMMANDS = {
    getState: cmdGetState,
    setGroupLimit: cmdSetGroupLimit,
    closeSelected: cmdCloseSelected,
    closePending: cmdClosePending,
    keepThese: cmdKeepThese,
    startEnforcing: cmdStartEnforcing
};

// ----------------------------------------------------------------- wiring

chrome.tabs.onCreated.addListener((tab) => {
    announcedUpTo = Math.max(announcedUpTo, tab.id);
    undecided.add(tab.id); // synchronously, before the task is queued
    const movesBefore = moveSeq;
    runEvent('tab creation', () => handleCreated(tab.id, movesBefore));
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    noteWindowChange(removeInfo.windowId);
    undecided.delete(tabId);
    navigatedAt.delete(tabId);
    movedAt.delete(tabId);
    groupMoveOf.delete(tabId);
    runEvent('tab removal', () => handleRemoved(tabId, removeInfo.windowId));
});

chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
    moveSeq += 1; // noted now, before the queued task runs (REG-01a)
    movedAt.set(tabId, moveSeq);
    noteWindowChange(detachInfo.oldWindowId);
    runEvent('tab detach', () => handleDetached(tabId, detachInfo.oldWindowId));
});

chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
    moveSeq += 1;
    movedAt.set(tabId, moveSeq);
    noteWindowChange(attachInfo?.newWindowId);
    runEvent('tab attach', () => handleAttached(tabId));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url !== undefined) {
        navSeq += 1; // noted now, before the queued task runs (REG-02)
        navigatedAt.set(tabId, navSeq);
        if (tab?.windowId !== undefined) {
            windowNavAt.set(tab.windowId, navSeq);
        }
        runEvent('navigation', () => handleNavigated(tabId));
    }
    if (changeInfo.groupId !== undefined) {
        noteWindowChange(tab?.windowId);
        // Noted now: does this tab join its group's move in progress?
        const startedAt = openGroupMoves.get(changeInfo.groupId);
        if (startedAt !== undefined && (movedAt.get(tabId) ?? 0) > startedAt) {
            groupMoveOf.set(tabId, `${changeInfo.groupId}:${startedAt}`);
        } else {
            groupMoveOf.delete(tabId);
        }
        runEvent('group change', () => handleGroupChanged(tabId));
    }
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    announcedUpTo = Math.max(announcedUpTo, addedTabId); // the replacement is a known tab
    replacedBy.set(removedTabId, addedTabId);
    for (const map of [navigatedAt, movedAt, groupMoveOf]) {
        if (map.has(removedTabId)) {
            map.set(addedTabId, map.get(removedTabId));
            map.delete(removedTabId);
        }
    }
    if (undecided.delete(removedTabId)) {
        undecided.add(addedTabId); // the task that holds the old ID decides the new one too
    }
    runEvent('tab replacement', () => handleReplaced(addedTabId, removedTabId));
});

chrome.runtime.onStartup.addListener(() => {
    // Noted now, before any queued task runs: the startup gate is on
    gate.pending = true;
    gate.tag = crypto.randomUUID();
    // The limits that apply have changed (no group limit applies now): an admission
    // in progress decides again before it closes anything (REG-04a)
    settingsSeq += 1;
    globalSettingsAt = settingsSeq;
    announceGroupLimitsPaused();
    runEvent('browser start', rotateSessionTag);
});

chrome.tabGroups.onRemoved.addListener((group) => {
    openGroupMoves.set(group.id, moveSeq); // noted now, before the group's tabs move
    noteWindowChange(group.windowId);
    runEvent('group left', () => handleGroupLeft(group.id, group.windowId));
});

chrome.tabGroups.onCreated.addListener((group) => {
    openGroupMoves.delete(group.id); // the move, if any, has arrived
    noteWindowChange(group.windowId);
    runEvent('group arrival', () => handleGroupArrived(group.id, group.windowId));
});

chrome.storage.onChanged.addListener((changes, area) => {
    const keys = Object.keys(changes).filter((key) =>
        /^(defaultTabLimit|tabLimit_|groupLimit_|groupOverride_|groupLimitSession$|maxPendingPerWindow)/.test(key)
    );
    if (area === 'local' && keys.length > 0) {
        settingsSeq += 1; // noted now, so an admission in progress can notice (REG-04a)
        for (const key of keys) {
            const match = /^(?:tabLimit_|groupLimit_)(\d+)/.exec(key);
            if (match) {
                windowSettingsAt.set(Number(match[1]), settingsSeq);
            } else {
                globalSettingsAt = settingsSeq;
            }
        }
        runEvent('settings change', () => handleSettingsChanged(keys));
    }
});

chrome.windows.onRemoved.addListener((windowId) => {
    windowNavAt.delete(windowId);
    windowSettingsAt.delete(windowId);
    runEvent('window removal', () => handleWindowRemoved(windowId));
});

chrome.runtime.onConnect.addListener((port) => {
    if (!isTrustedSender(port.sender, { id: chrome.runtime.id, origin: chrome.runtime.getURL('') })) {
        port.disconnect();
        return;
    }
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!isTrustedSender(sender, { id: chrome.runtime.id, origin: chrome.runtime.getURL('') })) {
        console.warn('Rejected message from untrusted sender');
        sendResponse({ success: false, error: 'Untrusted sender' });
        return;
    }

    const validation = validateMessageRequest(request);
    if (!validation.valid) {
        console.warn('Message validation failed');
        sendResponse({ success: false, error: 'Invalid message data' });
        return;
    }

    const arrivedAt = navSeq; // navigations heard after this point invalidate the selection
    queue
        .enqueue(() => COMMANDS[request.action](request, arrivedAt))
        .then(sendResponse)
        .catch((error) => {
            safeErrorLog(`Error handling ${request.action}`, error);
            sendResponse(fail('Something went wrong; please try again'));
        });

    return true; // the response is sent asynchronously
});

// Initialize on service worker startup (queued first, so events wait for it)
initialize().catch((error) => safeErrorLog('Error initializing', error));
