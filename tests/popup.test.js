import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { createChromeMock, flush } from './helpers/chrome-mock.js';

// popup.js is an ES module that wires itself to the DOM on DOMContentLoaded.
// These tests give it a tiny fake DOM, capture that handler, and run it.

function createElement(id) {
    const listeners = {};
    const node = {
        id,
        tag: '',
        value: '',
        textContent: '',
        className: '',
        innerHTML: '',
        disabled: false,
        hidden: false,
        checked: false,
        style: {},
        dataset: {},
        attributes: {},
        children: [],
        setAttribute(name, value) {
            node.attributes[name] = value;
        },
        appendChild(child) {
            node.children.push(child);
            return child;
        },
        replaceChildren(...nodes) {
            node.children = nodes;
        },
        addEventListener: (type, fn) => {
            (listeners[type] ||= []).push(fn);
        },
        _fire: (type, event = {}) => Promise.all((listeners[type] || []).map((fn) => fn(event)))
    };
    return node;
}

// All descendants of a node that satisfy a predicate
function findAll(node, predicate, found = []) {
    for (const child of node.children) {
        if (predicate(child)) found.push(child);
        findAll(child, predicate, found);
    }
    return found;
}

let instance = 0;

async function openPopup(chrome, { windowId = 1, groupRows = [], onMessage } = {}) {
    const elements = new Map();
    const getElement = (id) => {
        if (!elements.has(id)) elements.set(id, createElement(id));
        return elements.get(id);
    };
    const documentListeners = {};
    // Group rows are rendered through innerHTML in Chrome; the test supplies them as {input, button}
    const groupInputs = groupRows.map((row) => row.input);
    const groupButtons = groupRows.map((row) => row.button);

    globalThis.document = {
        addEventListener: (type, fn) => {
            (documentListeners[type] ||= []).push(fn);
        },
        getElementById: (id) => groupInputs.find((input) => input.id === id) || getElement(id),
        createElement: (tag) => Object.assign(createElement(), { tag }),
        querySelector: (selector) =>
            selector.endsWith('.group-save-btn')
                ? groupButtons.find((button) => selector.includes(`"${button.dataset.groupId}"`)) || null
                : null,
        querySelectorAll: (selector) =>
            selector === '.group-limit-input' ? groupInputs : selector === '.group-save-btn' ? groupButtons : [],
        body: {}
    };
    const sent = [];
    const pushListeners = [];
    let closed = 0;
    globalThis.window = {
        close() {
            closed++;
        }
    };
    chrome.windows = { ...chrome.windows, getCurrent: async () => ({ id: windowId }) };
    chrome.runtime.sendMessage = async (request) => {
        sent.push(request);
        return onMessage ? onMessage(request) : { success: false };
    };
    chrome.runtime.connect = () => ({ onMessage: { addListener: (fn) => pushListeners.push(fn) } });
    globalThis.chrome = chrome;

    await import(new URL(`../extension/popup.js?popup=${++instance}`, import.meta.url));
    for (const fn of documentListeners.DOMContentLoaded) await fn();
    await flush();

    return {
        getElement,
        documentListeners,
        sent,
        closeCalls: () => closed,
        push: (message) => pushListeners.forEach((fn) => fn(message))
    };
}

let harness;
let consoleError;

beforeEach(() => {
    // The popup schedules timers (hide messages, welcome notice); they must not outlive a test
    mock.timers.enable({ apis: ['setTimeout'] });
    consoleError = mock.method(console, 'error', () => {});
    harness = createChromeMock({
        tabs: [
            { id: 1, windowId: 1 },
            { id: 2, windowId: 1 }
        ]
    });
});

afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.chrome;
});

