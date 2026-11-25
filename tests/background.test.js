import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { createChromeMock, flush, EXTENSION_ID, EXTENSION_ORIGIN } from './helpers/chrome-mock.js';
import { loadTrace, setupOf, initialTabs, initialGroups, scenarioSteps, replay } from './helpers/trace-replay.js';

// background.js is an ES module with top-level side effects (it registers
// listeners and reconciles on load). Each import with a unique query string
// gives a fresh module instance, simulating a fresh service worker.
let instance = 0;
async function startServiceWorker(harness, { settle = true } = {}) {
    await harness.startWorker(() => import(new URL(`../extension/background.js?sw=${++instance}`, import.meta.url)));
    if (settle) await flush();
}

const POPUP = { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}popup.html` };

// The options page's settings functions (a classic script; see export-import.test.js)
const EXPORT_IMPORT = readFileSync(new URL('../extension/utils/export-import.js', import.meta.url), 'utf8');
function optionsPage() {
    const window = {};
    new Function('window', 'chrome', EXPORT_IMPORT)(window, harness.chrome);
    return window.TabLimiterExportImport;
}
const resetSettings = async () => {
    await optionsPage().resetAllSettings();
    await flush();
};
const importReplacing = async () => {
    await optionsPage().importSettings({ version: '1.0.0', settings: { defaultTabLimit: 10, windowLimits: {}, groupLimits: {} } });
    await flush();
};
const GATE_MESSAGE = 'Limits are being updated after the browser start; please review again';
const sessionTag = () => harness.chrome.storage.local._dump().groupLimitSession;
// A group's custom limit as the popup saves it in a session that hasn't rotated its tag
const groupLimit = (groupId, limit) => ({ [`groupOverride_0_${groupId}`]: limit });
let harness;

const cmd = (request, sender = POPUP) => harness.sendMessage(request, sender);
const getState = async (windowId = 1) => cmd({ action: 'getState', windowId });
const getOp = async (windowId = 1) => (await getState(windowId)).operation;
const savedState = async () => (await harness.chrome.storage.session.get('tl_state')).tl_state;
const decide = (op, extra = {}) => ({ windowId: 1, opId: op.opId, revision: op.revision, ...extra });
const startEnforcing = () => cmd({ action: 'startEnforcing' });
const workerRestart = async () => {
    harness.resetListeners();
    await startServiceWorker(harness);
};
// A browser restart: the worker is torn down, storage.session is cleared, and a new
// worker starts. Chrome then delivers runtime.onStartup. The lifecycle check
// (docs/review.md) saw the worker's start-up code run first and onStartup arrive 87 ms
// later, before every restored event.
//   renumber:    restored windows, tabs and groups get new IDs, as in Chrome; returns the
//                maps. { groupIds: { [old]: new } } forces a restored group to reuse an ID.
//   beforeStart: (ids) => ..., run after renumbering and before the new worker starts
//   onStartup:   'after start-up' (the start-up pass finishes first), 'during start-up'
//                (delivered before the start-up pass has run), or 'never' (a start
//                the extension missed while it was disabled)
const browserRestart = async ({ renumber = false, beforeStart, onStartup = 'after start-up' } = {}) => {
    await harness.restartBrowser();
    const ids = renumber ? harness.renumber(renumber === true ? {} : renumber) : null;
    await beforeStart?.(ids);
    await startServiceWorker(harness, { settle: onStartup !== 'during start-up' });
    if (onStartup !== 'never') harness.fire('runtimeOnStartup');
    await flush();
    return ids;
};
// An extension reload or update within the browser session: the worker is torn
// down, storage.session is cleared (storage.local is kept), and the new worker
// receives runtime.onInstalled with reason 'update'. IDs don't change.
const extensionReload = async () => {
    await harness.restartBrowser();
    await startServiceWorker(harness);
    harness.fire('runtimeOnInstalled', { reason: 'update' });
    await flush();
};

// Open a tab in `windowId` and let the background react
async function open(windowId = 1, extra = {}) {
    const id = harness.userOpensTab({ windowId, pendingUrl: 'https://new.example/', ...extra });
    await flush();
    return id;
}
const openMany = async (count, windowId = 1, extra = {}) => {
    const ids = [];
    for (let i = 0; i < count; i++) ids.push(await open(windowId, extra));
    return ids;
};

// Window 1 holds 3 tabs and its limit is 3; window 2 holds one tab
async function setup({ limit = 3, enforce = true, tabs, local = {} } = {}) {
    harness = createChromeMock({
        tabs: tabs ?? [
            { id: 1, windowId: 1, url: 'https://a.example/' },
            { id: 2, windowId: 1, url: 'https://b.example/' },
            { id: 3, windowId: 1, url: 'https://c.example/' },
            { id: 10, windowId: 2, url: 'https://other.example/' }
        ]
    });
    await harness.chrome.storage.local.set({ defaultTabLimit: limit, ...local });
    await startServiceWorker(harness);
    if (enforce) {
        await startEnforcing(); // normal cap-only enforcement; startup mode is tested separately
    }
}

beforeEach(() => {
    mock.method(console, 'error', () => {});
    mock.method(console, 'warn', () => {});
});

afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
});

// ------------------------------------------------------------ 1. creation

describe('creation', () => {
    beforeEach(() => setup());

    it('admits a tab while under the limit', async () => {
        const id = await open(2);
        assert.ok(harness.tabIds(2).includes(id));
        assert.equal(await getOp(2), null);
        assert.equal(harness.calls.openPopup, 0);
    });

    it('keeps the first excess tab open as pending and opens the popup', async () => {
        const id = await open();

        assert.ok(harness.tabIds(1).includes(id), 'the tab stays open');
        const op = await getOp();
        assert.equal(op.kind, 'normal');
        assert.equal(op.canKeep, false);
        assert.equal(op.tabs.find((t) => t.id === id).status, 'pending');
        assert.equal(harness.calls.openPopup, 1);
        assert.equal(harness.calls.badge, '1');
    });

    it('leaves pending tabs open and badged when the popup cannot open', async () => {
        harness.failures.openPopup = true;
        const id = await open();
        await flush();

        assert.ok(harness.tabIds(1).includes(id));
        assert.equal(harness.calls.badge, '1');
        assert.ok(await getOp());
    });

    it('rejects the tab after the pending cap and counts it', async () => {
        const pending = await openMany(5);
        const sixth = await open();

        assert.deepEqual(pending.filter((id) => !harness.tabIds(1).includes(id)), [], 'five stay open');
        assert.equal(harness.tabIds(1).includes(sixth), false, 'the sixth is closed');
        const op = await getOp();
        assert.equal(op.rejectedCount, 1);
        assert.equal(op.pendingCount, 5);
    });

    it('handles a burst of 12 without bypassing the limit', async () => {
        // Window 2 has 1 tab (limit 3). Twelve tabs open before the background reacts.
        const ids = [];
        for (let i = 0; i < 12; i++) {
            ids.push(harness.userOpensTab({ windowId: 2, pendingUrl: `https://burst${i}.example/` }));
        }
        await flush(30);

        // 2 admitted up to capacity, 5 pending, 5 rejected
        assert.equal(harness.tabIds(2).length, 3 + 5);
        const op = await getOp(2);
        assert.equal(op.pendingCount, 5);
        assert.equal(op.rejectedCount, 5);
        assert.deepEqual(ids.filter((id) => harness.tabIds(2).includes(id)).length, 7);
    });

    it('applies a configurable cap, and lowering it closes nothing', async () => {
        await harness.chrome.storage.local.set({ maxPendingPerWindow: 4 });
        const pending = await openMany(4);
        assert.equal(harness.tabIds(1).length, 3 + 4);

        await harness.chrome.storage.local.set({ maxPendingPerWindow: 1 });
        await flush();
        assert.equal(harness.tabIds(1).length, 3 + 4, 'lowering the cap closed nothing');
        for (const id of pending) assert.ok(harness.tabIds(1).includes(id));

        const next = await open();
        assert.equal(harness.tabIds(1).includes(next), false, 'the next tab is rejected under the new cap');
    });

    it('falls back to the default cap for an invalid setting', async () => {
        await harness.chrome.storage.local.set({ maxPendingPerWindow: 99 });
        await openMany(6);
        assert.equal(harness.tabIds(1).length, 3 + 5);
    });

    it('enforces each window separately', async () => {
        await open(1);
        const id = await open(2);
        assert.ok(harness.tabIds(2).includes(id));
        assert.equal(await getOp(2), null);
    });

    it('C1: an open operation in group A also governs a new tab that fits group B', async () => {
        harness.groups.push({ id: 7, windowId: 1, title: 'Work', color: 'blue' });
        await harness.chrome.storage.local.set({ defaultTabLimit: 10, ...groupLimit(7, 1) });
        harness.setGroup(1, 7);
        harness.setGroup(2, 7); // group 7 now holds 2 tabs, limit 1
        await flush();
        const op = await getOp();
        assert.ok(op, 'group 7 is over');

        // Below the cap: a new ungrouped tab fits the window and its own group, but still joins as pending
        const below = await open(1, { groupId: -1 });
        assert.equal((await getOp()).tabs.find((t) => t.id === below).status, 'pending');

        // At the cap: further tabs are rejected even though they fit
        await openMany(4, 1, { groupId: -1 });
        const atCap = await open(1, { groupId: -1 });
        assert.equal(harness.tabIds(1).includes(atCap), false);
    });

    it('throttles automatic popups to once per window every 5 seconds', async () => {
        mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
        await open();
        await open();
        assert.equal(harness.calls.openPopup, 1);

        mock.timers.tick(5001);
        await open();
        assert.equal(harness.calls.openPopup, 2);
    });
});

// --------------------------------------------------- 2. movement and staleness

describe('movement and staleness', () => {
    beforeEach(() => setup());

    it('resolves the operation when tabs are closed by hand', async () => {
        const pending = await open();
        assert.ok(await getOp());
        await harness.chrome.tabs.remove(pending);
        await flush();

        assert.equal(await getOp(), null);
        assert.equal(harness.calls.badge, '');
    });

    it('any tab navigating invalidates the selection, a title change does not (R3)', async () => {
        await open();
        const before = (await getOp()).revision;

        harness.retitle(1, 'New title');
        await flush();
        assert.equal((await getOp()).revision, before, 'title only');

        harness.navigate(1, 'https://elsewhere.example/'); // an ordinary tab
        await flush();
        const afterNav = (await getOp()).revision;
        assert.ok(afterNav > before, 'ordinary tab navigated');
    });

    it('rejects a confirmation made against a stale revision', async () => {
        await open();
        const op = await getOp();
        harness.navigate(2, 'https://changed.example/');
        await flush();

        const response = await cmd({ action: 'closeSelected', ...decide(op, { tabIds: [1] }) });
        assert.equal(response.success, false);
        assert.ok(harness.tabIds(1).includes(1), 'nothing closed');
    });

    it('a tab moved into a full window is protected, never rejected, and not capped', async () => {
        await harness.chrome.storage.local.set({ maxPendingPerWindow: 1 });
        await harness.chrome.storage.local.set({ tabLimit_2: 10, groupLimit_2_ungrouped: 10 });
        const incoming = await openMany(4, 2);
        // Window 1 is full (3 of 3). Drag four tabs in; the pending cap (1) must not apply.
        for (const id of incoming) {
            harness.moveTab(id, 1);
            await flush();
        }

        for (const id of incoming) assert.ok(harness.tabIds(1).includes(id), 'moved tabs are kept');
        const op = await getOp();
        assert.deepEqual(op.tabs.filter((t) => t.status === 'moved').map((t) => t.id).sort(), incoming.sort());
        assert.equal(op.rejectedCount, 0);
    });

    it('moving a tab out resolves the source window', async () => {
        await open();
        const op = await getOp();
        const pendingId = op.tabs.find((t) => t.status === 'pending').id;

        harness.moveTab(pendingId, 2); // window 2 has room
        await flush();

        assert.equal(await getOp(1), null);
        assert.equal(await getOp(2), null);
    });

    it('C2: a pending tab moved into another full window becomes moved', async () => {
        await openMany(2); // window 1: 5 tabs, both pending
        const pendingId = (await getOp()).tabs.find((t) => t.status === 'pending').id;

        // Fill window 2 (limit 3) so the destination is over once the tab arrives
        await openMany(2, 2);
        harness.moveTab(pendingId, 2);
        await flush();

        const op2 = await getOp(2);
        assert.equal(op2.tabs.find((t) => t.id === pendingId).status, 'moved');
    });

    it('C2: a pending tab put into a group that is over becomes moved', async () => {
        harness.groups.push({ id: 7, windowId: 1, title: 'Work', color: 'blue' });
        await harness.chrome.storage.local.set(groupLimit(7, 1));
        harness.setGroup(1, 7);
        await flush();

        const pendingId = await open(1, { groupId: -1 });
        assert.equal((await getOp()).tabs.find((t) => t.id === pendingId).status, 'pending');

        harness.setGroup(pendingId, 7); // group 7 would hold 2, limit 1
        await flush();
        const status = (await getOp()).tabs.find((t) => t.id === pendingId).status;
        assert.equal(status, 'moved');
    });

    it('handles tab replacement by substituting the ID', async () => {
        const pending = await open();
        const before = (await getOp()).revision;

        harness.replaceTab(pending, 5000);
        await flush();

        const op = await getOp();
        assert.equal(op.tabs.find((t) => t.id === 5000).status, 'pending');
        assert.ok(op.revision > before);
    });

    it("cleans up a closed window's own limits and state, and keeps custom group limits", async () => {
        await harness.chrome.storage.local.set({ tabLimit_1: 4, groupLimit_1_ungrouped: 5, ...groupLimit(7, 2), tabLimit_2: 6 });
        await open();
        await harness.chrome.tabs.remove(harness.tabIds(1)); // closing its last tab closes the window
        await flush();

        // A group's limit names no window: its group may live on elsewhere (plan R1)
        assert.deepEqual(harness.chrome.storage.local._dump(), { defaultTabLimit: 3, ...groupLimit(7, 2), tabLimit_2: 6 });
        assert.equal((await savedState()).windows[1], undefined);
    });
});

// ---------------------------------------------------------------- commands

describe('closeSelected', () => {
    beforeEach(async () => {
        await setup();
        await open();
    });

    it('closes the chosen tabs when they resolve every limit, then the operation ends', async () => {
        const op = await getOp();
        const response = await cmd({ action: 'closeSelected', ...decide(op, { tabIds: [1] }) });

        assert.deepEqual(response, { success: true });
        assert.equal(harness.tabIds(1).includes(1), false);
        assert.equal(harness.tabIds(1).length, 3);
        await flush();
        assert.equal(await getOp(), null);
    });

    it('refuses a selection that does not resolve the limits', async () => {
        await open(); // two pending now: 5 tabs, limit 3
        const op = await getOp();
        const response = await cmd({ action: 'closeSelected', ...decide(op, { tabIds: [1] }) });

        assert.equal(response.success, false);
        assert.equal(harness.tabIds(1).length, 5, 'nothing closed');
    });

    it('refuses to close every tab in the window', async () => {
        await harness.chrome.storage.local.set({ tabLimit_1: 1 });
        await open();
        const op = await getOp();
        const all = harness.tabIds(1);
        const response = await cmd({ action: 'closeSelected', ...decide(op, { tabIds: all }) });

        assert.equal(response.success, false);
        assert.equal(harness.tabIds(1).length, all.length);
    });

    it('refuses a tab from another window', async () => {
        const op = await getOp();
        const response = await cmd({ action: 'closeSelected', ...decide(op, { tabIds: [10] }) });
        assert.equal(response.success, false);
        assert.ok(harness.tabIds(2).includes(10));
    });

    it('cannot be replayed or run twice at once', async () => {
        const op = await getOp();
        const request = { action: 'closeSelected', ...decide(op, { tabIds: [1] }) };
        const [first, second] = await Promise.all([cmd(request), cmd(request)]);

        assert.equal([first, second].filter((r) => r.success).length, 1, 'exactly one succeeds');
        assert.equal(harness.tabIds(1).length, 3, 'only one tab closed');
        assert.equal((await cmd(request)).success, false, 'a later replay fails too');
    });

    it('a partial tabs.remove failure reopens the operation with a new revision, never replayed', async () => {
        await open(); // 5 tabs: pending cap leaves two pending, limit 3 -> need to close 2
        const op = await getOp();
        harness.failures.removeTab = (id) => id === 2;

        const response = await cmd({ action: 'closeSelected', ...decide(op, { tabIds: [1, 2] }) });
        assert.equal(response.success, true);
        await flush();

        assert.equal(harness.tabIds(1).includes(1), false, 'tab 1 was closed');
        assert.equal(harness.tabIds(1).includes(2), true, 'tab 2 failed to close');
        const after = await getOp();
        assert.ok(after, 'still over: the operation reopens');
        assert.equal(after.phase, 'open');
        assert.ok(after.revision > op.revision);
        const attempts = harness.calls.removeAttempts.filter((id) => id === 2).length;
        assert.equal(attempts, 1, 'the failed removal is not retried');
    });

    it('R4: stops before closing the last tab when another tab was closed by hand mid-command', async () => {
        await setup({ limit: 1 }); // window 1: tabs 1, 2, 3, limit 1
        const op = await getOp();

        // Just before tab 2 is closed, the user closes tab 3 by hand
        const realGet = harness.chrome.tabs.get.bind(harness.chrome.tabs);
        harness.chrome.tabs.get = async (id) => {
            const tab = await realGet(id);
            if (id === 2) await harness.chrome.tabs.remove(3);
            return tab;
        };

        const response = await cmd({ action: 'closeSelected', ...decide(op, { tabIds: [1, 2] }) });
        await flush();

        assert.equal(response.success, true);
        assert.deepEqual(harness.tabIds(1), [2], 'the last tab in the window survives');
    });
});

