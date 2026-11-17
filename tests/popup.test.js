import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { createChromeMock, flush } from './helpers/chrome-mock.js';

// popup.js is an ES module that wires itself to the DOM on DOMContentLoaded.
// These tests give it a tiny fake DOM, capture that handler, and run it.

function createElement(id) {
    const listeners = {};
    return {
        id,
        value: '',
        textContent: '',
        className: '',
        innerHTML: '',
        disabled: false,
        style: {},
        dataset: {},
        addEventListener: (type, fn) => {
            (listeners[type] ||= []).push(fn);
        },
        _fire: (type, event = {}) => Promise.all((listeners[type] || []).map((fn) => fn(event)))
    };
}

let instance = 0;

async function openPopup(chrome, { windowId = 1, groupRows = [] } = {}) {
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
        querySelector: (selector) =>
            selector.endsWith('.group-save-btn')
                ? groupButtons.find((button) => selector.includes(`"${button.dataset.groupId}"`)) || null
                : null,
        querySelectorAll: (selector) =>
            selector === '.group-limit-input' ? groupInputs : selector === '.group-save-btn' ? groupButtons : [],
        body: {}
    };
    globalThis.window = { close() {} };
    chrome.windows = { ...chrome.windows, getCurrent: async () => ({ id: windowId }) };
    chrome.runtime.sendMessage = async () => ({ success: false });
    globalThis.chrome = chrome;

    await import(new URL(`../chrome-tab-limiter/popup.js?popup=${++instance}`, import.meta.url));
    for (const fn of documentListeners.DOMContentLoaded) await fn();
    await flush();

    return { getElement, documentListeners };
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
    async function openWithGroup() {
        harness.chrome.tabGroups.query = async () => [{ id: 7, title: 'Work', color: 'blue' }];
        const input = createElement('group-7');
        input.dataset.groupId = '7';
        const button = createElement('save-7');
        button.dataset.groupId = '7';
        await openPopup(harness.chrome, { groupRows: [{ input, button }] });
        return { input, button };
    }

    const stored = () => harness.chrome.storage.local._dump().groupLimit_1_7;
    const pressEnter = (input) => input._fire('keydown', { key: 'Enter' });

    it('saves 75 by button and by Enter key', async () => {
        const { input, button } = await openWithGroup();

        input.value = '75';
        await input._fire('input');
        assert.equal(button.disabled, false, 'live validation accepts 75');
        await pressEnter(input);

        assert.equal(stored(), 75);
    });

    it('rejects values over 100, decimals and negatives, including by Enter key', async () => {
        const { input, button } = await openWithGroup();

        for (const text of ['101', '1.5', '-5', '1e3']) {
            input.value = text;
            await input._fire('input');
            assert.equal(button.disabled, true, `Save stays disabled for ${text}`);
            await pressEnter(input);
            assert.equal(stored(), undefined, `${text} must not be stored`);
        }
    });

    it('uses the same 1-100 bound in the markup', async () => {
        const { readFileSync } = await import('node:fs');
        const source = readFileSync(new URL('../chrome-tab-limiter/popup.js', import.meta.url), 'utf8');
        assert.match(source, /min="1" max="100" data-group-id/);
        assert.doesNotMatch(source, /max="50"/);
    });
});
