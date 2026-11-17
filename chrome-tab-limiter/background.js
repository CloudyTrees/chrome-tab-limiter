// Background service worker for Tab Limiter.
//
// Enforcement model: "keep-pending" (REVIEW.md, consolidated plan). A new tab
// that would exceed a limit stays open as *pending* until the user decides in
// the popup; at most `maxPendingPerWindow` tabs wait, and later ones are
// rejected. Nothing is closed automatically after a browser start until the
// user's first decision ("startup mode"). No URL is ever stored or recreated.
//
// Every event and popup command is a task on one serial queue. A task loads the
// state, reads the real tabs, decides, saves, performs side effects, reconciles
// from the real tabs and saves again.

import { removeWindowData, removeAllGroupData, DEFAULT_TAB_LIMIT } from './utils/storage.js';
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
import { createState, createWindowState, loadState, saveState } from './utils/state-store.js';

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
let settingsSeq = 0;
let globalSettingsAt = 0; // default limit or pending cap: affects every window
const windowSettingsAt = new Map(); // window ID -> latest change of a limit that is specific to it

// Did a setting that affects this window's admission change after `since`?
// (A limit stored for another window does not.)
const settingsChangedSince = (windowId, since) =>
    globalSettingsAt > since || (windowSettingsAt.get(windowId) ?? 0) > since;

// Highest tab ID whose creation we have heard about. Chrome assigns tab IDs in
// increasing order and delivers onCreated in that order, so a tab with a higher
// ID exists but has not been announced yet: it is not counted until its own
// creation task runs. Without this, a burst of new tabs would be counted
// before it was decided, and the first tabs would wrongly look like excess.
let announcedUpTo = 0;

// Total excess per window, for the badge. Rebuilt by every reconciliation.
const excessByWindow = new Map();

// Popup ports that want to hear about state changes
const ports = new Set();

// Last time the popup was opened automatically, per window
const lastPresented = new Map();

// ---------------------------------------------------------------- settings