describe('closePending', () => {
    beforeEach(() => setup());

    it('closes only the pending tabs', async () => {
        const pending = await openMany(2);
        const op = await getOp();
        const response = await cmd({ action: 'closePending', ...decide(op) });

        assert.deepEqual(response, { success: true });
        for (const id of pending) assert.equal(harness.tabIds(1).includes(id), false);
        assert.deepEqual(harness.tabIds(1).sort(), [1, 2, 3]);
    });

    it('never closes moved tabs', async () => {
        const moved = await open(2);
        harness.moveTab(moved, 1);
        await flush();
        const pending = await open();
        const op = await getOp();
        await cmd({ action: 'closePending', ...decide(op) });
        await flush();

        assert.ok(harness.tabIds(1).includes(moved), 'moved tab survives');
        assert.equal(harness.tabIds(1).includes(pending), false);
    });

    it('R4: is refused when it would close the whole window (limit 1, ordinary tab closed by hand)', async () => {
        await setup({
            limit: 1,
            tabs: [
                { id: 1, windowId: 1, url: 'https://a.example/' },
                { id: 10, windowId: 2, url: 'https://other.example/' }
            ]
        });
        await openMany(2); // two pending
        const op = await getOp();
        await harness.chrome.tabs.remove(1); // the only ordinary tab
        await flush();
        const fresh = await getOp();
        assert.ok(fresh.revision > op.revision);

        const response = await cmd({ action: 'closePending', ...decide(fresh) });
        assert.equal(response.success, false);
        assert.match(response.error, /close the window/);
        assert.equal(harness.tabIds(1).length, 2, 'both tabs remain');
        assert.equal((await getOp()).canClosePending, false);
    });
});

// ------------------------------------------------------------------- restart

describe('worker restart and recovery', () => {
    beforeEach(() => setup());

    it('keeps the operation, statuses and revision across a worker restart', async () => {
        const id = await open();
        const before = await getOp();

        await workerRestart();
        const after = await getOp();

        assert.equal(after.opId, before.opId);
        assert.equal(after.tabs.find((t) => t.id === id).status, 'pending');
    });

    it('a restart before a pending ID was saved shows unexplained excess for review', async () => {
        harness.addTabSilently({ windowId: 1, url: 'https://lost.example/' }); // nobody heard it open
        await workerRestart();

        const op = await getOp();
        assert.ok(op, 'the excess opens an operation');
        assert.equal(op.kind, 'normal');
        assert.equal(op.tabs.every((t) => t.status === 'ordinary'), true);
        assert.equal(harness.tabIds(1).length, 4, 'nothing was closed');
    });

    it('never replays a closing phase after a restart', async () => {
        await open();
        const op = await getOp();
        const state = await savedState();
        state.windows[1].op.phase = 'closing';
        state.windows[1].op.closing = [1];
        await harness.chrome.storage.session.set({ tl_state: state });
        harness.calls.removeAttempts.length = 0;

        await workerRestart();

        assert.deepEqual(harness.calls.removeAttempts, [], 'no tab was closed');
        const after = await getOp();
        assert.equal(after.phase, 'open');
        assert.ok(after.revision > op.revision);
        assert.equal(harness.tabIds(1).length, 4);
    });

    it('C3: a restart never raises an allowance (limit 10, allowance 12, 13 tabs)', async () => {
        const tabs = Array.from({ length: 13 }, (_, i) => ({ id: i + 1, windowId: 1, url: `https://t${i}.example/` }));
        await setup({ limit: 10, tabs, enforce: false });
        const first = await getOp();
        await cmd({ action: 'keepThese', ...decide(first) }); // allowance becomes 13
        const state = await savedState();
        state.windows[1].allowance = { window: 12, groups: { '-1': 12 } };
        state.windows[1].op = state.windows[1].op ?? null;
        await harness.chrome.storage.session.set({ tl_state: state });

        await workerRestart();

        const after = await savedState();
        assert.equal(after.startupMode, false, 'a restart never turns startup mode back on');
        assert.equal(after.windows[1].allowance.window, 12);
        assert.ok(await getOp(), 'the 13th tab is still unresolved');
    });

    it('treats a tracked tab found in another window after a restart as moved', async () => {
        const pending = await open();
        harness.resetListeners();
        harness.moveTab(pending, 2); // moved while the worker was down (no events heard)
        harness.addTabSilently({ windowId: 2, url: 'https://x.example/' });
        harness.addTabSilently({ windowId: 2, url: 'https://y.example/' });
        await startServiceWorker(harness);

        const op2 = await getOp(2);
        assert.equal(op2.tabs.find((t) => t.id === pending).status, 'moved');
    });
});

// -------------------------------------------------------------- 4. startup

describe('startup mode (D1)', () => {
    const overLimitSession = () => [
        ...Array.from({ length: 5 }, (_, i) => ({ id: i + 1, windowId: 1, url: `https://restored${i}.example/` })),
        { id: 10, windowId: 2, url: 'https://other.example/' }
    ];

    it('starts in startup mode, marks restored excess as startup, and closes nothing', async () => {
        await setup({ enforce: false, tabs: overLimitSession() });

        const state = await getState();
        assert.equal(state.startupMode, true);
        assert.equal(state.operation.kind, 'startup');
        assert.equal(state.operation.canKeep, true);
        assert.equal(state.operation.tabs.every((t) => t.status === 'startup'), true);
        assert.equal(harness.tabIds(1).length, 5);
        assert.equal(harness.calls.badge, '2');
    });

    it('never rejects startup excess, however many tabs open', async () => {
        await setup({ enforce: false, tabs: overLimitSession() });
        const ids = await openMany(9);

        for (const id of ids) assert.ok(harness.tabIds(1).includes(id));
        const op = await getOp();
        assert.equal(op.rejectedCount, 0);
        assert.equal(op.tabs.filter((t) => t.status === 'pending').length, 0);
    });

    it('R1: a tab that fits its own group is admitted while another group\'s startup operation is open, below and above the cap', async () => {
        await setup({
            enforce: false,
            limit: 20,
            local: groupLimit(7, 2),
            tabs: [
                { id: 1, windowId: 1, groupId: 7, url: 'https://a.example/' },
                { id: 2, windowId: 1, groupId: 7, url: 'https://b.example/' },
                { id: 3, windowId: 1, groupId: 7, url: 'https://c.example/' },
                { id: 10, windowId: 2, url: 'https://other.example/' }
            ]
        });
        assert.ok(await getOp(), 'group 7 is over (3 > 2)');

        // Group -1 (default limit 20) has plenty of room. 8 tabs is above the pending cap of 5.
        const ids = await openMany(8, 1, { groupId: -1 });
        for (const id of ids) assert.ok(harness.tabIds(1).includes(id), 'no tab is rejected');
        const op = await getOp();
        assert.equal(op.rejectedCount, 0);
        assert.equal(op.tabs.filter((t) => t.status === 'pending').length, 0);
    });

    it('Keep these raises the allowance to the eligible tabs and ends the operation', async () => {
        await setup({ enforce: false, tabs: overLimitSession() });
        const op = await getOp();
        const response = await cmd({ action: 'keepThese', ...decide(op) });

        assert.deepEqual(response, { success: true });
        assert.equal(await getOp(), null, 'the window is within its allowance');
        const state = await savedState();
        assert.equal(state.windows[1].allowance.window, 5);

        // Normal enforcement: the allowance is full, so a new tab is pending
        const id = await open();
        assert.equal((await getOp()).tabs.find((t) => t.id === id).status, 'pending');
    });

    it('R2: Keep these excludes tabs opened after startup mode ended', async () => {
        await setup({ enforce: false, tabs: overLimitSession() });
        await startEnforcing();
        const late = await open(); // window 1 still has its startup operation: pending
        assert.equal((await getOp()).tabs.find((t) => t.id === late).status, 'pending');

        const op = await getOp();
        await cmd({ action: 'keepThese', ...decide(op) });

        const state = await savedState();
        assert.equal(state.windows[1].allowance.window, 5, 'the late tab is not grandfathered');
        const after = await getOp();
        assert.ok(after, 'the pending tab keeps the operation open');
        assert.equal(after.tabs.find((t) => t.id === late).status, 'pending');
    });

    it('the first decision in one window ends startup mode everywhere', async () => {
        await setup({ enforce: false, tabs: overLimitSession() });
        await harness.chrome.storage.local.set({ tabLimit_2: 1 });
        const op = await getOp();
        await cmd({ action: 'keepThese', ...decide(op) });

        assert.equal((await getState(2)).startupMode, false);
        const id = await open(2);
        assert.ok(harness.tabIds(2).includes(id));
        const id2 = await open(2);
        assert.equal((await getOp(2)).tabs.find((t) => t.id === id2).status, 'pending');
    });

    it('closing tabs counts as the first decision too', async () => {
        await setup({ enforce: false, tabs: overLimitSession() });
        const op = await getOp();
        await cmd({ action: 'closeSelected', ...decide(op, { tabIds: [1, 2] }) });
        assert.equal((await getState()).startupMode, false);
    });

    it('a worker restart during startup keeps the mode on', async () => {
        await setup({ enforce: false, tabs: overLimitSession() });
        await workerRestart();
        assert.equal((await getState()).startupMode, true);
    });

    it('an extension reload with an operation open loses nothing and closes nothing', async () => {
        await setup({ enforce: false, tabs: overLimitSession() });
        await startEnforcing();
        await open(); // pending in the startup window
        const tabsBefore = harness.tabIds(1).sort();

        await extensionReload();

        assert.deepEqual(harness.tabIds(1).sort(), tabsBefore, 'no tab closed');
        const state = await getState();
        assert.equal(state.startupMode, true, 'startup mode is on again after a reload');
        assert.equal(state.operation.tabs.every((t) => t.status === 'startup'), true);
    });

    it('decides a creation event that arrives around initialization after initializing', async () => {
        harness = createChromeMock({ tabs: overLimitSession() });
        await harness.chrome.storage.local.set({ defaultTabLimit: 3 });
        await startServiceWorker(harness, { settle: false });
        const id = harness.userOpensTab({ windowId: 1, pendingUrl: 'https://early.example/' }); // before init finished
        await flush();

        assert.ok(harness.tabIds(1).includes(id), 'startup excess is never closed');
        const op = await getOp();
        assert.equal(op.tabs.find((t) => t.id === id).status, 'startup');
    });

    it('a fresh startup with nothing over limit offers no operation but startup mode is on', async () => {
        await setup({ enforce: false });
        const state = await getState();
        assert.equal(state.startupMode, true);
        assert.equal(state.operation, null);
    });
});

// ------------------------------------------------- D4: start enforcing now

describe('startEnforcing (D4)', () => {
    const overLimitSession = () => [
        ...Array.from({ length: 5 }, (_, i) => ({ id: i + 1, windowId: 1, url: `https://r${i}.example/` })),
        ...Array.from({ length: 4 }, (_, i) => ({ id: i + 20, windowId: 2, url: `https://s${i}.example/` }))
    ];

    it('works with no operation open', async () => {
        await setup({ enforce: false });
        assert.equal((await getState()).operation, null);

        assert.deepEqual(await startEnforcing(), { success: true });
        assert.equal((await getState()).startupMode, false);
    });

    it('with startup operations in several windows leaves everything else unchanged', async () => {
        await setup({ enforce: false, tabs: overLimitSession() });
        const before = await savedState();
        const tabsBefore = [...harness.tabIds(1), ...harness.tabIds(2)].sort();

        await startEnforcing();
        const after = await savedState();

        assert.equal(after.startupMode, false);
        assert.deepEqual(after.windows, before.windows, 'allowances, kinds, statuses and revisions are unchanged');
        assert.deepEqual([...harness.tabIds(1), ...harness.tabIds(2)].sort(), tabsBefore, 'no tab closed');
    });

    it('is idempotent', async () => {
        await setup({ enforce: false, tabs: overLimitSession() });
        await startEnforcing();
        const once = await savedState();
        assert.deepEqual(await startEnforcing(), { success: true });
        assert.deepEqual(await startEnforcing(), { success: true });
        assert.deepEqual(await savedState(), once);
    });

    it('stays off after a worker restart and comes back on after a browser restart', async () => {
        await setup({ enforce: false });
        await startEnforcing();

        await workerRestart();
        assert.equal((await getState()).startupMode, false);

        await browserRestart();
        assert.equal((await getState()).startupMode, true);
    });

    it('applies the normal cap to later creations, including in a window that still holds startup excess', async () => {
        await setup({ enforce: false, tabs: overLimitSession() });
        await startEnforcing();

        const pending = await openMany(5);
        const rejected = await open();

        for (const id of pending) assert.ok(harness.tabIds(1).includes(id), 'pending up to the cap');
        assert.equal(harness.tabIds(1).includes(rejected), false, 'then rejected');
    });

    it('decides a creation queued before the command in startup mode', async () => {
        await setup({ enforce: false, tabs: overLimitSession() });

        // Hold the creation task part-way so the command queues up behind it
        let release;
        const gate = new Promise((resolve) => (release = resolve));
        const realGet = harness.chrome.storage.local.get.bind(harness.chrome.storage.local);
        let held = false;
        harness.chrome.storage.local.get = async (...args) => {
            if (!held) {
                held = true;
                await gate;
            }
            return realGet(...args);
        };

        const early = harness.userOpensTab({ windowId: 1, pendingUrl: 'https://early.example/' });
        await flush();
        const response = startEnforcing(); // queued behind the held creation
        await flush();
        release();
        await response;
        await flush();

        const late = await open();
        const op = await getOp();
        assert.equal(op.tabs.find((t) => t.id === early).status, 'startup', 'decided before the command');
        assert.equal(op.tabs.find((t) => t.id === late).status, 'pending', 'decided after the command');
        assert.equal(op.rejectedCount, 0);
    });

    it('refuses an untrusted sender', async () => {
        await setup({ enforce: false });
        for (const sender of [
            { id: EXTENSION_ID, url: 'https://evil.example/' },
            { id: 'other-extension', url: 'chrome-extension://other-extension/x.html' }
        ]) {
            const response = await cmd({ action: 'startEnforcing' }, sender);
            assert.equal(response.success, false);
        }
        assert.equal((await getState()).startupMode, true);
    });

    it('tells open popups, and getState no longer reports startup mode', async () => {
        await setup({ enforce: false, tabs: overLimitSession() });
        const { messages } = harness.connectPort();

        await startEnforcing();
        await flush();

        const last = messages.at(-1);
        assert.equal(last.type, 'state');
        assert.equal(last.startupMode, false);
        assert.equal((await getState()).startupMode, false);
    });

    it('ignores ports from untrusted pages', async () => {
        await setup({ enforce: false });
        const { port, messages } = harness.connectPort({ id: EXTENSION_ID, url: 'https://evil.example/' });
        await startEnforcing();
        await flush();
        assert.deepEqual(messages, []);
        assert.ok(port);
    });
});

// ------------------------------------------------- constraints (group 5)

describe('window and group constraints together', () => {
    it('requires a selection to resolve the window and every group', async () => {
        await setup({
            enforce: false,
            limit: 10,
            local: { tabLimit_1: 3, ...groupLimit(7, 1) },
            tabs: [
                { id: 1, windowId: 1, groupId: 7 },
                { id: 2, windowId: 1, groupId: 7 },
                { id: 3, windowId: 1 },
                { id: 4, windowId: 1 },
                { id: 5, windowId: 1 },
                { id: 10, windowId: 2 }
            ]
        });
        harness.groups.push({ id: 7, windowId: 1, title: 'Work', color: 'blue' });
        const op = await getOp();
        assert.deepEqual(op.constraints.map((c) => c.id).sort(), ['group:7', 'window']);
        assert.equal(op.constraints.find((c) => c.id === 'group:7').title, 'Work');
        // Closing an ungrouped tab reduces only the window; a group-7 tab reduces both
        assert.deepEqual(op.tabs.find((t) => t.id === 3).reduces, ['window']);
        assert.deepEqual(op.tabs.find((t) => t.id === 1).reduces.sort(), ['group:7', 'window']);

        const windowOnly = await cmd({ action: 'closeSelected', ...decide(op, { tabIds: [3, 4] }) });
        assert.equal(windowOnly.success, false, 'group 7 would still be over');
        assert.equal(harness.tabIds(1).length, 5);

        const both = await cmd({ action: 'closeSelected', ...decide(op, { tabIds: [1, 3] }) });
        assert.deepEqual(both, { success: true });
        assert.equal(harness.tabIds(1).length, 3);
    });

    it('resolves the operation when a group vanishes and its tabs become ungrouped', async () => {
        await setup({ limit: 10, local: groupLimit(7, 2) });
        harness.setGroup(1, 7);
        harness.setGroup(2, 7);
        await flush();
        const extra = await open(1, { groupId: 7 }); // group 7 would hold 3, limit 2
        assert.equal((await getOp()).tabs.find((t) => t.id === extra).status, 'pending');

        for (const id of [1, 2, extra]) harness.setGroup(id, -1); // the group is deleted
        await flush();

        assert.equal(await getOp(), null);
        assert.equal(harness.tabIds(1).length, 4, 'nothing was closed');
    });

    it('tells the popup how many windows still hold a startup operation', async () => {
        await setup({
            enforce: false,
            tabs: [
                ...Array.from({ length: 5 }, (_, i) => ({ id: i + 1, windowId: 1 })),
                ...Array.from({ length: 5 }, (_, i) => ({ id: i + 20, windowId: 2 }))
            ]
        });
        assert.equal((await getState()).startupOperations, 2);

        await startEnforcing();
        assert.equal((await getState()).startupOperations, 2, 'ending startup mode leaves the operations open');
    });
});

