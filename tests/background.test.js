import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { createChromeMock, flush, EXTENSION_ID, EXTENSION_ORIGIN } from './helpers/chrome-mock.js';

// background.js is an ES module with top-level side effects (it registers
// listeners and reconciles on load). Each import with a unique query string
// gives a fresh module instance, simulating a fresh service worker.
let instance = 0;
async function startServiceWorker(harness) {
    globalThis.chrome = harness.chrome;
    await import(new URL(`../chrome-tab-limiter/background.js?sw=${++instance}`, import.meta.url));
    await flush();
}

const POPUP = { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}popup.html` };
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
const browserRestart = async () => {
    await harness.restartBrowser();
    await startServiceWorker(harness);
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
        await harness.chrome.storage.local.set({ defaultTabLimit: 10, groupLimit_1_7: 1 });
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
        await harness.chrome.storage.local.set({ groupLimit_1_7: 1 });
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

    it('cleans up stored limits and state when a window closes', async () => {
        await harness.chrome.storage.local.set({ tabLimit_1: 4, groupLimit_1_7: 2, tabLimit_2: 6 });
        await open();
        await harness.chrome.tabs.remove(harness.tabIds(1)); // closing its last tab closes the window
        await flush();

        assert.deepEqual(harness.chrome.storage.local._dump(), { defaultTabLimit: 3, tabLimit_2: 6 });
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
            local: { groupLimit_1_7: 2 },
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

        await browserRestart();

        assert.deepEqual(harness.tabIds(1).sort(), tabsBefore, 'no tab closed');
        const state = await getState();
        assert.equal(state.startupMode, true, 'startup mode is on again after a reload');
        assert.equal(state.operation.tabs.every((t) => t.status === 'startup'), true);
    });

    it('decides a creation event that arrives around initialization after initializing', async () => {
        harness = createChromeMock({ tabs: overLimitSession() });
        await harness.chrome.storage.local.set({ defaultTabLimit: 3 });
        globalThis.chrome = harness.chrome;
        const importing = import(new URL(`../chrome-tab-limiter/background.js?sw=${++instance}`, import.meta.url));
        await importing;
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
            local: { tabLimit_1: 3, groupLimit_1_7: 1 },
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
        await setup({ limit: 10, local: { groupLimit_1_7: 2 } });
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

describe('browser changes while a task is running (REGRESSIONS.md)', () => {
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

describe('follow-up review findings (REGRESSIONS.md, Codex verification)', () => {
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

describe('second review findings (REGRESSIONS.md, Codex verification of round 2)', () => {
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