describe('popup error handling (B-06)', () => {
    it('shows an error instead of throwing when tabs.query fails', async () => {
        harness.chrome.tabs.query = async () => {
            throw new Error('query failed');
        };

        const { getElement } = await openPopup(harness.chrome);

        assert.equal(getElement('currentTabCount').textContent, 'Error');
        assert.equal(getElement('currentLimit').textContent, 10, 'initialization continued past the failure');
        const messages = consoleError.mock.calls.map((c) => String(c.arguments[0]));
        assert.ok(messages.includes('Error updating tab count'));
        assert.equal(
            messages.some((m) => /not defined/i.test(m)),
            false,
            'no ReferenceError may escape the error handler'
        );
    });

    it('reports a failed save instead of throwing', async () => {
        const { getElement } = await openPopup(harness.chrome);
        harness.chrome.storage.local.set = async () => {
            throw new Error('quota');
        };

        getElement('tabLimitInput').value = '7';
        await getElement('saveButton')._fire('click');

        assert.equal(getElement('statusMessage').textContent, 'Error saving tab limit');
        assert.equal(getElement('saveButton').disabled, false, 'button is re-enabled');
    });
});

describe('popup limit input (B-09)', () => {
    it('does not rewrite 1.5, -5 or 1e1.5 into other numbers', async () => {
        const { getElement } = await openPopup(harness.chrome);
        const before = harness.chrome.storage.local._dump();

        for (const text of ['1.5', '-5', '1e1.5']) {
            getElement('tabLimitInput').value = text;
            await getElement('saveButton')._fire('click');
            assert.equal(getElement('statusMessage').className, 'status-message error', text);
        }

        assert.deepEqual(harness.chrome.storage.local._dump(), before, 'nothing may be stored');
    });

    it('saves a plain integer', async () => {
        const { getElement } = await openPopup(harness.chrome);

        getElement('tabLimitInput').value = '12';
        await getElement('saveButton')._fire('click');

        assert.equal(harness.chrome.storage.local._dump().tabLimit_1, 12);
    });
});

describe('group limits (B-09)', () => {
    // The popup saves a group's limit through the background (setGroupLimit), which
    // answers with `reply`
    async function openWithGroup(reply = { success: true }) {
        harness.chrome.tabGroups.query = async () => [{ id: 7, title: 'Work', color: 'blue' }];
        const input = createElement('group-7');
        input.dataset.groupId = '7';
        const button = createElement('save-7');
        button.dataset.groupId = '7';
        const popup = await openPopup(harness.chrome, {
            groupRows: [{ input, button }],
            onMessage: (request) => (request.action === 'setGroupLimit' ? reply : { success: false })
        });
        return { input, button, popup };
    }

    const saves = (popup) => popup.sent.filter((r) => r.action === 'setGroupLimit');
    const pressEnter = (input) => input._fire('keydown', { key: 'Enter' });

    it('saves 75 by button and by Enter key, through the background', async () => {
        const { input, button, popup } = await openWithGroup();

        input.value = '75';
        await input._fire('input');
        assert.equal(button.disabled, false, 'live validation accepts 75');
        await pressEnter(input);
        await button._fire('click');

        assert.deepEqual(saves(popup), [
            { action: 'setGroupLimit', windowId: 1, groupId: 7, limit: 75 },
            { action: 'setGroupLimit', windowId: 1, groupId: 7, limit: 75 }
        ]);
        assert.deepEqual(harness.chrome.storage.local._dump(), {}, 'the popup itself writes nothing');
        assert.equal(popup.getElement('statusMessage').textContent, 'Group limit saved');
    });

    it('rejects values over 100, decimals and negatives, including by Enter key', async () => {
        const { input, button, popup } = await openWithGroup();

        for (const text of ['101', '1.5', '-5', '1e3']) {
            input.value = text;
            await input._fire('input');
            assert.equal(button.disabled, true, `Save stays disabled for ${text}`);
            await pressEnter(input);
            assert.deepEqual(saves(popup), [], `${text} must not be sent`);
        }
    });

    it('shows a failed save and keeps the typed value', async () => {
        const { input, popup } = await openWithGroup({ success: false, error: 'The limit could not be saved; please try again' });

        input.value = '12';
        await pressEnter(input);

        assert.equal(popup.getElement('statusMessage').textContent, 'The limit could not be saved; please try again');
        assert.match(popup.getElement('statusMessage').className, /error/);
        assert.equal(input.value, '12');
    });

    it('uses the same 1-100 bound in the markup', async () => {
        const { readFileSync } = await import('node:fs');
        const source = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
        assert.match(source, /min="1" max="100" data-group-id/);
        assert.doesNotMatch(source, /max="50"/);
    });
});