// ------------------------------------------- regressions found in review

// Run `hook` the first time obj[name] is called, before the real call. It lets
// the browser change tabs while a background task is waiting on an API call.
function once(obj, name, hook) {
    const real = obj[name].bind(obj);
    let armed = true;
    obj[name] = async (...args) => {
        if (armed) {
            armed = false;
            await hook();
        }
        return real(...args);
    };
}

describe('browser changes while a task is running (docs/regressions.md)', () => {
    beforeEach(() => setup());

    describe('REG-01: a tab moved during its own admission', () => {
        it('is not rejected in its new window', async () => {
            await openMany(5); // window 1: 3 ordinary + 5 pending
            let id;
            once(harness.chrome.storage.local, 'get', async () => {
                harness.moveTab(id, 2); // window 2 has room
                await flush(1);
            });
            id = harness.userOpensTab({ windowId: 1, pendingUrl: 'https://x.example/' });
            await flush(20);

            assert.ok(harness.tabIds(2).includes(id), 'the moved tab stays open in window 2');
            assert.equal((await getOp(1)).rejectedCount, 0, 'no rejection was recorded');
            assert.equal(await getOp(2), null, 'window 2 has room, so nothing to decide there');
        });

        it('is protected as moved when its new window is full', async () => {
            await openMany(5);
            await openMany(2, 2); // window 2: 3 tabs, at its limit
            let id;
            once(harness.chrome.storage.local, 'get', async () => {
                harness.moveTab(id, 2);
                await flush(1);
            });
            id = harness.userOpensTab({ windowId: 1, pendingUrl: 'https://x.example/' });
            await flush(20);

            assert.ok(harness.tabIds(2).includes(id));
            assert.equal((await getOp(2)).tabs.find((t) => t.id === id).status, 'moved');
        });

        it('is not rejected when it moves after the decision, just before the close', async () => {
            await openMany(5);
            let id;
            // The task reads the tab three times (decision, re-check, last look before closing): move it on the third
            const realGet = harness.chrome.tabs.get.bind(harness.chrome.tabs);
            let gets = 0;
            harness.chrome.tabs.get = async (tabId) => {
                if (tabId === id && ++gets === 3) {
                    harness.moveTab(id, 2);
                    await flush(1);
                }
                return realGet(tabId);
            };
            id = harness.userOpensTab({ windowId: 1, pendingUrl: 'https://x.example/' });
            await flush(20);

            assert.ok(harness.tabIds(2).includes(id), 'still open');
            assert.equal((await getOp(1)).rejectedCount, 0, 'the rejection was taken back');
        });
    });

    describe('REG-02: navigation while a close command runs', () => {
        it('refuses closeSelected when a chosen tab navigated while the command waited', async () => {
            await open();
            const op = await getOp();
            let seen = false;
            harness.chrome.tabs.onUpdated.addListener((tabId, info) => {
                if (tabId === 1 && info.url) seen = true;
            });
            once(harness.chrome.storage.local, 'get', async () => {
                harness.navigate(1, 'https://new-unsaved-work.invalid/');
                await flush(1);
            });

            const response = await cmd({ action: 'closeSelected', ...decide(op, { tabIds: [1] }) });
            await flush(20);

            assert.equal(seen, true, 'the navigation was delivered during the command');
            assert.equal(response.success, false);
            assert.ok(harness.tabIds(1).includes(1), 'the navigated tab was not closed');
        });

        it('skips a tab that navigates between the check and its closing', async () => {
            await open();
            const op = await getOp();
            // tab 1 is read once by the closing guard; navigate it then
            once(harness.chrome.tabs, 'get', async () => {
                harness.navigate(1, 'https://new-unsaved-work.invalid/');
                await flush(1);
            });

            const response = await cmd({ action: 'closeSelected', ...decide(op, { tabIds: [1] }) });
            await flush(20);

            assert.equal(response.success, false);
            assert.ok(harness.tabIds(1).includes(1));
            const after = await getOp();
            assert.ok(after.revision > op.revision, 'the operation reopens for review');
        });

        it('applies to closePending too', async () => {
            const pending = await open();
            const op = await getOp();
            once(harness.chrome.storage.local, 'get', async () => {
                harness.navigate(pending, 'https://new-unsaved-work.invalid/');
                await flush(1);
            });

            const response = await cmd({ action: 'closePending', ...decide(op) });
            await flush(20);

            assert.equal(response.success, false);
            assert.ok(harness.tabIds(1).includes(pending));
        });

        it('still closes a tab that navigated before the view was shown', async () => {
            await open();
            harness.navigate(1, 'https://before.example/');
            await flush(5);
            const op = await getOp(); // the revision already reflects the navigation
            const response = await cmd({ action: 'closeSelected', ...decide(op, { tabIds: [1] }) });

            assert.deepEqual(response, { success: true });
            assert.equal(harness.tabIds(1).includes(1), false);
        });

        it('keeps no URL anywhere in the stored state', async () => {
            await open();
            harness.navigate(1, 'https://secret-page.invalid/private');
            await flush(5);
            assert.equal(JSON.stringify(await savedState()).includes('secret-page'), false);
            assert.equal(JSON.stringify(harness.chrome.storage.local._dump()).includes('secret-page'), false);
        });
    });

    describe('REG-03: a tab replaced while it is being admitted', () => {
        it('is decided once under its new ID when the old ID is gone before the first read', async () => {
            let old;
            let release;
            const gate = new Promise((resolve) => (release = resolve));
            once(harness.chrome.tabs, 'get', () => gate);
            old = harness.userOpensTab({ windowId: 1, pendingUrl: 'https://x.example/' });
            await flush(1);
            harness.replaceTab(old, 2000);
            await flush(1);
            release();
            await flush(20);

            const op = await getOp();
            assert.ok(op, 'window 1 is over: 4 tabs, limit 3');
            assert.equal(op.tabs.find((t) => t.id === 2000).status, 'pending');
            assert.equal(harness.tabIds(1).length, op.tabs.length, 'every real tab is counted and shown');

            await open();
            const next = await getOp();
            assert.equal(harness.tabIds(1).length, next.tabs.length, 'still every real tab, after another creation');
            assert.ok(next.tabs.some((t) => t.id === 2000));
        });

        it('is decided once when replaced after the first read', async () => {
            let old;
            once(harness.chrome.storage.local, 'get', async () => {
                harness.replaceTab(old, 2000);
                await flush(1);
            });
            old = harness.userOpensTab({ windowId: 1, pendingUrl: 'https://x.example/' });
            await flush(20);

            const op = await getOp();
            assert.equal(op.tabs.find((t) => t.id === 2000)?.status, 'pending');
            assert.equal(harness.tabIds(1).length, op.tabs.length);
            await open();
            assert.equal((await getOp()).tabs.length, harness.tabIds(1).length);
        });

        it('a replacement of a tab that is to be rejected is the one rejected', async () => {
            await openMany(5);
            let old;
            once(harness.chrome.storage.local, 'get', async () => {
                harness.replaceTab(old, 2000);
                await flush(1);
            });
            old = harness.userOpensTab({ windowId: 1, pendingUrl: 'https://x.example/' });
            await flush(20);

            assert.equal(harness.tabIds(1).includes(2000), false, 'rejected under its new ID');
            assert.equal((await getOp()).rejectedCount, 1);
        });
    });

    describe('REG-04: a limit raised while an operation is open', () => {
        it('admits the next tab and clears the resolved operation', async () => {
            await openMany(5);
            await harness.chrome.storage.local.set({ defaultTabLimit: 100 });
            const id = await open();

            assert.ok(harness.tabIds(1).includes(id), 'the new tab fits the new limit');
            assert.equal(harness.tabIds(1).length, 9);
            assert.equal(await getOp(), null);
        });

        it('shows no stale operation and clears the badge straight away', async () => {
            await openMany(5);
            assert.equal(harness.calls.badge, '5');
            await harness.chrome.storage.local.set({ defaultTabLimit: 100 });
            await flush();

            assert.equal(harness.calls.badge, '', 'the settings change reconciled in the background');
            assert.equal(await getOp(), null, 'no operation with an empty constraint list');
        });

        it('tells open popups when a settings change resolves an operation', async () => {
            await openMany(5);
            const { messages } = harness.connectPort();
            await harness.chrome.storage.local.set({ defaultTabLimit: 100 });
            await flush();

            assert.equal(messages.at(-1).revisions[1], null);
        });

        it('refuses a command made against the operation the new limit resolved', async () => {
            await openMany(2);
            const op = await getOp();
            await harness.chrome.storage.local.set({ defaultTabLimit: 100 });
            const response = await cmd({ action: 'closePending', ...decide(op) });

            assert.equal(response.success, false);
            assert.equal(harness.tabIds(1).length, 5, 'nothing closed');
        });

        it('lowering a limit opens an operation without closing anything', async () => {
            await harness.chrome.storage.local.set({ defaultTabLimit: 2 });
            await flush();

            const op = await getOp();
            assert.ok(op, 'three tabs now exceed a limit of two');
            assert.equal(harness.tabIds(1).length, 3);
        });
    });
});

describe('follow-up review findings (docs/regressions.md, Codex verification)', () => {
    beforeEach(() => setup());

    describe('REG-01a: moved out and back during admission', () => {
        it('is still a moved tab and is not rejected', async () => {
            await openMany(5); // window 1: 3 ordinary + 5 pending
            let id;
            once(harness.chrome.storage.local, 'get', async () => {
                harness.moveTab(id, 2);
                harness.moveTab(id, 1); // back to the full window
                await flush(1);
            });
            id = harness.userOpensTab({ windowId: 1, pendingUrl: 'https://x.example/' });
            await flush(20);

            assert.ok(harness.tabIds(1).includes(id), 'the tab is still open');
            assert.equal(harness.calls.removeAttempts.includes(id), false, 'no close was attempted');
            const op = await getOp();
            assert.equal(op.rejectedCount, 0);
            assert.equal(op.tabs.find((t) => t.id === id).status, 'moved');
        });

        it('a tab that was not moved is still rejected', async () => {
            await openMany(5);
            const id = await open();
            assert.equal(harness.tabIds(1).includes(id), false);
        });
    });

    describe('REG-04a: a limit raised during admission', () => {
        it('is used when it arrives before the decision', async () => {
            await openMany(5);
            let id;
            let calls = 0;
            const realGet = harness.chrome.tabs.get.bind(harness.chrome.tabs);
            harness.chrome.tabs.get = async (tabId) => {
                if (tabId === id && ++calls === 2) {
                    await harness.chrome.storage.local.set({ defaultTabLimit: 100 });
                    await flush(1);
                }
                return realGet(tabId);
            };
            id = harness.userOpensTab({ windowId: 1, pendingUrl: 'https://x.example/' });
            await flush(20);

            assert.ok(harness.tabIds(1).includes(id), 'the tab fits the new limit');
            assert.equal(harness.tabIds(1).length, 9);
            assert.equal(await getOp(), null);
        });

        it('takes back a rejection when it arrives after the decision, just before the close', async () => {
            await openMany(5);
            let id;
            let calls = 0;
            const realGet = harness.chrome.tabs.get.bind(harness.chrome.tabs);
            harness.chrome.tabs.get = async (tabId) => {
                if (tabId === id && ++calls === 3) {
                    await harness.chrome.storage.local.set({ defaultTabLimit: 100 });
                    await flush(1);
                }
                return realGet(tabId);
            };
            id = harness.userOpensTab({ windowId: 1, pendingUrl: 'https://x.example/' });
            await flush(20);

            assert.ok(harness.tabIds(1).includes(id), 'not closed on obsolete limits');
            assert.equal(harness.calls.removeAttempts.includes(id), false);
            assert.equal(await getOp(), null, 'the settings change settled the window');
        });

        it('a limit that does not change still rejects normally', async () => {
            await openMany(5);
            const id = await open();
            assert.equal(harness.tabIds(1).includes(id), false);
        });
    });

    describe('REG-04b: a settings change that leaves excess', () => {
        it('advances the revision and tells the popup, so it refreshes', async () => {
            await openMany(5);
            const before = await getOp();
            const { messages } = harness.connectPort();

            await harness.chrome.storage.local.set({ defaultTabLimit: 4 });
            await flush();
            const after = await getOp();

            assert.equal(before.constraints[0].excess, 5);
            assert.equal(after.constraints[0].excess, 4);
            assert.ok(after.revision > before.revision);
            assert.equal(messages.at(-1).revisions[1], after.revision);
        });

        it('a window-specific limit advances only that window', async () => {
            await openMany(2);
            await openMany(3, 2); // window 2 is over too (limit 3, 1 + 3 tabs)
            const w1 = await getOp(1);
            const w2 = await getOp(2);

            await harness.chrome.storage.local.set({ tabLimit_2: 4 });
            await flush();

            assert.equal((await getOp(1)).revision, w1.revision, 'window 1 is untouched');
            assert.ok((await getOp(2)).revision > w2.revision, 'window 2 advanced (the ungrouped limit still leaves it over)');
        });

        it('a stale selection is refused after the constraints changed', async () => {
            await openMany(5);
            const op = await getOp();
            await harness.chrome.storage.local.set({ defaultTabLimit: 4 });
            await flush();

            // Four tabs resolve the NEW excess (4), so only the stale revision can refuse this
            const response = await cmd({ action: 'closeSelected', ...decide(op, { tabIds: op.tabs.slice(0, 4).map((t) => t.id) }) });
            assert.equal(response.success, false);
            assert.equal(harness.tabIds(1).length, 8);
        });
    });

    describe('REG-02a: navigation of any tab in the window (R3)', () => {
        it('refuses a command when an unselected tab navigated while it waited', async () => {
            await open();
            const op = await getOp();
            once(harness.chrome.storage.local, 'get', async () => {
                harness.navigate(2, 'https://new.invalid/'); // not the tab being closed
                await flush(1);
            });

            const response = await cmd({ action: 'closeSelected', ...decide(op, { tabIds: [1] }) });
            await flush(20);

            assert.equal(response.success, false);
            assert.ok(harness.tabIds(1).includes(1));
        });

        it('also applies between the check and the closing', async () => {
            await open();
            const op = await getOp();
            once(harness.chrome.tabs, 'get', async () => {
                harness.navigate(2, 'https://new.invalid/');
                await flush(1);
            });

            const response = await cmd({ action: 'closeSelected', ...decide(op, { tabIds: [1] }) });
            await flush(20);

            assert.equal(response.success, false);
            assert.ok(harness.tabIds(1).includes(1));
        });

        it('a navigation in a different window does not invalidate it', async () => {
            await open();
            const op = await getOp();
            once(harness.chrome.storage.local, 'get', async () => {
                harness.navigate(10, 'https://elsewhere.invalid/'); // window 2
                await flush(1);
            });

            const response = await cmd({ action: 'closeSelected', ...decide(op, { tabIds: [1] }) });
            await flush(20);

            assert.deepEqual(response, { success: true });
            assert.equal(harness.tabIds(1).includes(1), false);
        });

        it('a title change does not invalidate it', async () => {
            await open();
            const op = await getOp();
            once(harness.chrome.storage.local, 'get', async () => {
                harness.retitle(2, 'Typing indicator');
                await flush(1);
            });

            const response = await cmd({ action: 'closeSelected', ...decide(op, { tabIds: [1] }) });
            assert.deepEqual(response, { success: true });
        });

        it('applies to closePending as well', async () => {
            const pending = await open();
            const op = await getOp();
            once(harness.chrome.storage.local, 'get', async () => {
                harness.navigate(2, 'https://new.invalid/');
                await flush(1);
            });

            const response = await cmd({ action: 'closePending', ...decide(op) });
            await flush(20);

            assert.equal(response.success, false);
            assert.ok(harness.tabIds(1).includes(pending));
        });
    });
});