function configFor(local, windowId) {
    const defaultLimit = local.defaultTabLimit || DEFAULT_TAB_LIMIT;
    const groupLimits = {};
    const prefix = `groupLimit_${windowId}_`;

    for (const [key, value] of Object.entries(local)) {
        if (key.startsWith(prefix) && value) {
            const part = key.slice(prefix.length);
            const groupId = part === 'ungrouped' ? -1 : Number(part);
            if (Number.isInteger(groupId)) {
                groupLimits[groupId] = value;
            }
        }
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

function broadcast(state) {
    const revisions = {};
    for (const [windowId, win] of Object.entries(state.windows)) {
        revisions[windowId] = win.op ? win.op.revision : null;
    }
    for (const port of [...ports]) {
        try {
            port.postMessage({ type: 'state', startupMode: state.startupMode, revisions });
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
        const { counted } = await readWindow(windowId);
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
    for (const { id: windowId } of windows) {
        const tabs = await chrome.tabs.query({ windowId });
        announceExisting(tabs);
        for (const tab of tabs) {
            tabWindow.set(tab.id, windowId);
        }
    }

    // A tracked tab found in another window was moved while the worker was gone
    const movedIn = new Map();
    for (const [windowKey, win] of Object.entries(state.windows)) {
        const windowId = Number(windowKey);
        const tracked = new Set([...win.pending, ...win.moved, ...win.startup, ...(win.op?.closing ?? [])]);
        for (const tabId of tracked) {
            const real = tabWindow.get(tabId);
            if (real !== undefined && real !== windowId) {
                clearStatus(win, tabId);
                (movedIn.get(real) ?? movedIn.set(real, []).get(real)).push(tabId);
            }
        }
        if (!realIds.has(windowId)) {
            delete state.windows[windowKey];
        }
    }

    excessByWindow.clear();
    for (const windowId of realIds) {
        const win = windowOf(state, windowId);
        for (const tabId of movedIn.get(windowId) ?? []) {
            setStatus(win, tabId, 'moved');
        }
        await settleWindow(state, local, windowId, { endClosing: true });
    }

    await persist(state);
    await publish(state);
}

function initialize() {
    return queue.enqueue(async () => {
        const local = await loadSettings();
        const state = await loadState(chrome.storage.session);
        if (state) {
            await reconcileAll(state, local);
        } else {
            await initializeState(local);
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
            if (settingsChangedSince(windowId, settingsAt)) {
                if (attempt < MAX_ATTEMPTS) {
                    continue;
                }
                return deferDecision();
            }

            const decision = decideCreation({
                tabs: counted,
                groupId: tab.groupId ?? -1,
                config: configFor(local, windowId),
                allowance: win.allowance,
                startupMode: state.startupMode,
                hasOperation: Boolean(win.op),
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

                if (settingsChangedSince(windowId, settingsAt)) {
                    if (attempt < MAX_ATTEMPTS) {
                        continue; // decide again under the new settings
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
    await settleWindow(state, local, windowId, { bump: true });
    await persist(state);
    await publish(state);
}

async function handleDetached(tabId, oldWindowId) {
    const local = await loadSettings();
    const state = await loadOrInitialize(local);
    forgetTab(state, tabId);
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
        setStatus(win, tabId, 'moved');
        touch(win);
        present(tab.windowId);
    } else if (win.op) {
        touch(win);
    }

    await settleWindow(state, local, tab.windowId);
    await persist(state);
    await publish(state);
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

    if ((excess.groups[tab.groupId ?? -1]?.excess ?? 0) > 0) {
        // Moving into an over group protects the tab; it is no longer pending (C2)
        ensureOperation(win, state.startupMode ? 'startup' : 'normal');
        setStatus(win, tabId, 'moved');
        touch(win);
        present(tab.windowId);
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
    replacedBy.delete(removedTabId); // any task holding the old ID has finished: it ran earlier in the queue
    await persist(state);
    broadcast(state);
}

// Settings changed (limits or the pending cap): reconcile every window now, so
// the badge and an open popup are current and no stale operation is left (REG-04).
// An operation that stays open may now show different constraints, so its
// revision advances and the popup refreshes and drops its selection (REG-04b).
async function handleSettingsChanged(changedKeys) {
    const everyWindow = changedKeys.some((key) => key === 'defaultTabLimit' || key === 'maxPendingPerWindow');
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

    // Stored limits for this window are no longer needed
    await removeWindowData(windowId);
    await removeAllGroupData(windowId);

    await persist(state);
    await publish(state);
}

// ------------------------------------------------------- popup commands (§6)

const fail = (error) => ({ success: false, error });
const STALE_MESSAGE = 'The tabs changed; please review again';

// A per-window command must match the open operation exactly
function checkOperation(state, request) {
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
    for (const { id, groupId } of expected) {
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
        try {
            await chrome.tabs.remove(id);
            closed += 1;
        } catch (error) {
            safeErrorLog('Error closing tab', error);
        }
    }
    return { closed, stale };
}

// Record the decision, close the tabs, then reconcile from the real tabs
async function carryOutClosing(state, local, windowId, expected, since) {
    if (windowNavigatedSince(windowId, since) || expected.some((tab) => navigatedSince(tab.id, since))) {
        return fail(STALE_MESSAGE); // a tab in this window navigated while the command waited
    }
    const win = state.windows[windowId];
    win.op.phase = 'closing';
    win.op.closing = expected.map((tab) => tab.id);
    state.startupMode = false; // the user's first decision
    await persist(state);

    const { stale } = await closeTabsGuarded(windowId, expected, since);

    await settleWindow(state, local, windowId, { endClosing: true, bump: true });
    await persist(state);
    await publish(state);
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

const COMMANDS = {
    getState: cmdGetState,
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
    undecided.delete(tabId);
    navigatedAt.delete(tabId);
    movedAt.delete(tabId);
    runEvent('tab removal', () => handleRemoved(tabId, removeInfo.windowId));
});

chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
    moveSeq += 1; // noted now, before the queued task runs (REG-01a)
    movedAt.set(tabId, moveSeq);
    runEvent('tab detach', () => handleDetached(tabId, detachInfo.oldWindowId));
});

chrome.tabs.onAttached.addListener((tabId) => {
    moveSeq += 1;
    movedAt.set(tabId, moveSeq);
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
        runEvent('group change', () => handleGroupChanged(tabId));
    }
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    announcedUpTo = Math.max(announcedUpTo, addedTabId); // the replacement is a known tab
    replacedBy.set(removedTabId, addedTabId);
    for (const map of [navigatedAt, movedAt]) {
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

chrome.storage.onChanged.addListener((changes, area) => {
    const keys = Object.keys(changes).filter((key) => /^(defaultTabLimit|tabLimit_|groupLimit_|maxPendingPerWindow)/.test(key));
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
