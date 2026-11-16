import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { createChromeMock, flush, EXTENSION_ID, EXTENSION_ORIGIN } from './helpers/chrome-mock.js';

// background.js is an ES module with top-level side effects (it registers
// listeners and counts tabs on load). Each import with a unique query string
// gives a fresh module instance, simulating a fresh service worker.
let instance = 0;
async function startServiceWorker(harness) {
    globalThis.chrome = harness.chrome;
    await import(new URL(`../chrome-tab-limiter/background.js?sw=${++instance}`, import.meta.url));
    await flush();
}

const POPUP = { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}popup.html` };
const BLOCKED_URL = 'https://example.com/article';

let harness;

beforeEach(async () => {
    // Background logs expected rejections; keep test output clean
    mock.method(console, 'error', () => {});
    mock.method(console, 'warn', () => {});

    harness = createChromeMock({
        tabs: [
            { id: 1, windowId: 1, url: 'https://a.example/' },
            { id: 2, windowId: 1, url: 'https://b.example/' },
            { id: 3, windowId: 1, url: 'https://c.example/' },
            { id: 10, windowId: 2, url: 'https://other-window.example/' }
        ]
    });
    await harness.chrome.storage.local.set({ defaultTabLimit: 3 });
    await startServiceWorker(harness);
});

afterEach(() => {
    mock.restoreAll();
});

// Open a tab in window 1 (which is at its limit of 3) and let the background react
async function hitTheLimit(url = BLOCKED_URL) {
    const id = harness.userOpensTab({ windowId: 1, pendingUrl: url });
    await flush();
    return id;
}

const selectorState = async () =>
    (await harness.chrome.storage.session.get('selectorState')).selectorState;

describe('limit enforcement', () => {
    it('allows a new tab while under the limit', async () => {
        await harness.chrome.storage.local.set({ defaultTabLimit: 5 });
        const id = harness.userOpensTab({ windowId: 1, pendingUrl: BLOCKED_URL });
        await flush();

        assert.ok(harness.tabIds(1).includes(id));
        assert.equal(harness.calls.openPopup, 0);
    });

    it('closes a tab that would exceed the limit and opens the selector', async () => {
        const id = await hitTheLimit();

        assert.equal(harness.tabIds(1).includes(id), false, 'blocked tab should be closed');
        assert.equal(harness.calls.openPopup, 1);
        assert.deepEqual(await selectorState(), {
            isActive: true,
            windowId: 1,
            mode: 'replace',
            newTabUrl: BLOCKED_URL,
            newTabId: null
        });
    });

    it('enforces limits per window', async () => {
        const id = harness.userOpensTab({ windowId: 2, pendingUrl: BLOCKED_URL });
        await flush();
        assert.ok(harness.tabIds(2).includes(id), 'window 2 has 1 tab, so it is under the limit');
    });

    it('keeps enforcing the limit after a tab was blocked', async () => {
        await hitTheLimit();
        await harness.sendMessage({ action: 'clearSelectorState' }, POPUP);

        // Window 1 still has 3 tabs, so another new tab must also be blocked
        const second = await hitTheLimit('https://second.example/');
        assert.equal(harness.tabIds(1).includes(second), false, 'limit drifted after a blocked tab');
        assert.deepEqual(harness.tabIds(1).sort(), [1, 2, 3]);
    });

    it('keeps the window count accurate across tab groups after a blocked tab', async () => {
        // Spread the tabs over groups so only the *window* limit can catch the next tab
        const grouped = createChromeMock({
            tabs: [
                { id: 1, windowId: 1, groupId: 7 },
                { id: 2, windowId: 1, groupId: 7 },
                { id: 3, windowId: 1, groupId: -1 }
            ]
        });
        await grouped.chrome.storage.local.set({ defaultTabLimit: 3 });
        harness.resetListeners();
        harness = grouped;
        await startServiceWorker(harness);

        for (const url of ['https://first.example/', 'https://second.example/']) {
            harness.userOpensTab({ windowId: 1, groupId: -1, pendingUrl: url });
            await flush();
            await harness.sendMessage({ action: 'clearSelectorState' }, POPUP);
        }

        assert.deepEqual(harness.tabIds(1).sort(), [1, 2, 3], 'window grew past its limit');
    });

    it('grandfathers windows that were already over the limit at startup', async () => {
        await harness.chrome.storage.local.set({ defaultTabLimit: 2 });
        harness.resetListeners();
        await startServiceWorker(harness); // window 1 has 3 tabs, limit 2

        const status = await harness.sendMessage({ action: 'getGrandfatheredStatus', windowId: 1 }, POPUP);
        assert.deepEqual(status, { success: true, isGrandfathered: true, grandfatheredCount: 3 });

        // Cannot grow beyond the grandfathered count
        const id = await hitTheLimit();
        assert.equal(harness.tabIds(1).includes(id), false);
    });

    it('cleans up stored limits when a window closes', async () => {
        await harness.chrome.storage.local.set({
            tabLimit_1: 4,
            groupLimit_1_7: 2,
            tabLimit_2: 6
        });
        harness.chrome.windows.onRemoved._fire(1);
        await flush();

        assert.deepEqual(harness.chrome.storage.local._dump(), { defaultTabLimit: 3, tabLimit_2: 6 });
    });
});

describe('replacing a tab after hitting the limit', () => {
    it('closes the chosen tab and reopens the blocked URL in the same window', async () => {
        await hitTheLimit();

        const response = await harness.sendMessage({ action: 'tabSelectedForReplacement', tabId: 2, windowId: 1 }, POPUP);
        await flush();

        assert.deepEqual(response, { success: true });
        assert.equal(harness.tabIds(1).includes(2), false, 'chosen tab should be closed');
        const reopened = harness.findTab((t) => t.url === BLOCKED_URL);
        assert.ok(reopened, 'blocked URL should be reopened');
        assert.equal(reopened.windowId, 1);
        assert.equal(harness.tabIds(1).length, 3, 'window stays at its limit');
        assert.equal(await selectorState(), undefined, 'state is consumed');
    });

    it('cannot be replayed to close more tabs', async () => {
        await hitTheLimit();
        await harness.sendMessage({ action: 'tabSelectedForReplacement', tabId: 2, windowId: 1 }, POPUP);
        await flush();

        const replay = await harness.sendMessage({ action: 'tabSelectedForReplacement', tabId: 3, windowId: 1 }, POPUP);
        await flush();

        assert.equal(replay.success, false);
        assert.ok(harness.tabIds(1).includes(3), 'replay must not close another tab');
    });

    it('ignores any URL supplied in the message', async () => {
        await hitTheLimit();
        await harness.sendMessage(
            { action: 'tabSelectedForReplacement', tabId: 2, windowId: 1, newTabUrl: 'javascript:alert(1)' },
            POPUP
        );
        await flush();

        assert.equal(harness.findTab((t) => t.url.startsWith('javascript:')), undefined);
        assert.ok(harness.findTab((t) => t.url === BLOCKED_URL));
    });

    it('refuses to close a tab from a different window', async () => {
        await hitTheLimit();

        const response = await harness.sendMessage({ action: 'tabSelectedForReplacement', tabId: 10, windowId: 1 }, POPUP);
        await flush();

        assert.equal(response.success, false);
        assert.ok(harness.tabIds(2).includes(10), 'tab in window 2 must survive');
        assert.equal((await selectorState()).isActive, true, 'user can still pick a valid tab');
    });

    it('refuses when no selection is pending', async () => {
        const response = await harness.sendMessage({ action: 'tabSelectedForReplacement', tabId: 2, windowId: 1 }, POPUP);
        await flush();

        assert.equal(response.success, false);
        assert.deepEqual(harness.tabIds(1).sort(), [1, 2, 3]);
    });

    it('refuses to reopen a URL with an unsafe scheme', async () => {
        await harness.chrome.storage.session.set({
            selectorState: { isActive: true, windowId: 1, mode: 'replace', newTabUrl: 'javascript:alert(1)', newTabId: null }
        });

        const response = await harness.sendMessage({ action: 'tabSelectedForReplacement', tabId: 2, windowId: 1 }, POPUP);
        await flush();

        assert.equal(response.success, false);
        assert.deepEqual(harness.tabIds(1).sort(), [1, 2, 3], 'nothing closed or opened');
    });

    it('survives a service worker restart while the popup is open', async () => {
        await hitTheLimit();

        harness.resetListeners();
        await startServiceWorker(harness);

        const state = await harness.sendMessage({ action: 'getSelectorState' }, POPUP);
        assert.equal(state.selectorState.newTabUrl, BLOCKED_URL);

        const response = await harness.sendMessage({ action: 'tabSelectedForReplacement', tabId: 2, windowId: 1 }, POPUP);
        await flush();
        assert.deepEqual(response, { success: true });
        assert.ok(harness.findTab((t) => t.url === BLOCKED_URL));
    });

    it('clearSelectorState discards the pending selection', async () => {
        await hitTheLimit();
        assert.deepEqual(await harness.sendMessage({ action: 'clearSelectorState' }, POPUP), { success: true });
        assert.equal(await selectorState(), undefined);
    });
});

describe('message security', () => {
    it('rejects messages from web pages', async () => {
        await hitTheLimit();
        const response = await harness.sendMessage(
            { action: 'tabSelectedForReplacement', tabId: 2, windowId: 1 },
            { id: EXTENSION_ID, url: 'https://evil.example/' }
        );
        await flush();

        assert.deepEqual(response, { success: false, error: 'Untrusted sender' });
        assert.ok(harness.tabIds(1).includes(2));
    });

    it('rejects messages from other extensions', async () => {
        const response = await harness.sendMessage(
            { action: 'getSelectorState' },
            { id: 'some-other-extension', url: 'chrome-extension://some-other-extension/x.html' }
        );
        assert.equal(response.success, false);
    });

    it('rejects unknown actions and malformed IDs', async () => {
        assert.equal((await harness.sendMessage({ action: 'closeAllTabs' }, POPUP)).success, false);
        assert.equal(
            (await harness.sendMessage({ action: 'tabSelectedForReplacement', tabId: '2', windowId: 1 }, POPUP)).success,
            false
        );
    });

    it('legacy tabSelected cannot close arbitrary tabs', async () => {
        const response = await harness.sendMessage({ action: 'tabSelected', tabId: 1, windowId: 1, newTabId: 3 }, POPUP);
        await flush();

        assert.equal(response.success, false);
        assert.deepEqual(harness.tabIds(1).sort(), [1, 2, 3], 'neither tab may be closed');
    });

    it('legacy cancelSelection cannot close arbitrary tabs', async () => {
        const response = await harness.sendMessage({ action: 'cancelSelection', newTabId: 3, windowId: 1 }, POPUP);
        await flush();

        assert.equal(response.success, false);
        assert.ok(harness.tabIds(1).includes(3));
    });
});