describe('second review findings (docs/regressions.md, Codex verification of round 2)', () => {
    beforeEach(() => setup());

    describe('REG-01b: movement plus replacement', () => {
        it('the replacement inherits the move protection and is reviewed as moved', async () => {
            await openMany(5);
            let id;
            const realGet = harness.chrome.tabs.get.bind(harness.chrome.tabs);
            let calls = 0;
            harness.chrome.tabs.get = async (tabId) => {
                if (tabId === id && ++calls === 3) {
                    harness.moveTab(id, 2);
                    harness.moveTab(id, 1);
                    harness.replaceTab(id, 2000);
                    await flush(1);
                }
                return realGet(tabId);
            };
            id = harness.userOpensTab({ windowId: 1, pendingUrl: 'https://x.example/' });
            await flush(20);

            assert.ok(harness.tabIds(1).includes(2000), 'the replacement stays open');
            assert.equal(harness.calls.removeAttempts.includes(2000), false);
            const op = await getOp();
            assert.equal(op.rejectedCount, 0);
            assert.equal(op.tabs.find((t) => t.id === 2000).status, 'moved');
        });

        it('a replacement alone at the last look is still rejected, under its new ID', async () => {
            await openMany(5);
            let id;
            const realGet = harness.chrome.tabs.get.bind(harness.chrome.tabs);
            let calls = 0;
            harness.chrome.tabs.get = async (tabId) => {
                if (tabId === id && ++calls === 3) {
                    harness.replaceTab(id, 2000);
                    await flush(1);
                }
                return realGet(tabId);
            };
            id = harness.userOpensTab({ windowId: 1, pendingUrl: 'https://x.example/' });
            await flush(20);

            assert.equal(harness.tabIds(1).includes(2000), false);
            assert.equal((await getOp()).rejectedCount, 1);
        });
    });

    describe('REG-04c: settings changes and the pending cap', () => {
        it('a limit stored for another window never lets a new tab past the cap', async () => {
            await openMany(5); // cap full
            for (const limit of [4, 5, 6]) {
                let id;
                const realGet = harness.chrome.tabs.get.bind(harness.chrome.tabs);
                let calls = 0;
                harness.chrome.tabs.get = async (tabId) => {
                    if (tabId === id && ++calls === 3) {
                        await harness.chrome.storage.local.set({ tabLimit_2: limit }); // not window 1
                        await flush(1);
                    }
                    return realGet(tabId);
                };
                id = harness.userOpensTab({ windowId: 1, pendingUrl: 'https://x.example/' });
                await flush(20);
                harness.chrome.tabs.get = realGet;

                assert.equal(harness.tabIds(1).includes(id), false, `rejected with tabLimit_2 ${limit}`);
            }
            const op = await getOp();
            assert.equal(op.pendingCount, 5, 'the cap held');
            assert.equal(op.rejectedCount, 3);
            assert.equal(harness.tabIds(1).length, 8);
        });

        it('a limit stored for this window is used: the tab is decided again and fits', async () => {
            await openMany(5);
            let id;
            const realGet = harness.chrome.tabs.get.bind(harness.chrome.tabs);
            let calls = 0;
            harness.chrome.tabs.get = async (tabId) => {
                if (tabId === id && ++calls === 3) {
                    await harness.chrome.storage.local.set({ tabLimit_1: 100, groupLimit_1_ungrouped: 100 });
                    await flush(1);
                }
                return realGet(tabId);
            };
            id = harness.userOpensTab({ windowId: 1, pendingUrl: 'https://x.example/' });
            await flush(20);

            assert.ok(harness.tabIds(1).includes(id));
            assert.equal(harness.tabIds(1).length, 9);
            assert.equal(await getOp(), null);
        });

        // Change a setting on the final lookup of each attempt: calls 3, 6 and 9 for the tab
        function changeSettingsEachAttempt(getId, changes) {
            const realGet = harness.chrome.tabs.get.bind(harness.chrome.tabs);
            let calls = 0;
            harness.chrome.tabs.get = async (tabId) => {
                if (tabId === getId() && ++calls % 3 === 0 && changes.length > 0) {
                    await harness.chrome.storage.local.set(changes.shift());
                    await flush(1);
                }
                return realGet(tabId);
            };
            return () => (harness.chrome.tabs.get = realGet);
        }

        it('REG-04d: when settings keep changing, the tab is decided once under the settled rules, never past the cap', async () => {
            await openMany(5); // cap full
            let id;
            changeSettingsEachAttempt(() => id, [{ defaultTabLimit: 4 }, { defaultTabLimit: 5 }, { defaultTabLimit: 6 }]);
            id = harness.userOpensTab({ windowId: 1, pendingUrl: 'https://x.example/' });
            await flush(40);

            // Limit 6 still leaves the window over and the cap is full: rejected, exactly once
            assert.equal(harness.tabIds(1).includes(id), false);
            assert.equal(harness.calls.removeAttempts.filter((removed) => removed === id).length, 1);
            const op = await getOp();
            assert.equal(op.rejectedCount, 1);
            assert.equal(op.pendingCount, 5, 'no extra pending slot');
        });

        it('REG-04d: repeated exhaustion cannot accumulate pending tabs (alternating window limit)', async () => {
            await openMany(5);
            let toggle = 3;
            for (let i = 0; i < 3; i++) {
                let id;
                const restore = changeSettingsEachAttempt(
                    () => id,
                    Array.from({ length: 3 }, () => ({ tabLimit_1: (toggle = toggle === 3 ? 4 : 3) }))
                );
                id = harness.userOpensTab({ windowId: 1, pendingUrl: 'https://x.example/' });
                await flush(40);
                restore();
            }
            const next = await open();

            const op = await getOp();
            assert.equal(op.pendingCount, 5, 'the cap held through every exhaustion');
            assert.equal(op.rejectedCount, 4, 'all four extra tabs were rejected');
            assert.equal(harness.tabIds(1).length, 8);
            assert.equal(harness.tabIds(1).includes(next), false);
        });

        it('REG-04d: when the settings settle on limits the tab fits, it is admitted', async () => {
            await openMany(5);
            let id;
            changeSettingsEachAttempt(() => id, [{ defaultTabLimit: 4 }, { defaultTabLimit: 5 }, { defaultTabLimit: 100 }]);
            id = harness.userOpensTab({ windowId: 1, pendingUrl: 'https://x.example/' });
            await flush(40);

            assert.ok(harness.tabIds(1).includes(id));
            assert.equal(harness.tabIds(1).length, 9);
            assert.equal(await getOp(), null);
        });

        it('the next ordinary creation is still held to the cap afterwards', async () => {
            await openMany(5);
            await harness.chrome.storage.local.set({ tabLimit_2: 5 });
            await flush();
            const next = await open();
            assert.equal(harness.tabIds(1).includes(next), false);
        });
    });
});

describe('getState exposes only what the popup uses (S-3)', () => {
    it('sends titles and statuses but no favicon URL or page URL', async () => {
        await setup();
        harness.chrome.tabs.query = async () => [
            { id: 1, windowId: 1, groupId: -1, title: 'A', url: 'https://secret.example/a', favIconUrl: 'https://secret.example/icon.png' },
            { id: 2, windowId: 1, groupId: -1, title: 'B', url: 'https://secret.example/b', favIconUrl: 'https://secret.example/icon.png' },
            { id: 3, windowId: 1, groupId: -1, title: 'C', url: 'https://secret.example/c', favIconUrl: 'https://secret.example/icon.png' }
        ];
        await harness.chrome.storage.local.set({ defaultTabLimit: 2 });
        await flush();

        const response = await getState();
        assert.ok(response.operation, 'window 1 is over its limit of 2');
        const json = JSON.stringify(response);
        assert.equal(json.includes('secret.example'), false, 'no URL of any kind is sent');
        assert.equal(json.includes('favIconUrl'), false);
        assert.deepEqual(response.operation.tabs.map((t) => t.title), ['A', 'B', 'C']);
    });
});

// ---------------------------------------------------------- message security

describe('message security', () => {
    beforeEach(() => setup());

    it('rejects messages from web pages and other extensions', async () => {
        await open();
        const op = await getOp();
        const request = { action: 'closeSelected', ...decide(op, { tabIds: [1] }) };

        assert.deepEqual(await cmd(request, { id: EXTENSION_ID, url: 'https://evil.example/' }), {
            success: false,
            error: 'Untrusted sender'
        });
        assert.equal((await cmd({ action: 'getState', windowId: 1 }, { id: 'x', url: 'chrome-extension://x/a.html' })).success, false);
        assert.ok(harness.tabIds(1).includes(1));
    });

    it('rejects unknown actions, the removed legacy actions and malformed fields', async () => {
        for (const request of [
            { action: 'closeAllTabs' },
            { action: 'tabSelected', tabId: 1, windowId: 1, newTabId: 3 },
            { action: 'tabSelectedForReplacement', tabId: 2, windowId: 1 },
            { action: 'getSelectorState' },
            { action: 'closeSelected', windowId: 1, opId: 'x', revision: 1, tabIds: ['2'] },
            { action: 'closeSelected', windowId: 1, opId: 'x', revision: 1, tabIds: [] },
            { action: 'closePending', windowId: '1', opId: 'x', revision: 1 }
        ]) {
            assert.equal((await cmd(request)).success, false, JSON.stringify(request));
        }
        assert.deepEqual(harness.tabIds(1).sort(), [1, 2, 3]);
    });

    it('keepThese is refused for a normal operation', async () => {
        await open();
        const op = await getOp();
        const response = await cmd({ action: 'keepThese', ...decide(op) });
        assert.equal(response.success, false);
    });
});

// ------------------------------------------- group moves between windows (Phase B)

// Start a worker on the browser state a recorded scenario began with. `local` is the
// stored settings, or a function of the recorded setup (for settings keyed by its IDs).
async function setupFromTrace(name, { part, local = {}, enforce = true } = {}) {
    const trace = loadTrace(name);
    const setup = setupOf(trace, part);
    harness = createChromeMock({ tabs: initialTabs(trace, part) });
    harness.groups.push(...initialGroups(trace, part));
    await harness.chrome.storage.local.set({ defaultTabLimit: 10, ...(typeof local === 'function' ? local(setup) : local) });
    await startServiceWorker(harness);
    if (enforce) await startEnforcing();
    return { trace, setup, steps: scenarioSteps(trace, part) };
}

describe('test helpers: browser restart and extension reload', () => {
    it('a browser restart clears session state, can renumber, and delivers onStartup after the start-up pass', async () => {
        await setup();
        await open(); // pending: tl_state holds an operation
        const fired = mock.method(harness, 'fire');
        const ids = await browserRestart({ renumber: true });

        assert.deepEqual(fired.mock.calls.map((c) => c.arguments), [['runtimeOnStartup']]);
        assert.ok(ids.tabs.size > 0 && ![...ids.tabs.values()].some((id) => ids.tabs.has(id)), 'every tab has a new ID');
        assert.equal((await getState()).startupMode, true, 'a fresh start, from cleared session state');
        assert.equal(harness.chrome.storage.local._dump().defaultTabLimit, 3, 'storage.local is kept');
    });

    it('a missed start delivers nothing', async () => {
        await setup();
        const fired = mock.method(harness, 'fire');
        await browserRestart({ onStartup: 'never' });
        assert.equal(fired.mock.calls.length, 0);
    });

    it('an extension reload clears session state, keeps IDs, and delivers onInstalled(update)', async () => {
        await setup();
        const before = harness.tabIds().sort();
        const fired = mock.method(harness, 'fire');
        await extensionReload();

        assert.deepEqual(fired.mock.calls.map((c) => c.arguments), [['runtimeOnInstalled', { reason: 'update' }]]);
        assert.deepEqual(harness.tabIds().sort(), before);
        assert.equal((await getState()).startupMode, true);
    });
});

// Save a custom limit the way the popup does: through the background's queue
async function saveGroupLimit(windowId, groupId, limit) {
    const response = await cmd({ action: 'setGroupLimit', windowId, groupId, limit });
    assert.deepEqual(response, { success: true });
    await flush();
}

const statusIn = async (windowId, tabId) => (await getOp(windowId))?.tabs.find((t) => t.id === tabId)?.status ?? 'ordinary';

describe('group moves between windows', () => {
    // The bug this branch fixes. Each case replays a move recorded in real Chrome.
    // A group of 3 has its own limit of 3 (the default is 10), so a 4th tab in it is over.
    it('a custom group limit follows its group to an existing window (s1)', async () => {
        const { setup, steps } = await setupFromTrace('s1');
        await saveGroupLimit(setup.A.windowId, setup.groupId, 3);

        await replay(harness, steps);
        const added = await open(setup.B.windowId, { groupId: setup.groupId });

        assert.equal(await statusIn(setup.B.windowId, added), 'pending', 'a 4th tab in the moved group is over its limit of 3');
    });

    it('a custom group limit survives the source window closing (s3)', async () => {
        const { setup, steps } = await setupFromTrace('s3');
        await saveGroupLimit(setup.A.windowId, setup.groupId, 3);

        await replay(harness, steps);
        assert.equal(harness.tabIds(setup.A.windowId).length, 0, 'the source window is gone');
        const added = await open(setup.B.windowId, { groupId: setup.groupId });

        assert.equal(await statusIn(setup.B.windowId, added), 'pending', 'the limit of 3 still applies');
    });
});