// ------------------------------------------------------------- decision view

describe('decision view (plan §6)', () => {
    const tab = (id, title, extra = {}) => ({ id, title, groupId: -1, status: 'ordinary', reduces: ['window'], ...extra });

    const operation = (overrides = {}) => ({
        opId: 'op-1',
        revision: 4,
        kind: 'normal',
        phase: 'open',
        rejectedCount: 0,
        constraints: [{ id: 'window', scope: 'window', count: 4, limit: 3, capacity: 3, excess: 1 }],
        tabs: [tab(1, 'Alpha'), tab(2, 'Beta'), tab(3, 'Gamma'), tab(4, '<b>New</b> tab', { status: 'pending' })],
        canKeep: false,
        pendingCount: 1,
        canClosePending: true,
        ...overrides
    });

    // A fake background: answers getState with `current` and records commands
    function background(current, commandResponse = { success: true }) {
        const calls = [];
        const handler = (request) => {
            calls.push(request);
            if (request.action === 'getState') return { success: true, startupOperations: 0, ...current() };
            return typeof commandResponse === 'function' ? commandResponse(request) : commandResponse;
        };
        return { handler, calls };
    }

    const checkboxes = (getElement) => findAll(getElement('tabChoiceList'), (n) => n.attributes.type === 'checkbox');
    const tick = () => flush(5);

    it('shows the operation instead of the settings, with live titles as plain text', async () => {
        const { handler } = background(() => ({ startupMode: false, operation: operation() }));
        const { getElement } = await openPopup(harness.chrome, { onMessage: handler });

        assert.equal(getElement('decisionView').hidden, false);
        assert.equal(getElement('settingsView').hidden, true);
        assert.equal(getElement('constraintList').children[0].textContent, 'Window: 1 over (limit 3)');
        const titles = findAll(getElement('tabChoiceList'), (n) => n.className === 'tab-choice-title').map((n) => n.textContent);
        assert.deepEqual(titles, ['Alpha', 'Beta', 'Gamma', '<b>New</b> tab'], 'titles are text, never markup');
        assert.equal(getElement('tabChoiceList').innerHTML, '', 'no innerHTML for page titles');
    });

    it('shows the normal settings view when there is no operation', async () => {
        const { handler } = background(() => ({ startupMode: false, operation: null }));
        const { getElement } = await openPopup(harness.chrome, { onMessage: handler });

        assert.equal(getElement('decisionView').hidden, true);
        assert.equal(getElement('settingsView').hidden, false);
    });

    it('enables "Close selected tabs" only when the selection resolves every constraint', async () => {
        const { handler } = background(() => ({ startupMode: false, operation: operation() }));
        const { getElement } = await openPopup(harness.chrome, { onMessage: handler });
        const [first, second] = checkboxes(getElement);

        assert.equal(getElement('closeSelectedButton').disabled, true, 'nothing selected');
        first.checked = true;
        await first._fire('change');
        assert.equal(getElement('closeSelectedButton').disabled, false, 'one tab resolves 1 over');
        first.checked = false;
        await first._fire('change');
        assert.equal(getElement('closeSelectedButton').disabled, true);
        assert.ok(second);
    });

    it('sends the chosen tabs with the operation ID and revision', async () => {
        const { handler, calls } = background(() => ({ startupMode: false, operation: operation() }));
        const { getElement } = await openPopup(harness.chrome, { onMessage: handler });
        const [first] = checkboxes(getElement);
        first.checked = true;
        await first._fire('change');

        await getElement('closeSelectedButton')._fire('click');

        const command = calls.find((c) => c.action === 'closeSelected');
        assert.deepEqual(command, { action: 'closeSelected', tabIds: [1], windowId: 1, opId: 'op-1', revision: 4 });
    });

    it('B-07: a rejected command keeps the popup open, shows the reason and refreshes', async () => {
        const { handler, calls } = background(
            () => ({ startupMode: false, operation: operation() }),
            { success: false, error: 'The tabs changed; please review again' }
        );
        const { getElement, closeCalls } = await openPopup(harness.chrome, { onMessage: handler });
        const [first] = checkboxes(getElement);
        first.checked = true;
        await first._fire('change');
        const before = calls.filter((c) => c.action === 'getState').length;

        await getElement('closeSelectedButton')._fire('click');

        assert.equal(getElement('statusMessage').textContent, 'The tabs changed; please review again');
        assert.equal(getElement('statusMessage').className, 'status-message error');
        assert.equal(closeCalls(), 0, 'the popup stays open');
        assert.equal(getElement('decisionView').hidden, false, 'the operation is still shown');
        assert.ok(calls.filter((c) => c.action === 'getState').length > before, 'the view was refreshed');
        assert.equal(calls.some((c) => c.action === 'clearSelectorState'), false, 'the old discard message is gone');
    });

    it('closes the popup after a decision that resolves the operation', async () => {
        let current = { startupMode: false, operation: operation() };
        const { handler } = background(() => current, () => {
            current = { startupMode: false, operation: null };
            return { success: true };
        });
        const { getElement, closeCalls } = await openPopup(harness.chrome, { onMessage: handler });
        const [first] = checkboxes(getElement);
        first.checked = true;
        await first._fire('change');

        await getElement('closeSelectedButton')._fire('click');

        assert.equal(closeCalls(), 1);
    });

    it('offers "Keep these" only for a startup operation', async () => {
        let current = { startupMode: false, operation: operation() };
        const { handler } = background(() => current);
        const normal = await openPopup(harness.chrome, { onMessage: handler });
        assert.equal(normal.getElement('keepTheseButton').hidden, true);

        current = { startupMode: true, operation: operation({ kind: 'startup', canKeep: true }) };
        const startup = await openPopup(harness.chrome, { onMessage: handler });
        assert.equal(startup.getElement('keepTheseButton').hidden, false);
        assert.equal(startup.getElement('decisionTitle').textContent, 'Tabs left over from the last browser start');
    });

    it('hides "Close the new tabs" and explains why when it would close the window (R4)', async () => {
        const { handler } = background(() => ({
            startupMode: false,
            operation: operation({ canClosePending: false, pendingCount: 2 })
        }));
        const { getElement } = await openPopup(harness.chrome, { onMessage: handler });

        assert.equal(getElement('closePendingButton').hidden, true);
        assert.equal(getElement('closePendingNote').hidden, false);
    });

    it('announces rejected tabs', async () => {
        const { handler } = background(() => ({ startupMode: false, operation: operation({ rejectedCount: 2 }) }));
        const { getElement } = await openPopup(harness.chrome, { onMessage: handler });

        assert.equal(getElement('rejectedNotice').hidden, false);
        assert.match(getElement('rejectedNotice').textContent, /2 new tabs were closed/);
    });

    describe('"Start enforcing now" (D4)', () => {
        it('shows in the settings view and the operation view while startup mode is on', async () => {
            for (const op of [null, operation({ kind: 'startup', canKeep: true })]) {
                const { handler } = background(() => ({ startupMode: true, operation: op }));
                const { getElement } = await openPopup(harness.chrome, { onMessage: handler });
                assert.equal(getElement('startEnforcingSection').hidden, false, op ? 'operation view' : 'settings view');
            }
        });

        it('is hidden once startup mode is off', async () => {
            const { handler } = background(() => ({ startupMode: false, operation: null }));
            const { getElement } = await openPopup(harness.chrome, { onMessage: handler });
            assert.equal(getElement('startEnforcingSection').hidden, true);
        });

        it('warns that a window still over its limit stays open, only when one exists', async () => {
            for (const [startupOperations, hidden] of [[0, true], [1, false]]) {
                const answer = (request) =>
                    request.action === 'getState'
                        ? { success: true, startupMode: true, startupOperations, operation: null }
                        : { success: true };
                const { getElement } = await openPopup(harness.chrome, { onMessage: answer });
                assert.equal(getElement('startEnforcingNote').hidden, hidden, `startupOperations ${startupOperations}`);
            }
        });

        it('sends a global command without a window, operation or revision, then hides the button', async () => {
            let startupMode = true;
            const { handler, calls } = background(() => ({ startupMode, operation: null }), () => {
                startupMode = false;
                return { success: true };
            });
            const { getElement } = await openPopup(harness.chrome, { onMessage: handler });

            await getElement('startEnforcingButton')._fire('click');

            assert.deepEqual(calls.find((c) => c.action === 'startEnforcing'), { action: 'startEnforcing' });
            assert.equal(getElement('startEnforcingSection').hidden, true);
        });

        it('refreshes when the background says startup mode ended, and when the revision changes', async () => {
            let current = { startupMode: true, operation: operation({ kind: 'startup', canKeep: true }) };
            const { handler, calls } = background(() => current);
            const { getElement, push } = await openPopup(harness.chrome, { onMessage: handler });
            const [first] = checkboxes(getElement);
            first.checked = true;
            await first._fire('change');
            assert.equal(getElement('closeSelectedButton').disabled, false);

            // Another window decided: startup mode ended everywhere
            current = { startupMode: false, operation: operation({ kind: 'startup', canKeep: true }) };
            push({ type: 'state', startupMode: false, revisions: { 1: 4 } });
            await tick();
            assert.equal(getElement('startEnforcingSection').hidden, true);

            // A tab changed: new revision clears the selection
            const [again] = checkboxes(getElement);
            again.checked = true;
            await again._fire('change');
            current = { startupMode: false, operation: operation({ revision: 5 }) };
            const before = calls.filter((c) => c.action === 'getState').length;
            push({ type: 'state', startupMode: false, revisions: { 1: 5 } });
            await tick();
            assert.ok(calls.filter((c) => c.action === 'getState').length > before);
            assert.equal(getElement('closeSelectedButton').disabled, true, 'selection cleared');
        });
    });
});