describe('group moves between windows: limits and statuses at the destination', () => {
    // Steps of a recorded move with the source window's removal handled before the
    // group's tabs arrive anywhere (the opposite of what Chrome was seen to do)
    const closeSourceEarly = (steps) => {
        const removal = steps.find((e) => e.ev === 'windows.onRemoved');
        const rest = steps.filter((e) => e !== removal);
        const lastDetach = rest.findLastIndex((e) => e.ev === 'tabs.onDetached');
        return [...rest.slice(0, lastDetach + 1), removal, ...rest.slice(lastDetach + 1)];
    };
    const addToGroup = (setup, windowId) => open(windowId, { groupId: setup.groupId });

    it('test 2: a custom limit above the default keeps the arriving group within it', async () => {
        const { setup, steps } = await setupFromTrace('s1', {
            local: (s) => ({ defaultTabLimit: 2, [`tabLimit_${s.A.windowId}`]: 10, [`tabLimit_${s.B.windowId}`]: 10, ...groupLimit(s.groupId, 5) })
        });
        assert.equal(await getOp(setup.A.windowId), null, 'the group of 3 is within its limit of 5 in the source');

        await replay(harness, steps);

        assert.equal(await getOp(setup.B.windowId), null, 'and in the destination: nothing to decide');
        assert.equal(harness.calls.badge, '');
    });

    it("test 3: tearing a group off, or closing the source, keeps the group's limit and drops the source window's own", async () => {
        for (const [name, part] of [['s3'], ['s4', '4b']]) {
            const { setup, steps } = await setupFromTrace(name, {
                part,
                local: (s) => ({ [`tabLimit_${s.A.windowId}`]: 8, [`groupLimit_${s.A.windowId}_ungrouped`]: 7 })
            });
            await saveGroupLimit(setup.A.windowId, setup.groupId, 3);

            await replay(harness, steps);
            const destination = steps.filter((e) => e.ev === 'tabGroups.onCreated').at(-1).windowId;
            const added = await addToGroup(setup, destination);

            assert.equal(await statusIn(destination, added), 'pending', `${name}: the limit of 3 applies in the new window`);
            const stored = harness.chrome.storage.local._dump();
            assert.equal(stored[`groupOverride_0_${setup.groupId}`], 3, `${name}: kept`);
            if (name === 's3') {
                assert.equal(stored[`tabLimit_${setup.A.windowId}`], undefined, "the closed source window's limit is removed");
                assert.equal(stored[`groupLimit_${setup.A.windowId}_ungrouped`], undefined);
            }
        }
    });

    describe('test 4 (R1): the source window closes before the group arrives', () => {
        it('the limit survives and applies once the tabs report the group', async () => {
            const { setup, steps } = await setupFromTrace('s3');
            await saveGroupLimit(setup.A.windowId, setup.groupId, 3);

            await replay(harness, closeSourceEarly(steps), { flushBetween: 5 });
            assert.equal(harness.chrome.storage.local._dump()[`groupOverride_0_${setup.groupId}`], 3);
            assert.equal(await statusIn(setup.B.windowId, await addToGroup(setup, setup.B.windowId)), 'pending');
        });

        it('even when tabs.query fails while the closing is handled', async () => {
            const { setup, steps } = await setupFromTrace('s3');
            await saveGroupLimit(setup.A.windowId, setup.groupId, 3);
            const ordered = closeSourceEarly(steps);
            const removal = ordered.findIndex((e) => e.ev === 'windows.onRemoved');

            await replay(harness, ordered.slice(0, removal), { flushBetween: 5 });
            harness.failures.tabsQuery = () => true;
            await replay(harness, ordered.slice(removal, removal + 1), { flushBetween: 5 });
            harness.failures.tabsQuery = null;
            await replay(harness, ordered.slice(removal + 1), { flushBetween: 5 });

            assert.equal(harness.chrome.storage.local._dump()[`groupOverride_0_${setup.groupId}`], 3);
            assert.equal(await statusIn(setup.B.windowId, await addToGroup(setup, setup.B.windowId)), 'pending');
        });

        it('and when the worker restarts between the closing and the arrival', async () => {
            const { setup, steps } = await setupFromTrace('s3');
            await saveGroupLimit(setup.A.windowId, setup.groupId, 3);
            const ordered = closeSourceEarly(steps);
            const removal = ordered.findIndex((e) => e.ev === 'windows.onRemoved');

            await replay(harness, ordered.slice(0, removal + 1), { flushBetween: 5 });
            await workerRestart();
            await replay(harness, ordered.slice(removal + 1), { flushBetween: 5 });

            assert.equal(await statusIn(setup.B.windowId, await addToGroup(setup, setup.B.windowId)), 'pending');
        });
    });

    describe('test 4b (R7): a drag into another window goes through a temporary drag window (4a)', () => {
        const dragWindowOf = (steps) => steps.find((e) => e.ev === 'windows.onCreated').windowId;

        it('the limit survives both hops, and the drag window leaves nothing behind', async () => {
            const { setup, steps } = await setupFromTrace('s4', { part: '4a' });
            await saveGroupLimit(setup.A.windowId, setup.groupId, 3);

            await replay(harness, steps, { flushBetween: 5 });

            assert.equal((await savedState()).windows[dragWindowOf(steps)], undefined, 'no state for the drag window');
            assert.equal(harness.calls.badge, '');
            assert.equal(await getOp(setup.B.windowId), null);
            assert.equal(await statusIn(setup.B.windowId, await addToGroup(setup, setup.B.windowId)), 'pending', 'the limit of 3 applies in the target');
        });

        it('a group over the default window limit in the drag window is judged only at the target', async () => {
            // The drag window holds the 3 tabs and has the default window limit of 2
            const { setup, steps } = await setupFromTrace('s4', {
                part: '4a',
                local: (s) => ({ defaultTabLimit: 2, [`tabLimit_${s.A.windowId}`]: 10, [`tabLimit_${s.B.windowId}`]: 10, ...groupLimit(s.groupId, 3) })
            });
            const before = harness.tabIds().length;
            const dragWindow = dragWindowOf(steps);
            const secondHop = steps.findIndex((e, i) => e.ev === 'tabGroups.onRemoved' && steps.slice(0, i).some((x) => x.ev === 'tabGroups.onRemoved'));

            await replay(harness, steps.slice(0, secondHop), { flushBetween: 5 });
            const inDrag = await getOp(dragWindow);
            assert.ok(inDrag, 'the drag window is over while the group is in it');
            assert.ok(inDrag.tabs.every((t) => t.status === 'moved'), 'its tabs are protected as moved, never pending or rejected');

            await replay(harness, steps.slice(secondHop), { flushBetween: 5 });
            assert.equal(harness.tabIds().length, before, 'nothing was closed');
            assert.equal((await savedState()).windows[dragWindow], undefined);
            assert.equal(await getOp(setup.B.windowId), null, 'the target has room for the group, within its limit');
            assert.equal(harness.calls.badge, '');
        });

        it('a worker restart while the group is in the drag window changes nothing', async () => {
            const { setup, steps } = await setupFromTrace('s4', { part: '4a' });
            await saveGroupLimit(setup.A.windowId, setup.groupId, 3);
            const secondHop = steps.findIndex((e, i) => e.ev === 'tabGroups.onRemoved' && steps.slice(0, i).some((x) => x.ev === 'tabGroups.onRemoved'));

            await replay(harness, steps.slice(0, secondHop), { flushBetween: 5 });
            await workerRestart();
            await replay(harness, steps.slice(secondHop), { flushBetween: 5 });

            assert.equal((await savedState()).windows[dragWindowOf(steps)], undefined);
            assert.equal(await statusIn(setup.B.windowId, await addToGroup(setup, setup.B.windowId)), 'pending');
        });
    });

    it('test 5 (R2): a tab created after the tabs report the group, before tabGroups.onCreated, is decided under its limit', async () => {
        const { setup, steps } = await setupFromTrace('s1');
        await saveGroupLimit(setup.A.windowId, setup.groupId, 3);

        const { stoppedAt } = await replay(harness, steps, { stopBefore: (e) => e.ev === 'tabGroups.onCreated' });
        assert.ok(harness.groups.every((g) => g.windowId !== setup.B.windowId), 'Chrome has not reported the group in the destination yet');
        const added = await addToGroup(setup, setup.B.windowId);
        assert.equal(await statusIn(setup.B.windowId, added), 'pending');

        await replay(harness, steps.slice(stoppedAt));
        assert.equal(await statusIn(setup.B.windowId, added), 'pending');
        assert.ok(harness.tabIds(setup.B.windowId).includes(added), 'and is not closed');
    });

    // Stepped, each tab attaches while Chrome still reports it ungrouped, so it is first
    // judged against the over ungrouped tabs; its group update must correct that (Codex)
    for (const flushBetween of [0, 5]) {
    it(`test 6 (R3): an unrelated over group at the destination does not flag the arriving tabs (flush ${flushBetween})`, async () => {
        const { setup, steps } = await setupFromTrace('s1', {
            local: (s) => ({ [`groupLimit_${s.B.windowId}_ungrouped`]: 1, ...groupLimit(s.groupId, 5) })
        });
        const before = await getOp(setup.B.windowId);
        assert.ok(before, "the destination's 2 ungrouped tabs are over their limit of 1");

        await replay(harness, steps, { flushBetween });

        const op = await getOp(setup.B.windowId);
        for (const id of setup.groupTabIds) {
            assert.equal(op.tabs.find((t) => t.id === id).status, 'ordinary', `tab ${id}`);
        }
        assert.deepEqual(op.constraints.map((c) => c.id), ['group:-1'], 'only the ungrouped tabs are over');
    });
    }

    // As one burst (as Chrome delivered it), and with each step handled before the next:
    // when the first tabs fit and only the last pushes the window over, the whole group
    // still shares one verdict (R3, R4)
    for (const flushBetween of [0, 5]) {
        it(`test 7: the destination's window limit still applies: the moved tabs are flagged, never closed (flush ${flushBetween})`, async () => {
            const { setup, steps } = await setupFromTrace('s1', {
                local: (s) => ({ [`tabLimit_${s.B.windowId}`]: 4, ...groupLimit(s.groupId, 5) })
            });
            const before = harness.tabIds().length;

            await replay(harness, steps, { flushBetween });

            const op = await getOp(setup.B.windowId);
            for (const id of setup.groupTabIds) {
                assert.equal(op.tabs.find((t) => t.id === id).status, 'moved', `tab ${id}`);
            }
            for (const id of setup.B.tabIds) {
                assert.equal(op.tabs.find((t) => t.id === id).status, 'ordinary', `tab ${id} was already there`);
            }
            assert.equal(harness.tabIds().length, before);
            assert.equal(op.rejectedCount, 0);
            assert.equal(harness.calls.badge, '1');
        });
    }

    describe('test 10: splits and merges (decision 1)', () => {
        it("a subset dragged out by a tab (4d) arrives ungrouped and uses the destination's limits; the group keeps its own", async () => {
            const { setup, steps } = await setupFromTrace('s4', {
                part: '4d',
                local: (s) => ({ [`groupLimit_${s.B.windowId}_ungrouped`]: 1, ...groupLimit(s.groupId, 4) })
            });

            await replay(harness, steps, { flushBetween: 5 });

            const op = await getOp(setup.B.windowId);
            for (const id of setup.subset) {
                assert.equal(op.tabs.find((t) => t.id === id).status, 'moved', `tab ${id} counts against the ungrouped limit of 1`);
            }
            assert.equal(harness.chrome.storage.local._dump()[`groupOverride_0_${setup.groupId}`], 4, 'the source group keeps its limit');
            assert.equal(await getOp(setup.A.windowId), null);
        });

        it("tabs merged into another group use that group's limit", async () => {
            await setup({
                limit: 10,
                local: { ...groupLimit(7, 5), ...groupLimit(8, 1) },
                tabs: [
                    { id: 1, windowId: 1, groupId: 7 },
                    { id: 2, windowId: 1, groupId: 7 },
                    { id: 3, windowId: 1, groupId: 8 },
                    { id: 10, windowId: 2 }
                ]
            });
            assert.equal(await getOp(), null);

            harness.setGroup(1, 8);
            await flush();

            const op = await getOp();
            assert.equal(op.tabs.find((t) => t.id === 1).status, 'moved', 'group 8 now holds 2, over its limit of 1');
        });
    });
});

describe('setGroupLimit (the popup saves through the background)', () => {
    beforeEach(() => setup());

    it("stores a group's limit by group ID under the current tag, and the ungrouped limit with its window", async () => {
        await saveGroupLimit(1, 7, 4);
        await saveGroupLimit(1, -1, 6);
        await harness.chrome.storage.local.set({ groupLimitSession: 'b2' });
        await saveGroupLimit(2, 8, 5);

        const stored = harness.chrome.storage.local._dump();
        assert.equal(stored.groupOverride_0_7, 4);
        assert.equal(stored.groupLimit_1_ungrouped, 6);
        assert.equal(stored.groupOverride_b2_8, 5);
    });

    it('replaces any legacy key for that group', async () => {
        await harness.chrome.storage.local.set({ groupLimit_1_7: 2, groupLimit_2_7: 3, groupLimit_1_8: 4 });
        await saveGroupLimit(1, 7, 5);
        const stored = harness.chrome.storage.local._dump();
        assert.equal(stored.groupOverride_0_7, 5);
        assert.equal(stored.groupLimit_1_7, undefined);
        assert.equal(stored.groupLimit_2_7, undefined);
        assert.equal(stored.groupLimit_1_8, 4, "another group's key is untouched");
    });

    it('reports a failed save', async () => {
        harness.failures.storage.local = (op) => op === 'set';
        const response = await cmd({ action: 'setGroupLimit', windowId: 1, groupId: 7, limit: 4 });
        assert.equal(response.success, false);
        assert.match(response.error, /could not be saved/);
    });

    it('a saved group limit invalidates open selections in every window, since it names no window', async () => {
        await open(); // window 1: pending
        const before = await getOp(1);
        await saveGroupLimit(2, 8, 5); // a group that isn't even in window 1
        assert.ok((await getOp(1)).revision > before.revision);
    });
});

describe('adopting group limits stored by an earlier version (test 9)', () => {
    it('adopts a key whose group is live in its window, and the limit then follows the group (s3)', async () => {
        const { setup, steps } = await setupFromTrace('s3', { local: (s) => ({ [`groupLimit_${s.A.windowId}_${s.groupId}`]: 3 }) });
        const stored = harness.chrome.storage.local._dump();
        assert.equal(stored[`groupOverride_0_${setup.groupId}`], 3);
        assert.equal(stored[`groupLimit_${setup.A.windowId}_${setup.groupId}`], undefined);

        await replay(harness, steps);
        assert.equal(await statusIn(setup.B.windowId, await open(setup.B.windowId, { groupId: setup.groupId })), 'pending');
    });

    it('drops a key whose group is live in another window, or gone, without applying it', async () => {
        const { setup } = await setupFromTrace('s1', {
            local: (s) => ({ [`groupLimit_${s.B.windowId}_${s.groupId}`]: 1, [`groupLimit_${s.A.windowId}_999`]: 1 })
        });
        const stored = harness.chrome.storage.local._dump();
        assert.deepEqual(Object.keys(stored).filter((k) => k.startsWith('group')), [], 'both removed, nothing adopted');
        assert.equal(await getOp(setup.A.windowId), null, 'the group of 3 has the default limit of 10');
    });

    it('after a crash between the adoption write and the legacy delete, one limit applies: the tagged one', async () => {
        const { setup } = await setupFromTrace('s1', {
            local: (s) => ({ ...groupLimit(s.groupId, 3), [`groupLimit_${s.A.windowId}_${s.groupId}`]: 5 })
        });
        const stored = harness.chrome.storage.local._dump();
        assert.equal(stored[`groupOverride_0_${setup.groupId}`], 3);
        assert.equal(stored[`groupLimit_${setup.A.windowId}_${setup.groupId}`], undefined);
    });

    it('a newer value saved after an interrupted adoption wins when adoption is retried (Codex)', async () => {
        // Adoption writes the tagged value, but removing the legacy key fails
        const trace = loadTrace('s1');
        const recorded = setupOf(trace);
        const legacyKey = `groupLimit_${recorded.A.windowId}_${recorded.groupId}`;
        harness = createChromeMock({ tabs: initialTabs(trace) });
        await harness.chrome.storage.local.set({ defaultTabLimit: 10, [legacyKey]: 3 });
        harness.failures.storage.local = (op) => op === 'remove';
        await startServiceWorker(harness);
        assert.equal(harness.chrome.storage.local._dump()[`groupOverride_0_${recorded.groupId}`], 3);
        assert.equal(harness.chrome.storage.local._dump()[legacyKey], 3, 'the legacy key is still there');

        // The user saves a newer value (its own legacy cleanup fails too, but the save stands)
        await saveGroupLimit(recorded.A.windowId, recorded.groupId, 7);

        // The next worker start retries adoption
        harness.failures.storage.local = null;
        await workerRestart();

        const stored = harness.chrome.storage.local._dump();
        assert.equal(stored[`groupOverride_0_${recorded.groupId}`], 7, 'the newer value wins');
        assert.equal(stored[legacyKey], undefined, 'the legacy key is gone');
    });
});

describe('a group move shares one verdict only among the tabs that moved together (Codex)', () => {
    // A single tab dragged into a group in another window, as Chrome reports it
    const dragIntoGroup = async (tabId, fromWindowId, toWindowId, groupId) => {
        for (const e of [
            { ev: 'tabs.onDetached', tabId, oldWindowId: fromWindowId },
            { ev: 'tabs.onAttached', tabId, newWindowId: toWindowId },
            { ev: 'tabs.onUpdated(groupId)', tabId, groupId }
        ]) {
            harness.applyEvent(e);
            await flush(5);
        }
    };

    it('a tab that moved into the group earlier is not flagged when a later tab pushes it over', async () => {
        await setup({
            limit: 10,
            local: groupLimit(7, 3),
            tabs: [
                { id: 1, windowId: 1, groupId: 7 },
                { id: 2, windowId: 1, groupId: 7 },
                { id: 10, windowId: 2 },
                { id: 11, windowId: 2 },
                { id: 12, windowId: 2 }
            ]
        });
        await dragIntoGroup(10, 2, 1, 7); // group 7 now holds 3: at its limit, fine
        assert.equal(await getOp(1), null);

        await dragIntoGroup(11, 2, 1, 7); // 4: over
        const op = await getOp(1);
        assert.equal(op.tabs.find((t) => t.id === 11).status, 'moved');
        assert.equal(op.tabs.find((t) => t.id === 10).status, 'ordinary', 'the earlier arrival keeps its own verdict');
    });

    it('nor are the tabs of an earlier whole-group move', async () => {
        const { setup, steps } = await setupFromTrace('s1', { local: (s) => groupLimit(s.groupId, 3) });
        await replay(harness, steps, { flushBetween: 5 }); // the group of 3 arrives at its limit
        assert.equal(await getOp(setup.B.windowId), null);

        const newcomer = setup.A.tabIds[3]; // the source's ungrouped tab
        await dragIntoGroup(newcomer, setup.A.windowId, setup.B.windowId, setup.groupId);

        const op = await getOp(setup.B.windowId);
        assert.equal(op.tabs.find((t) => t.id === newcomer).status, 'moved');
        for (const id of setup.groupTabIds) {
            assert.equal(op.tabs.find((t) => t.id === id).status, 'ordinary', `tab ${id} arrived earlier`);
        }
    });
});


// --------------------------------------------- sessions and the startup gate (stage 3)

// Window 1 holds a group 7 of `size` tabs, window 2 one tab
async function setupGroupWindow({ size = 3, override, limit = 10, local = {} } = {}) {
    const tabs = [];
    for (let i = 1; i <= size; i++) tabs.push({ id: i, windowId: 1, groupId: 7, url: `https://g${i}.example/` });
    tabs.push({ id: 50, windowId: 2, url: 'https://other.example/' });
    await setup({ limit, tabs, local: { ...(override ? groupLimit(7, override) : {}), ...local } });
    harness.groups.push({ id: 7, windowId: 1, title: 'Work', color: 'blue' });
}

// Window 1 restored with 5 tabs over the limit of 3: a startup operation
const restoredOverLimit = () => [
    ...Array.from({ length: 5 }, (_, i) => ({ id: i + 1, windowId: 1, url: `https://restored${i}.example/` })),
    { id: 10, windowId: 2, url: 'https://other.example/' }
];
// The rotation runs on the worker's one queue, so while it is held nothing queued after
// it runs. The gate matters for what was queued before it, and while it keeps failing.
const failRotation = () => {
    harness.failures.storage.local = (op, items) => op === 'set' && 'groupLimitSession' in items;
};
// Hold the rotation's tag write (step 2) until resumed
const holdRotation = () => harness.pause(harness.chrome.storage.local, 'set', { when: (items) => 'groupLimitSession' in items });
// A browser restart in which restored group 7 gets the ID 7 again
const restartReusingGroup7 = (options = {}) => browserRestart({ renumber: { groupIds: { 7: 7 } }, ...options });

describe('test 9a (R8): limits belong to one browser session', () => {
    it('an extension reload keeps them for the same live groups', async () => {
        await setupGroupWindow({ size: 3, override: 2 });
        assert.ok(await getOp(1), '3 > 2');
        await extensionReload();
        assert.ok(await getOp(1), 'still 3 > 2');
        assert.equal(sessionTag(), undefined, 'no new session');
    });

    it('after a browser restart an old limit never applies, even to a restored group that gets its ID', async () => {
        await setupGroupWindow({ size: 3, override: 2 });
        const ids = await restartReusingGroup7();
        const w = ids.windows.get(1);

        assert.equal(ids.groups.get(7), 7);
        assert.equal(await getOp(w), null, 'group 7 of this session has the default limit');
        assert.match(sessionTag(), /^[0-9a-f-]{36}$/);
        assert.equal(harness.chrome.storage.local._dump().groupOverride_0_7, undefined, 'cleanup removed it');
        assert.equal(harness.calls.badge, '');
    });

    it('also when cleanup fails, and for a legacy key that cleanup failed to remove', async () => {
        await setupGroupWindow({ size: 3, override: 2 });
        const ids = await restartReusingGroup7({
            beforeStart: async (map) => {
                // A legacy key whose window and group both match the restored ones
                await harness.chrome.storage.local.set({ [`groupLimit_${map.windows.get(1)}_7`]: 1 });
                harness.failures.storage.local = (op) => op === 'remove';
            }
        });
        const w = ids.windows.get(1);
        assert.equal(await getOp(w), null);
        assert.equal(harness.chrome.storage.local._dump().groupOverride_0_7, 2, 'still stored, never applied');

        harness.failures.storage.local = null;
        await workerRestart(); // the tag is no longer "0": legacy keys are only removed, never adopted
        const stored = harness.chrome.storage.local._dump();
        assert.equal(stored[`groupLimit_${w}_7`], undefined);
        assert.equal(stored.groupOverride_0_7, undefined);
        assert.equal(await getOp(w), null);
    });

    it("a missed start (the extension was disabled) leaves the old tag, so an old limit can match: the known exception", async () => {
        await setupGroupWindow({ size: 3, override: 2 });
        const ids = await restartReusingGroup7({ onStartup: 'never' });
        assert.ok(await getOp(ids.windows.get(1)), 'decision 7: documented, not prevented');
        assert.equal(sessionTag(), undefined);
    });

    it("a group closed within the session keeps its limit until the next start's cleanup (decision 6)", async () => {
        await setupGroupWindow({ size: 3, override: 2, local: groupLimit(8, 4) });
        await harness.chrome.tabs.remove([1, 2, 3]); // group 7 is gone: window 1 closes
        await flush();
        assert.equal(harness.chrome.storage.local._dump().groupOverride_0_7, 2, 'kept: harmless');

        await browserRestart();
        const stored = harness.chrome.storage.local._dump();
        assert.equal(stored.groupOverride_0_7, undefined);
        assert.equal(stored.groupOverride_0_8, undefined);
    });
});

describe('test 9a: the startup gate', () => {
    it('while the gate is on, a new tab in a restored group is decided under the default limit', async () => {
        await setupGroupWindow({ size: 3, override: 2 });
        const ids = await restartReusingGroup7({ beforeStart: failRotation });
        const w = ids.windows.get(1);

        const added = await open(w, { groupId: 7 });
        assert.equal(await statusIn(w, added), 'ordinary', 'not pending under the old limit of 2');
        assert.ok(harness.tabIds(w).includes(added));
        assert.equal((await getState(w)).groupLimitsPaused, true, 'the popup shows default group limits');

        const { messages } = harness.connectPort();
        harness.failures.storage.local = null;
        await saveGroupLimit(2, 9, 5); // lets the rotation through
        assert.equal(await getOp(w), null);
        assert.equal((await getState(w)).groupLimitsPaused, false);
        assert.equal(messages.at(-1).groupLimitsPaused, false, 'an open popup is told');
    });

    it('a creation already under way when onStartup arrives is gated too', async () => {
        await setupGroupWindow({ size: 3, override: 2 });
        const ids = await restartReusingGroup7({ onStartup: 'never' });
        const w = ids.windows.get(1);

        // The creation task has started (it is reading the tab) when onStartup arrives
        const reading = harness.pause(harness.chrome.tabs, 'get');
        const added = harness.userOpensTab({ windowId: w, groupId: 7, pendingUrl: 'https://x.example/' });
        await reading.reached;
        const held = holdRotation(); // queued behind the creation
        harness.fire('runtimeOnStartup');
        reading.resume();
        await held.reached; // the creation has been decided and saved by now

        const win = (await savedState()).windows[w];
        assert.equal([...(win?.pending ?? []), ...(win?.startup ?? [])].includes(added), false, 'decided under the default limit of 10');
        assert.equal(win?.op ?? null, null, "the stale decision from the start-up pass was settled away too");
        held.resume();
        await flush();
    });

    it('a failing rotation keeps the gate on; a later save retries it, then applies under the new tag', async () => {
        await setupGroupWindow({ size: 3, override: 2 });
        const ids = await restartReusingGroup7({
            beforeStart: () => {
                harness.failures.storage.local = (op, items) => op === 'set' && 'groupLimitSession' in items;
            }
        });
        const w = ids.windows.get(1);
        assert.equal(await getOp(w), null, 'gated: no group limit applies');

        const refused = await cmd({ action: 'setGroupLimit', windowId: w, groupId: 7, limit: 2 });
        assert.equal(refused.success, false);
        assert.match(refused.error, /browser start/);

        harness.failures.storage.local = null;
        await saveGroupLimit(w, 7, 2);
        const tag = sessionTag();
        assert.match(tag, /^[0-9a-f-]{36}$/, 'the rotation went through first');
        assert.equal(harness.chrome.storage.local._dump()[`groupOverride_${tag}_7`], 2);
        assert.ok(await getOp(w), 'the new limit applies: 3 > 2');
    });

    it('a worker restart while the rotation is held keeps the gate and finishes with the same tag', async () => {
        await setupGroupWindow({ size: 3, override: 2 });
        const held = holdRotation(); // never resumed: the worker stops in the middle of step 2
        const ids = await restartReusingGroup7();
        await held.reached;
        const marker = (await harness.chrome.storage.session.get('tl_rotation_pending')).tl_rotation_pending;
        assert.ok(marker?.tag);

        await workerRestart();
        assert.equal(sessionTag(), marker.tag, 'the marked tag, not another one');
        assert.equal((await harness.chrome.storage.session.get('tl_rotation_pending')).tl_rotation_pending, null);
        assert.equal(await getOp(ids.windows.get(1)), null);
    });

    it('a worker stop after the tag write but before the corrected state is saved is finished by the next worker (Codex)', async () => {
        // Session 1: group 7 of 5 tabs, limit 2; default 3. Restored with the same ID, it
        // is over under the old limit (start-up pass) and still over under the default.
        await setupGroupWindow({ size: 5, override: 2, limit: 3 });
        const step4 = harness.pause(harness.chrome.storage.session, 'set', { when: (items) => 'tl_state' in items && 'tl_rotation_pending' in items });
        const ids = await restartReusingGroup7({
            onStartup: 'never'
        });
        const w = ids.windows.get(1);
        const before = await getOp(w); // the view from before the rotation
        harness.fire('runtimeOnStartup');
        await step4.reached; // never resumed

        await workerRestart();
        const after = await getOp(w);
        assert.ok(after.revision > before.revision, 'the revision was bumped');
        assert.deepEqual(after.constraints.map((c) => [c.id, c.limit]), [['window', 3], ['group:7', 3]], 'judged under the default');
        const reply = await cmd(decide(before, { windowId: w, action: 'closeSelected', tabIds: before.tabs.slice(0, 2).map((t) => t.id) }));
        assert.deepEqual(reply, { success: false, error: 'The tabs changed; please review again' });
        assert.equal(harness.tabIds(w).length, 5, 'nothing closed');
        assert.equal(harness.calls.badge, '2');
    });

    it('a save sent while the rotation is held waits for it and is stored under the new tag', async () => {
        await setupGroupWindow({ size: 3 });
        const held = holdRotation();
        const ids = await restartReusingGroup7();
        await held.reached;
        const w = ids.windows.get(1);

        const reply = cmd({ action: 'setGroupLimit', windowId: w, groupId: 7, limit: 2 });
        await flush();
        held.resume();
        assert.deepEqual(await reply, { success: true });
        await flush();

        assert.equal(harness.chrome.storage.local._dump()[`groupOverride_${sessionTag()}_7`], 2);
        assert.ok(await getOp(w), 'it applies: 3 > 2');
    });
});

describe('test 9a: decisions already in progress when onStartup arrives (Codex, stage 3 review)', () => {
    it('an admission paused at its last look decides again under the default limit, and closes nothing', async () => {
        // Group 7: 3 tabs, limit 2, so window 1 has an operation; at most 1 pending tab
        await setupGroupWindow({ size: 3, override: 2, local: { maxPendingPerWindow: 1 } });
        await open(1, { groupId: 7 }); // pending: the cap is reached
        assert.ok(await getOp());

        // The next tab is rejected under the old limit; it is held at its last look
        const added = harness.userOpensTab({ windowId: 1, groupId: 7, pendingUrl: 'https://new.example/' });
        const lastLook = harness.pause(harness.chrome.tabs, 'get', { when: (id) => id === added, nth: 3 });
        await lastLook.reached;
        harness.fire('runtimeOnStartup');
        lastLook.resume();
        await flush();

        assert.ok(harness.tabIds(1).includes(added), 'not closed: it fits under the default limit of 10');
        assert.equal(await getOp(), null);
        assert.equal((await savedState()).windows[1]?.op?.rejectedCount ?? 0, 0);
    });

    it('an open popup is told when the gate turns on, and again when the rotation is done (Codex)', async () => {
        await setupGroupWindow({ size: 3, override: 2 });
        const { messages } = harness.connectPort();
        const tagWrite = harness.pause(harness.chrome.storage.local, 'set', { when: (items) => 'groupLimitSession' in items });
        harness.fire('runtimeOnStartup');
        await tagWrite.reached;

        assert.deepEqual(messages.at(-1), { type: 'groupLimits', paused: true }, 'while the rotation is pending');
        tagWrite.resume();
        await flush();
        assert.equal(messages.at(-1).type, 'state');
        assert.equal(messages.at(-1).groupLimitsPaused, false);
    });

    describe('startup mode stays on when the gate stops a close before any tab is removed', () => {
        async function startClosing({ nth }) {
            await setup({ enforce: false, tabs: restoredOverLimit() });
            const op = await getOp();
            assert.equal(op.kind, 'startup');
            const get = harness.pause(harness.chrome.tabs, 'get', { nth });
            const reply = cmd(decide(op, { action: 'closeSelected', tabIds: [1, 2] }));
            await get.reached;
            harness.fire('runtimeOnStartup');
            get.resume();
            assert.deepEqual(await reply, { success: false, error: GATE_MESSAGE });
            await flush();
        }

        it('stopped before the first removal: no decision was made, startup mode stays on', async () => {
            await startClosing({ nth: 1 });
            assert.equal(harness.tabIds(1).length, 5, 'none removed');
            assert.equal((await savedState()).startupMode, true);
            const state = await getState(1);
            assert.equal(state.startupMode, true);
            assert.equal(state.operation.kind, 'startup', 'still over: the startup operation stays');
            assert.deepEqual(state.operation.tabs.filter((t) => t.status === 'startup').length, 5);
        });

        it('stopped between two removals: the first close was the user\'s decision, startup mode ends', async () => {
            await startClosing({ nth: 2 });
            assert.equal(harness.tabIds(1).includes(1), false);
            assert.ok(harness.tabIds(1).includes(2));
            assert.equal((await savedState()).startupMode, false);
        });
    });
});

describe('test 9a: no decision can be confirmed while the gate is on (Codex)', () => {
    // Window 1: 3 tabs, limit 3; two pending tabs make it over by 2
    async function overWithPending() {
        await setup();
        const pending = await openMany(2);
        return { op: await getOp(), pending };
    }

    it('rejects a confirmation queued before onStartup arrived, and the old view stays stale after the rotation', async () => {
        const { op, pending } = await overWithPending();

        const queuedFirst = cmd(decide(op, { action: 'closeSelected', tabIds: [1, ...pending] })); // more than needed
        const pendingFirst = cmd(decide(op, { action: 'closePending' }));
        harness.fire('runtimeOnStartup');
        assert.deepEqual(await queuedFirst, { success: false, error: GATE_MESSAGE });
        assert.deepEqual(await pendingFirst, { success: false, error: GATE_MESSAGE });
        await flush();

        assert.deepEqual(await cmd(decide(op, { action: 'closePending' })), { success: false, error: 'The tabs changed; please review again' });
        assert.equal(harness.tabIds(1).length, 5, 'nothing closed');
    });

    it('rejects them while the rotation keeps failing', async () => {
        const { op, pending } = await overWithPending();
        harness.failures.storage.local = (o, items) => o === 'set' && 'groupLimitSession' in items;
        harness.fire('runtimeOnStartup');
        await flush();
        assert.deepEqual(await cmd(decide(op, { action: 'closeSelected', tabIds: pending })), { success: false, error: GATE_MESSAGE });
        assert.equal(harness.tabIds(1).length, 5);
        harness.failures.storage.local = null;
        await saveGroupLimit(2, 9, 5); // lets the rotation through
    });

    it('rejects Keep these without granting an allowance', async () => {
        await setup({ enforce: false, tabs: restoredOverLimit() });
        const op = await getOp();
        const allowance = (await savedState()).windows[1].allowance;
        failRotation();
        harness.fire('runtimeOnStartup');
        await flush();

        assert.deepEqual(await cmd(decide(op, { action: 'keepThese' })), { success: false, error: GATE_MESSAGE });
        assert.deepEqual((await savedState()).windows[1].allowance, allowance);
        harness.failures.storage.local = null;
        await saveGroupLimit(2, 9, 5);
    });

    describe('a confirmation already in progress when onStartup arrives', () => {
        it('stops before its first removal', async () => {
            const { op, pending } = await overWithPending();
            const firstGet = harness.pause(harness.chrome.tabs, 'get');
            const reply = cmd(decide(op, { action: 'closeSelected', tabIds: pending }));
            await firstGet.reached;
            harness.fire('runtimeOnStartup');
            firstGet.resume();

            assert.deepEqual(await reply, { success: false, error: GATE_MESSAGE });
            assert.deepEqual(harness.tabIds(1).filter((id) => pending.includes(id)), pending, 'none removed');
            await flush();
        });

        it('stops between two removals: the first stays closed, no later one is removed', async () => {
            const { op, pending } = await overWithPending();
            const secondGet = harness.pause(harness.chrome.tabs, 'get', { nth: 2 });
            const reply = cmd(decide(op, { action: 'closeSelected', tabIds: pending }));
            await secondGet.reached;
            harness.fire('runtimeOnStartup');
            secondGet.resume();

            assert.deepEqual(await reply, { success: false, error: GATE_MESSAGE });
            assert.deepEqual(harness.tabIds(1).filter((id) => pending.includes(id)), [pending[1]]);
            await flush();
        });

        it('Keep these stops before writing the allowance', async () => {
            await setup({ enforce: false, tabs: restoredOverLimit() });
            const op = await getOp();
            const allowance = (await savedState()).windows[1].allowance;
            // keepThese reads the window twice: in its refresh, then for the allowance
            const secondRead = harness.pause(harness.chrome.tabs, 'query', { nth: 2 });
            const reply = cmd(decide(op, { action: 'keepThese' }));
            await secondRead.reached;
            harness.fire('runtimeOnStartup');
            secondRead.resume();

            assert.deepEqual(await reply, { success: false, error: GATE_MESSAGE });
            assert.deepEqual((await savedState()).windows[1].allowance, allowance);
            await flush();
        });
    });
});