// ---------------------------------------------------------------- group rows (S-6)

describe('group rows never put stored values into markup', () => {
    async function renderWithStoredLimits(stored) {
        harness.chrome.tabGroups.query = async () => [{ id: 7, title: 'Work <b>"x"</b>', color: 'blue' }];
        harness.chrome.tabs.query = async () => [{ id: 1, windowId: 1, groupId: 7 }];
        await harness.chrome.storage.local.set(stored);
        const { getElement } = await openPopup(harness.chrome);
        return getElement('groupsList').innerHTML;
    }

    it('shows a normal stored limit as a number', async () => {
        const html = await renderWithStoredLimits({ groupOverride_0_7: 12 });
        assert.match(html, /value="12"/);
    });

    it('shows a group limit stored under the current session tag only', async () => {
        const render = async (stored) => {
            await harness.chrome.storage.local.clear();
            return renderWithStoredLimits({ defaultTabLimit: 9, ...stored });
        };
        assert.match(await render({ groupLimitSession: 'b2', groupOverride_b2_7: 6 }), /value="6"/);
        // An entry from an earlier session, or in the old window-keyed format, never applies
        assert.match(await render({ groupLimitSession: 'b2', groupOverride_0_7: 6 }), /value="9"/);
        assert.match(await render({ groupLimit_1_7: 6 }), /value="9"/);
    });

    it('shows the limit again when a stored limit changes while it is open', async () => {
        const html = await renderWithStoredLimits({ groupOverride_0_7: 12 });
        assert.match(html, /value="12"/);
        await harness.chrome.storage.local.set({ groupOverride_0_7: 4 });
        await flush();
        assert.match(globalThis.document.getElementById('groupsList').innerHTML, /value="4"/);
    });

    it('while a group limit is typed, a change waits until the focus leaves the group rows (Codex)', async () => {
        await renderWithStoredLimits({ groupOverride_0_7: 12 });
        const list = () => globalThis.document.getElementById('groupsList');
        const input = { classList: { contains: (name) => name === 'group-limit-input' } };
        const saveButton = { classList: { contains: (name) => name === 'group-save-btn' } };
        globalThis.document.activeElement = input;

        await harness.chrome.storage.local.set({ groupLimitSession: 'b2' }); // a new session: no limit applies
        await flush();
        assert.match(list().innerHTML, /value="12"/, 'not re-rendered under the typing');

        await list()._fire('focusout', { relatedTarget: saveButton });
        await flush();
        assert.match(list().innerHTML, /value="12"/, 'not while the Save button is being clicked');

        globalThis.document.activeElement = null;
        await list()._fire('focusout', { relatedTarget: null });
        await flush();
        assert.match(list().innerHTML, /value="10"/, 'shown once the focus has left');
    });

    it('a deferred refresh also waits while the focus is on a Save button (Codex)', async () => {
        await renderWithStoredLimits({ groupOverride_0_7: 12 });
        const list = () => globalThis.document.getElementById('groupsList');
        const input = { classList: { contains: (name) => name === 'group-limit-input' } };
        const saveButton = { classList: { contains: (name) => name === 'group-save-btn' } };
        globalThis.document.activeElement = input;
        await harness.chrome.storage.local.set({ groupLimitSession: 'b2' });
        await flush();

        // The focus moves to Save, and then another change arrives
        globalThis.document.activeElement = saveButton;
        await list()._fire('focusout', { relatedTarget: saveButton });
        await harness.chrome.storage.local.set({ defaultTabLimit: 8 });
        await flush();
        assert.match(list().innerHTML, /value="12"/, 'the row under the click is not redrawn');

        globalThis.document.activeElement = null;
        await list()._fire('focusout', { relatedTarget: null });
        await flush();
        assert.match(list().innerHTML, /value="8"/);
    });

    it('shows the default as soon as the background says the gate turned on (Codex)', async () => {
        const { getElement, push } = await openPopup(harness.chrome);
        harness.chrome.tabGroups.query = async () => [{ id: 7, title: 'Work', color: 'blue' }];
        harness.chrome.tabs.query = async () => [{ id: 1, windowId: 1, groupId: 7 }];
        await harness.chrome.storage.local.set({ defaultTabLimit: 9, groupOverride_0_7: 12 });
        await flush();
        assert.match(getElement('groupsList').innerHTML, /value="12"/);

        push({ type: 'groupLimits', paused: true });
        await flush();
        assert.match(getElement('groupsList').innerHTML, /value="9"/);
    });

    it('shows the default while the background has custom group limits paused, and the limit once they apply (Codex)', async () => {
        harness.chrome.tabGroups.query = async () => [{ id: 7, title: 'Work', color: 'blue' }];
        harness.chrome.tabs.query = async () => [{ id: 1, windowId: 1, groupId: 7 }];
        await harness.chrome.storage.local.set({ defaultTabLimit: 9, groupOverride_0_7: 12 });
        const { getElement, push } = await openPopup(harness.chrome, {
            onMessage: (request) =>
                request.action === 'getState'
                    ? { success: true, startupMode: true, groupLimitsPaused: true, startupOperations: 0, operation: null }
                    : { success: false }
        });
        assert.match(getElement('groupsList').innerHTML, /value="9"/, 'paused: the default applies');

        push({ type: 'state', startupMode: true, groupLimitsPaused: false, revisions: {} });
        await flush();
        assert.match(getElement('groupsList').innerHTML, /value="12"/);
    });

    it('ignores a hostile stored limit and falls back to the default', async () => {
        const hostile = '"><img src=x onerror=alert(1)>';
        for (const value of [hostile, 1.5, -3, 0, 101, null, { a: 1 }, [5]]) {
            const html = await renderWithStoredLimits({ defaultTabLimit: 9, groupOverride_0_7: value });
            assert.equal(/<img|onerror/i.test(html), false, JSON.stringify(value));
            assert.match(html, /value="9"/, JSON.stringify(value));
        }
    });

    it('escapes the group title', async () => {
        const html = await renderWithStoredLimits({ groupOverride_0_7: 4 });
        assert.equal(html.includes('<b>'), false);
        assert.ok(html.includes('&lt;b&gt;'));
    });
});