describe('test 9a: recovery from a decision made under a stale limit (Codex)', () => {
    // Session 1: group 7 of `size` tabs in window 1 with an old limit. After the restart,
    // restored group 7 gets the ID 7 again, and the start-up pass decides under the old
    // limit before onStartup arrives and the tag rotates.
    async function restartWithStaleLimit({ size, oldLimit, defaultLimit, windowLimit }) {
        await setupGroupWindow({ size, override: oldLimit, limit: defaultLimit });
        const ids = await restartReusingGroup7({
            onStartup: 'never',
            beforeStart: async (map) => {
                if (windowLimit) await harness.chrome.storage.local.set({ [`tabLimit_${map.windows.get(1)}`]: windowLimit });
            }
        });
        const w = ids.windows.get(1);
        return { w, before: await getOp(w), badgeBefore: harness.calls.badge };
    }
    const rotate = async () => {
        harness.fire('runtimeOnStartup');
        await flush();
    };
    const tryOldView = async (w, before) => {
        const tabIds = before.tabs.slice(0, 1).map((t) => t.id);
        return [
            await cmd(decide(before, { windowId: w, action: 'closeSelected', tabIds })),
            await cmd(decide(before, { windowId: w, action: 'keepThese' }))
        ];
    };

    it('a limit lower than the default: the startup decision and its badge go away', async () => {
        const { w, before, badgeBefore } = await restartWithStaleLimit({ size: 4, oldLimit: 2, defaultLimit: 10 });
        assert.ok(before, 'decided under the old limit of 2');
        assert.equal(badgeBefore, '2');

        await rotate();
        assert.equal(await getOp(w), null);
        assert.equal(harness.calls.badge, '');
        for (const reply of await tryOldView(w, before)) {
            assert.deepEqual(reply, { success: false, error: 'There is nothing to decide in this window' });
        }
        assert.equal(harness.tabIds(w).length, 4);
    });

    it('a limit higher than the default: a startup decision appears, with its tabs as startup tabs', async () => {
        const { w, before } = await restartWithStaleLimit({ size: 5, oldLimit: 10, defaultLimit: 3, windowLimit: 10 });
        assert.equal(before, null, 'nothing to decide under the old limit of 10');

        await rotate();
        const op = await getOp(w);
        assert.equal(op.kind, 'startup');
        assert.ok(op.tabs.every((t) => t.status === 'startup'), 'listed as startup tabs, as at a browser start');
        assert.deepEqual(op.constraints.map((c) => c.id), ['group:7']);
        assert.equal(harness.calls.badge, '2');
        assert.equal(harness.tabIds(w).length, 5);
    });

    it('over under both: the decision stays, with a new revision', async () => {
        const { w, before } = await restartWithStaleLimit({ size: 5, oldLimit: 2, defaultLimit: 3, windowLimit: 10 });
        assert.equal(before.constraints.find((c) => c.id === 'group:7').limit, 2);

        await rotate();
        const op = await getOp(w);
        assert.ok(op.revision > before.revision);
        assert.equal(op.constraints.find((c) => c.id === 'group:7').limit, 3);
        assert.equal(harness.calls.badge, '2');
        for (const reply of await tryOldView(w, before)) {
            assert.deepEqual(reply, { success: false, error: 'The tabs changed; please review again' });
        }
        assert.equal(harness.tabIds(w).length, 5, 'nothing closed');
    });
});

describe('test 9a: cleanup never removes a limit saved under a newer tag (Codex)', () => {
    it('a reset while cleanup is in flight, then a save under the new tag', async () => {
        await setupGroupWindow({ size: 3 });
        await harness.chrome.storage.local.set({ groupOverride_old1_5: 4 }); // after the first start's cleanup
        const cleanup = harness.pause(harness.chrome.storage.local, 'remove', { when: (keys) => [].concat(keys).includes('groupOverride_old1_5') });
        const restarting = workerRestart(); // cleanup at the worker start: read done, removal held
        await cleanup.reached;
        await resetSettings();
        cleanup.resume();
        await restarting;

        await saveGroupLimit(1, 7, 2);
        await workerRestart(); // and once more, reading after the reset
        assert.equal(harness.chrome.storage.local._dump()[`groupOverride_${sessionTag()}_7`], 2);
        assert.ok(await getOp(1), 'it applies: 3 > 2');
    });
});

// Stage 4 (R2a): an admission that counted a window before a group arrived in it or
// left it decides again, on the window as it is now, before it closes anything.
// The new tab's task makes three tabs.get calls per attempt: the tab, a fresh look
// after the count, and (when it would close the tab) a last look.
describe('test 5a (R2a): admission notices a group arriving or leaving mid-decision', () => {
    const others = (setup) => setup.A.tabIds.filter((id) => !setup.groupTabIds.includes(id));
    // Window A (4 tabs, limit 3) has an operation, and its one pending tab fills the cap
    async function sourceAtCap() {
        const trace = await setupFromTrace('s1', { local: (s) => ({ [`tabLimit_${s.A.windowId}`]: 3, maxPendingPerWindow: 1 }) });
        await open(trace.setup.A.windowId);
        assert.ok(await getOp(trace.setup.A.windowId));
        return trace;
    }
    const opensIn = (windowId) => harness.userOpensTab({ windowId, pendingUrl: 'https://new.example/' });
    const roles = async (setup, windowId, added) => ({
        added: await statusIn(windowId, added),
        group: await Promise.all(setup.groupTabIds.map((id) => statusIn(windowId, id))),
        constraints: (await getOp(windowId))?.constraints.map((c) => [c.scope, c.count, c.limit]) ?? null
    });

    it('a different group arrives after the count: the tab opened first stays ordinary, the group is flagged moved', async () => {
        const { setup, steps } = await setupFromTrace('s1', { local: (s) => ({ [`tabLimit_${s.B.windowId}`]: 4 }) });
        const B = setup.B.windowId;
        const added = opensIn(B); // 2 + 1 fit in 4
        const afterCount = harness.pause(harness.chrome.tabs, 'get', { when: (id) => id === added, nth: 2 });
        await afterCount.reached;
        await replay(harness, steps); // the group of 3 arrives: 6 > 4
        afterCount.resume();
        await flush();

        assert.equal(await statusIn(B, added), 'ordinary', 'the move put the window over, not the new tab');
        assert.deepEqual(await movedIn(B), [...setup.groupTabIds].sort());
    });

    it('a group leaves after the count, so the new tab fits: it is admitted, not closed', async () => {
        const { setup, steps } = await sourceAtCap();
        const A = setup.A.windowId;
        const added = opensIn(A); // over, at the cap: it would be closed
        const lastLook = harness.pause(harness.chrome.tabs, 'get', { when: (id) => id === added, nth: 3 });
        await lastLook.reached;
        await replay(harness, steps); // the group of 3 leaves: 1 + 1 pending + the new tab fit in 3
        lastLook.resume();
        await flush();

        assert.ok(harness.tabIds(A).includes(added), 'not closed');
        assert.equal(await getOp(A), null);
        assert.equal(await statusIn(A, added), 'ordinary');
    });

    it('tabs are closed after the count, so the new tab fits: it is admitted, not closed', async () => {
        const { setup } = await sourceAtCap();
        const A = setup.A.windowId;
        const added = opensIn(A);
        const lastLook = harness.pause(harness.chrome.tabs, 'get', { when: (id) => id === added, nth: 3 });
        await lastLook.reached;
        await harness.chrome.tabs.remove(setup.groupTabIds); // the user closes 3 tabs
        await flush();
        lastLook.resume();
        await flush();

        assert.ok(harness.tabIds(A).includes(added), 'not closed');
        assert.equal(await getOp(A), null);
    });

    it('the window changes on every attempt: the decision is handed on, and only a current view closes the tab', async () => {
        const { setup } = await sourceAtCap();
        const A = setup.A.windowId;
        const [other] = others(setup);
        const added = opensIn(A);

        // At each of the first three last looks, a tab in window A changes group (to the same group)
        const realGet = harness.chrome.tabs.get;
        const realRemove = harness.chrome.tabs.remove;
        let looks = 0;
        let looksAtClose = null;
        harness.chrome.tabs.get = async (id) => {
            if (id === added && ++looks % 3 === 0 && looks <= 9) {
                harness.fire('tabsOnUpdated', other, { groupId: -1 }, { id: other, windowId: A, groupId: -1 });
            }
            return realGet(id);
        };
        harness.chrome.tabs.remove = async (ids) => {
            if ([ids].flat().includes(added)) looksAtClose = looks;
            return realRemove(ids);
        };
        await flush();
        harness.chrome.tabs.get = realGet;
        harness.chrome.tabs.remove = realRemove;

        assert.equal(looksAtClose, 12, 'closed by the handed-on task (a 4th attempt), on a view nothing changed');
        assert.equal(harness.tabIds(A).includes(added), false);
        const win = (await savedState()).windows[A];
        assert.equal(win.pending.length, 1, 'never let past the cap');
        assert.equal(win.op.rejectedCount, 1);
    });
});

describe('test 5 (R2): a creation already under way when a group moves in', () => {
    // Group of 3 with its own limit of 3; the default limit of 2 would put it over
    const local = (s) => ({
        defaultTabLimit: 2,
        [`tabLimit_${s.A.windowId}`]: 20,
        [`tabLimit_${s.B.windowId}`]: 20,
        [`groupLimit_${s.B.windowId}_ungrouped`]: 5
    });

    for (const [when, nth] of [['before it counts', 1], ['after it counts', 2]]) {
        it(`is decided under the group's own limit, whether the move lands ${when}`, async () => {
            const { setup, steps } = await setupFromTrace('s1', { local: (s) => ({ ...local(s), ...groupLimit(s.groupId, 3) }) });
            const B = setup.B.windowId;
            const added = harness.userOpensTab({ windowId: B, pendingUrl: 'https://new.example/' });
            const get = harness.pause(harness.chrome.tabs, 'get', { when: (id) => id === added, nth });
            await get.reached;
            await replay(harness, steps);
            get.resume();
            await flush();

            assert.equal(await getOp(B), null, 'the group of 3 is within its limit of 3');
            assert.equal(await statusIn(B, added), 'ordinary');
            assert.ok(harness.tabIds(B).includes(added));
        });
    }

    it('control: without its own limit, the same group is over the default and is flagged moved; the earlier tab is not held', async () => {
        const { setup, steps } = await setupFromTrace('s1', { local });
        const B = setup.B.windowId;
        const added = harness.userOpensTab({ windowId: B, pendingUrl: 'https://new.example/' });
        const get = harness.pause(harness.chrome.tabs, 'get', { when: (id) => id === added, nth: 2 });
        await get.reached;
        await replay(harness, steps);
        get.resume();
        await flush();

        assert.equal(await statusIn(B, added), 'ordinary', 'opened before the group arrived');
        assert.deepEqual(await movedIn(B), [...setup.groupTabIds].sort());
        assert.ok(harness.tabIds(B).includes(added));
    });
});

describe('test 8b (R6): a reset or import never brings an old limit back', () => {
    const points = (steps) => {
        const removals = steps.map((e, i) => (e.ev === 'tabGroups.onRemoved' ? i : -1)).filter((i) => i >= 0);
        return { 'before the move': 0, 'between the hops': removals[1], 'after the move': steps.length };
    };

    for (const [how, run] of [['reset', resetSettings], ['import', importReplacing]]) {
        for (const at of ['before the move', 'between the hops', 'after the move']) {
            it(`${how} ${at} of a two-hop drag (4a)`, async () => {
                const { setup: recorded, steps } = await setupFromTrace('s4', { part: '4a' });
                await saveGroupLimit(recorded.A.windowId, recorded.groupId, 3);
                const cut = points(steps)[at];

                await replay(harness, steps.slice(0, cut), { flushBetween: 5 });
                await run();
                await replay(harness, steps.slice(cut), { flushBetween: 5 });

                const B = recorded.B.windowId;
                const added = await open(B, { groupId: recorded.groupId });
                assert.equal(await statusIn(B, added), 'ordinary', 'the old limit of 3 is gone: the default 10 applies');
                await saveGroupLimit(B, recorded.groupId, 3);
                assert.ok(await getOp(B), 'a limit saved after it applies: 4 > 3');
            });
        }
    }

    it('a save that read the tag before a reset and writes after it does not apply', async () => {
        await setupGroupWindow({ size: 3 });
        const write = harness.pause(harness.chrome.storage.local, 'set', { when: (items) => 'groupOverride_0_7' in items });
        const reply = cmd({ action: 'setGroupLimit', windowId: 1, groupId: 7, limit: 2 });
        await write.reached;
        await resetSettings();
        write.resume();
        assert.deepEqual(await reply, { success: true });
        await flush();

        assert.equal(harness.chrome.storage.local._dump().groupOverride_0_7, 2, 'written under the old tag');
        assert.equal(await getOp(1), null, 'and never applied');
    });

    it('legacy adoption interleaved with a reset never applies the old limit', async () => {
        for (const when of ['before the read', 'between the read and the write', 'after the write']) {
            const trace = loadTrace('s1');
            const recorded = setupOf(trace);
            harness = createChromeMock({ tabs: initialTabs(trace) });
            await harness.chrome.storage.local.set({ defaultTabLimit: 10, [`groupLimit_${recorded.A.windowId}_${recorded.groupId}`]: 2 });

            if (when === 'before the read') {
                await resetSettings();
                await startServiceWorker(harness);
            } else if (when === 'between the read and the write') {
                const write = harness.pause(harness.chrome.storage.local, 'set', { when: (items) => `groupOverride_0_${recorded.groupId}` in items });
                const starting = startServiceWorker(harness);
                await write.reached;
                await resetSettings();
                write.resume();
                await starting;
            } else {
                await startServiceWorker(harness);
                await resetSettings();
            }
            await startEnforcing();

            assert.equal(await getOp(recorded.A.windowId), null, `${when}: the group of 3 has the default limit`);
            assert.equal(Object.keys(harness.chrome.storage.local._dump()).some((k) => k.startsWith('groupLimit_')), false, `${when}: no legacy key left`);
        }
    });
});

describe('test 9: adoption and the session tag', () => {
    it('nothing is adopted once the tag has changed: the key is only removed', async () => {
        const { setup: recorded } = await setupFromTrace('s1', {
            local: (s) => ({ groupLimitSession: 'b2', [`groupLimit_${s.A.windowId}_${s.groupId}`]: 2 })
        });
        const stored = harness.chrome.storage.local._dump();
        assert.equal(stored[`groupLimit_${recorded.A.windowId}_${recorded.groupId}`], undefined);
        assert.equal(Object.keys(stored).some((k) => k.startsWith('groupOverride_')), false);
        assert.equal(await getOp(recorded.A.windowId), null);
    });

    it('an update that installs at a browser start: a chance match is adopted under "0", then never applies', async () => {
        await setupGroupWindow({ size: 3 });
        const ids = await restartReusingGroup7({
            beforeStart: async (map) => {
                // A legacy key from the old version, matching by chance in the new session
                await harness.chrome.storage.local.set({ [`groupLimit_${map.windows.get(1)}_7`]: 2 });
            }
        });
        const stored = harness.chrome.storage.local._dump();
        assert.equal(await getOp(ids.windows.get(1)), null);
        assert.equal(Object.keys(stored).some((k) => k.startsWith('groupOverride_') || k.startsWith('groupLimit_')), false, 'cleanup removed it');
    });
});

// ------------------------------------------------ test 8 (R4, R5): restart at any step

// What the final state should not depend on: statuses, operations, allowances, the
// badge, lastWindow and stored settings. Operation IDs and revisions are left out
// (a restart makes new ones by design).
async function snapshot() {
    const state = await savedState();
    const windows = {};
    for (const [id, win] of Object.entries(state?.windows ?? {})) {
        windows[id] = {
            op: win.op ? { kind: win.op.kind, phase: win.op.phase, rejected: win.op.rejectedCount } : null,
            pending: [...win.pending].sort(),
            moved: [...win.moved].sort(),
            startup: [...win.startup].sort(),
            allowance: win.allowance
        };
    }
    return {
        startupMode: state?.startupMode,
        windows,
        lastWindow: state?.lastWindow,
        arrivals: Object.fromEntries(Object.entries(state?.arrivals ?? {}).map(([id, a]) => [id, a.window])),
        openMoves: Object.keys(state?.openMoves ?? {}).sort(),
        badge: harness.calls.badge,
        local: harness.chrome.storage.local._dump()
    };
}

const SWEEP = [
    ['s1'], ['s2'], ['s3'], ['s4', '4a'], ['s4', '4b'], ['s4', '4c'], ['s4', '4d'], ['s5'], ['s6']
];
const CONFIGS = {
    'within its limits': () => ({}),
    'over the window limit': () => ({ defaultTabLimit: 3 }),
    'over its group limit': (s) => groupLimit(s.groupId, 2)
};

describe('test 8 (R4): a worker restart at any step of a recorded move gives the same final state', () => {
    for (const [name, part] of SWEEP) {
        for (const [label, local] of Object.entries(CONFIGS)) {
            for (const flushBetween of [0, 5]) {
                it(`${part ?? name}, ${label}, flush ${flushBetween}`, async () => {
                    let { steps } = await setupFromTrace(name, { part, local });
                    await replay(harness, steps, { flushBetween });
                    const reference = await snapshot();

                    const differences = [];
                    for (let cut = 0; cut <= steps.length; cut++) {
                        ({ steps } = await setupFromTrace(name, { part, local }));
                        await replay(harness, steps.slice(0, cut), { flushBetween });
                        await workerRestart();
                        await replay(harness, steps.slice(cut), { flushBetween });
                        const after = await snapshot();
                        try {
                            assert.deepEqual(after, reference);
                        } catch {
                            differences.push({ cut, before: steps[cut]?.ev, after });
                            continue;
                        }
                        await workerRestart(); // a second pass changes nothing
                        assert.deepEqual(await snapshot(), reference, `second pass after cut ${cut}`);
                    }
                    assert.deepEqual(differences, [], JSON.stringify({ reference, differences }, null, 1).slice(0, 3000));
                });
            }
        }
    }
});

// Test 8a (R5): the move's events reach a worker that stops before handling them.
// Chrome has moved the tabs; the new worker learns of the move only from lastWindow.
function deliverUnhandled(steps) {
    for (const step of steps) harness.applyEvent(step); // no flush: no task runs
}
async function moveThenStop(name, { local, enforce, part } = {}) {
    const trace = await setupFromTrace(name, { local, enforce, part });
    deliverUnhandled(trace.steps);
    await workerRestart();
    return trace;
}
const movedIn = async (windowId) => [...((await savedState()).windows[windowId]?.moved ?? [])].sort();

describe('test 8a (R5): a move completes and the worker stops before handling it', () => {
    // The source window stays within its limit, so nothing tracks the group's tabs there:
    // only lastWindow shows they moved. (A group over its own limit is over in the source
    // too, so that case is also found by the older tracked-tab path.)
    it('the destination is over its window limit: the tabs come back moved', async () => {
        const { setup } = await moveThenStop('s1', { local: (s) => ({ defaultTabLimit: 3, [`tabLimit_${s.A.windowId}`]: 10 }) });
        assert.equal((await savedState()).windows[setup.A.windowId]?.op ?? null, null);
        assert.deepEqual(await movedIn(setup.B.windowId), [...setup.groupTabIds].sort());
        assert.equal((await getOp(setup.B.windowId)).kind, 'normal');
    });

    it('in startup mode too, and Keep these leaves them out', async () => {
        const { setup } = await moveThenStop('s1', { local: (s) => ({ [`tabLimit_${s.A.windowId}`]: 10, [`tabLimit_${s.B.windowId}`]: 3 }), enforce: false });
        const B = setup.B.windowId;
        const op = await getOp(B);
        assert.equal(op.kind, 'startup');
        assert.deepEqual(await movedIn(B), [...setup.groupTabIds].sort());

        assert.deepEqual(await cmd(decide(op, { windowId: B, action: 'keepThese' })), { success: true });
        assert.deepEqual(await movedIn(B), [...setup.groupTabIds].sort(), 'still moved: not kept');
        assert.ok(await getOp(B), 'the moved tabs still put the window over');
    });

    it("the group's own limit is exceeded: the tabs come back moved", async () => {
        const { setup } = await moveThenStop('s1', { local: (s) => groupLimit(s.groupId, 2) });
        assert.deepEqual(await movedIn(setup.B.windowId), [...setup.groupTabIds].sort());
    });

    it('the destination is within its limits: no tab is moved', async () => {
        const { setup } = await moveThenStop('s1');
        assert.equal(await getOp(setup.B.windowId), null);
        assert.deepEqual(await movedIn(setup.B.windowId), []);
    });

    it('only an unrelated group in the destination is over: no tab is moved (R3)', async () => {
        const { setup } = await moveThenStop('s1', { local: (s) => ({ [`groupLimit_${s.B.windowId}_ungrouped`]: 1 }) });
        const op = await getOp(setup.B.windowId);
        assert.deepEqual(op.constraints.map((c) => c.id), ['group:-1']);
        assert.deepEqual(await movedIn(setup.B.windowId), []);
    });

    it('the source window closed during the move: the move is still found', async () => {
        const { setup, steps } = await moveThenStop('s3', { local: { defaultTabLimit: 3 } });
        assert.ok(steps.some((e) => e.ev === 'windows.onRemoved'));
        assert.deepEqual(await movedIn(setup.B.windowId), [...setup.groupTabIds].sort());
    });

    it('the destination was settled before the attach was handled (Codex): the settle did not hide the move', async () => {
        const { setup, steps } = await setupFromTrace('s1', { local: { defaultTabLimit: 3 } });
        const B = setup.B.windowId;
        // A tab created in B is decided first, settling B with the group's tabs already there
        const created = harness.addTabSilently({ windowId: B, url: 'https://new.example/' });
        harness.fire('tabsOnCreated', { id: created, windowId: B, groupId: -1 });
        const nextTask = harness.pause(harness.chrome.tabs, 'get', { when: (id) => setup.groupTabIds.includes(id) });
        deliverUnhandled(steps);
        await nextTask.reached; // the creation was decided and saved; the move's tasks never run
        assert.equal((await savedState()).lastWindow[setup.groupTabIds[0]], setup.A.windowId, 'seeded, not overwritten');

        await workerRestart();
        assert.deepEqual(await movedIn(B), [...setup.groupTabIds].sort());
    });

    describe("a window's only group moves (s3's order)", () => {
        async function detachesHandled({ closeSourceFirst }) {
            const { setup, steps } = await setupFromTrace('s3', { local: { defaultTabLimit: 3 } });
            const firstAttach = steps.findIndex((e) => e.ev === 'tabs.onAttached');
            let early = steps.slice(0, firstAttach);
            let late = steps.slice(firstAttach);
            if (closeSourceFirst) {
                const removal = late.find((e) => e.ev === 'windows.onRemoved');
                early = [...early, removal];
                late = late.filter((e) => e !== removal);
            }
            await replay(harness, early, { flushBetween: 5 });
            assert.equal((await savedState()).windows[setup.A.windowId], undefined, "the source's record is gone");
            deliverUnhandled(late);
            await workerRestart();
            return setup;
        }

        it('the detaches were handled and saved, the attaches were not: the tabs come back moved', async () => {
            const setup = await detachesHandled({ closeSourceFirst: false });
            assert.deepEqual(await movedIn(setup.B.windowId), [...setup.groupTabIds].sort());
        });

        it("also when the source window's removal was handled too", async () => {
            const setup = await detachesHandled({ closeSourceFirst: true });
            assert.deepEqual(await movedIn(setup.B.windowId), [...setup.groupTabIds].sort());
        });
    });

    for (const unrelatedGroupClosed of [false, true]) {
        it(`a finished single-tab move keeps its verdict after a restart, whatever happened since (Codex)${unrelatedGroupClosed ? ', with a group closed in a third window' : ''}`, async () => {
            // Windows 1 (3 tabs) and 2 (1 tab), limit 3; window 3 holds a group of 2 and one more tab
            await setup({
                tabs: [
                    { id: 1, windowId: 1, url: 'https://a.example/' },
                    { id: 2, windowId: 1, url: 'https://b.example/' },
                    { id: 3, windowId: 1, url: 'https://c.example/' },
                    { id: 10, windowId: 2, url: 'https://other.example/' },
                    { id: 20, windowId: 3, groupId: 9, url: 'https://g1.example/' },
                    { id: 21, windowId: 3, groupId: 9, url: 'https://g2.example/' },
                    { id: 22, windowId: 3, url: 'https://h.example/' }
                ]
            });
            harness.groups.push({ id: 9, windowId: 3, title: 'Other', color: 'red' });
            if (unrelatedGroupClosed) {
                await harness.chrome.tabs.remove([20, 21]);
                harness.applyEvent({ ev: 'tabGroups.onRemoved', groupId: 9, windowId: 3 });
                await flush();
                assert.ok('9' in (await savedState()).openMoves, 'its removal looks like the start of a move, for now');
            }

            harness.moveTab(1, 2); // 2 of 3: fits
            await flush();
            assert.equal(await statusIn(2, 1), 'ordinary');
            await open(2); // 3 of 3
            const late = await open(2); // 4 of 3: the window is over now
            assert.equal(await statusIn(2, late), 'pending');
            assert.deepEqual((await savedState()).arrivals, {}, 'the tab came from a window no group move left: nothing to judge again');

            await workerRestart();
            assert.equal(await statusIn(2, 1), 'ordinary', 'still ordinary: the new tab, not the move, put the window over');
            assert.equal(await statusIn(2, late), 'pending');
        });
    }

    // A lone ungrouped tab leaves the source while the group's move from it is open, and
    // fits where it lands (3 of 4); the group then arrives (6 of 4). Not seen in live
    // Chrome; replayed from s1 with the lone tab's detach and attach inserted (Codex).
    for (const restart of [false, true]) {
        it(`a lone tab that moved during a group's move from the same window keeps its own verdict${restart ? ', also after a restart' : ''} (Codex)`, async () => {
            const { setup, steps } = await setupFromTrace('s1', { local: (s) => ({ [`tabLimit_${s.B.windowId}`]: 4 }) });
            const [lone] = setup.A.tabIds.filter((id) => !setup.groupTabIds.includes(id));
            const started = steps.findIndex((e) => e.ev === 'tabGroups.onRemoved') + 1;
            const overlapping = [
                ...steps.slice(0, started),
                { ev: 'tabs.onDetached', tabId: lone, oldWindowId: setup.A.windowId },
                { ev: 'tabs.onAttached', tabId: lone, newWindowId: setup.B.windowId },
                ...steps.slice(started)
            ];
            // Not the source's last tab: keep one there, so the window stays
            harness.addTabSilently({ id: Math.max(...harness.tabIds()) + 1, windowId: setup.A.windowId });
            await replay(harness, overlapping, { flushBetween: 5 });
            if (restart) await workerRestart();

            const B = setup.B.windowId;
            assert.equal(await statusIn(B, lone), 'ordinary', 'it fit when it arrived, and never joined the group');
            assert.deepEqual(await movedIn(B), [...setup.groupTabIds].sort());
            assert.deepEqual((await savedState()).arrivals, {}, 'the move ended: nothing left to judge again');
        });
    }

    it("tabs tracked in the source get the destination's verdict at a restart, as live (Codex)", async () => {
        // The source (4 > 3) tracks the group's tabs in its startup decision. In the
        // destination only its ungrouped tabs are over (2 > 1): the group is not (R3).
        const local = (s) => ({ [`tabLimit_${s.A.windowId}`]: 3, [`groupLimit_${s.B.windowId}_ungrouped`]: 1 });
        const live = await setupFromTrace('s1', { local });
        assert.ok((await savedState()).windows[live.setup.A.windowId].startup.includes(live.setup.groupTabIds[0]));
        await replay(harness, live.steps);
        assert.deepEqual(await movedIn(live.setup.B.windowId), [], 'live');

        const { setup } = await moveThenStop('s1', { local });
        assert.deepEqual(await movedIn(setup.B.windowId), [], 'after a restart: the same');
        assert.deepEqual((await getOp(setup.B.windowId)).constraints.map((c) => c.id), ['group:-1']);
    });

    it('lastWindow follows a tab: seeded at the start, updated by a handled move, dropped when it closes', async () => {
        const { setup, steps } = await setupFromTrace('s1');
        const [tab] = setup.groupTabIds;
        assert.equal((await savedState()).lastWindow[tab], setup.A.windowId);
        await replay(harness, steps);
        assert.equal((await savedState()).lastWindow[tab], setup.B.windowId);
        assert.deepEqual((await savedState()).arrivals, {}, 'the move ended: no arrival is left');
        await harness.chrome.tabs.remove(tab);
        await flush();
        assert.equal(tab in (await savedState()).lastWindow, false);
    });
});

// The product rule for a new tab and a group move into the same window (Codex, stage 5
// review). With room before the move (B holds 2 of 4), a tab opened before the move fits
// and stays ordinary: the move puts the window over, and the group's tabs are flagged
// moved. A tab opened after the move finds the window over and is held pending. The
// outcome is the same however the events are delivered: as a burst, one at a time, or
// with a worker restart before any step.
describe('a new tab and a group move into the same window: the order decides, timing does not', () => {
    const local = (s) => ({ [`tabLimit_${s.B.windowId}`]: 4 });
    async function run(order, delivery, cut) {
        const trace = await setupFromTrace('s1', { local });
        const { setup } = trace;
        const tabId = Math.max(...harness.tabIds()) + 100;
        const opened = { ev: 'tabs.onCreated', tabId, windowId: setup.B.windowId, groupId: -1 };
        const steps = order === 'tab first' ? [opened, ...trace.steps] : [...trace.steps, opened];
        const flushBetween = delivery === 'stepped' ? 5 : 0;
        if (cut === undefined) {
            await replay(harness, steps, { flushBetween });
        } else {
            await replay(harness, steps.slice(0, cut), { flushBetween });
            await workerRestart();
            await replay(harness, steps.slice(cut), { flushBetween });
        }
        return { setup, tabId, length: steps.length };
    }

    for (const [order, expected] of [['tab first', 'ordinary'], ['move first', 'pending']]) {
        for (const delivery of ['burst', 'stepped']) {
            it(`${order}, ${delivery}: the new tab is ${expected}, the group's tabs are moved`, async () => {
                const { setup, tabId, length } = await run(order, delivery);
                const B = setup.B.windowId;
                assert.equal(await statusIn(B, tabId), expected);
                assert.deepEqual(await movedIn(B), [...setup.groupTabIds].sort());
                assert.ok(harness.tabIds(B).includes(tabId), 'never closed');

                for (let cut = 0; cut <= length; cut++) {
                    const again = await run(order, delivery, cut);
                    assert.equal(await statusIn(B, again.tabId), expected, `restart before step ${cut}`);
                    assert.deepEqual(await movedIn(B), [...setup.groupTabIds].sort(), `restart before step ${cut}`);
                }
            });
        }
    }

    it('a decision already active when the tab opens still applies its cap, whatever arrives after', async () => {
        // B is over before the move (2 > 1), its one pending tab fills the cap
        const trace = await setupFromTrace('s1', { local: (s) => ({ [`tabLimit_${s.B.windowId}`]: 1, maxPendingPerWindow: 1 }) });
        const B = trace.setup.B.windowId;
        await open(B);
        assert.ok(await getOp(B));
        const tabId = Math.max(...harness.tabIds()) + 100;
        await replay(harness, [{ ev: 'tabs.onCreated', tabId, windowId: B, groupId: -1 }, ...trace.steps]);

        assert.equal(harness.tabIds(B).includes(tabId), false, 'rejected at the cap, as before the move');
        assert.equal((await savedState()).windows[B].op.rejectedCount, 1);
        assert.deepEqual(await movedIn(B), [...trace.setup.groupTabIds].sort());
    });
});

// Real Chrome (stage 6 check): with its own limit following it, a group over that limit
// made Chrome's temporary drag window over, and the popup opened there in the middle of
// the user's drag and ended it. A move opens the popup only in a window holding a tab
// from before the move.
describe("a move never opens the popup in a window that holds only the moving tabs", () => {
    const dragWindowOf = (steps, setup) => steps.find((e) => e.ev === 'windows.onCreated' && e.windowId !== setup.B?.windowId)?.windowId;

    for (const flushBetween of [0, 5]) {
        it(`a two-hop drag (4a) of a group over its own limit: no popup in the drag window, one in the target (flush ${flushBetween})`, async () => {
            const { setup, steps } = await setupFromTrace('s4', { part: '4a', local: (s) => groupLimit(s.groupId, 2) });
            const drag = dragWindowOf(steps, setup);
            assert.ok(drag);
            harness.calls.popupWindows.length = 0;
            await replay(harness, steps, { flushBetween });

            assert.equal(harness.calls.popupWindows.includes(drag), false, 'not in the drag window');
            assert.ok(harness.calls.popupWindows.includes(setup.B.windowId), 'in the target, which has its own tabs');
            assert.deepEqual(await movedIn(setup.B.windowId), [...setup.groupTabIds].sort());
        });
    }

    it('a group torn off into a new window (4b): no popup there; the badge counts it', async () => {
        const { setup, steps } = await setupFromTrace('s4', { part: '4b', local: (s) => groupLimit(s.groupId, 2) });
        harness.calls.popupWindows.length = 0;
        await replay(harness, steps, { flushBetween: 5 });
        const torn = harness.tabIds().length && (await harness.chrome.tabs.get(setup.groupTabIds[0])).windowId;

        assert.notEqual(torn, setup.A.windowId);
        assert.equal(harness.calls.popupWindows.includes(torn), false);
        assert.deepEqual(await movedIn(torn), [...setup.groupTabIds].sort());
        assert.equal(harness.calls.badge, '1');
    });

    it('a tab moved later into the torn-off window opens the popup: the settled group is that window\'s own (Codex)', async () => {
        const { setup, steps } = await setupFromTrace('s4', { part: '4b', local: (s) => ({ defaultTabLimit: 3, ...groupLimit(s.groupId, 2) }) });
        const [lone] = setup.A.tabIds.filter((id) => !setup.groupTabIds.includes(id));
        harness.addTabSilently({ id: Math.max(...harness.tabIds()) + 1, windowId: setup.A.windowId }); // the source keeps a tab
        await replay(harness, steps, { flushBetween: 5 });
        const torn = (await harness.chrome.tabs.get(setup.groupTabIds[0])).windowId;
        assert.equal(harness.calls.popupWindows.includes(torn), false, 'none while the group alone arrived');

        harness.moveTab(lone, torn); // 4 tabs > 3: the window is over now
        await flush();
        assert.equal(await statusIn(torn, lone), 'moved');
        assert.ok(harness.calls.popupWindows.includes(torn), 'the group was already settled there: the popup opens');
    });

    it('control: the same group moved into a window with tabs of its own opens the popup there', async () => {
        const { setup, steps } = await setupFromTrace('s1', { local: (s) => groupLimit(s.groupId, 2) });
        harness.calls.popupWindows.length = 0;
        await replay(harness, steps, { flushBetween: 5 });
        assert.ok(harness.calls.popupWindows.includes(setup.B.windowId));
    });
});
