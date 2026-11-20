import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    isTrustedSender,
    validateMessageRequest,
    parseLimitInput,
    VALID_ACTIONS
} from '../extension/utils/validation.js';

const SELF = { id: 'ext-id', origin: 'chrome-extension://ext-id/' };

describe('isTrustedSender', () => {
    it('accepts this extension\'s own pages', () => {
        for (const page of ['popup.html', 'options.html?x=1']) {
            assert.equal(isTrustedSender({ id: 'ext-id', url: SELF.origin + page }, SELF), true, page);
        }
    });

    it('rejects a different extension', () => {
        assert.equal(isTrustedSender({ id: 'other-id', url: 'chrome-extension://other-id/x.html' }, SELF), false);
    });

    it('rejects a web page claiming our id (e.g. a content script context)', () => {
        assert.equal(isTrustedSender({ id: 'ext-id', url: 'https://evil.example/' }, SELF), false);
    });

    it('rejects a lookalike origin prefix', () => {
        assert.equal(
            isTrustedSender({ id: 'ext-id', url: 'chrome-extension://ext-id.evil.example/' }, SELF),
            false
        );
    });

    it('rejects missing sender, missing url, or missing self', () => {
        assert.equal(isTrustedSender(undefined, SELF), false);
        assert.equal(isTrustedSender(null, SELF), false);
        assert.equal(isTrustedSender({ id: 'ext-id' }, SELF), false);
        assert.equal(isTrustedSender({ id: 'ext-id', url: SELF.origin }, undefined), false);
    });
});

describe('validateMessageRequest', () => {
    const decision = { windowId: 1, opId: 'op-1', revision: 3 };

    it('accepts every known action with its required fields', () => {
        const requests = [
            { action: 'getState', windowId: 1 },
            { action: 'closeSelected', ...decision, tabIds: [2, 3] },
            { action: 'closePending', ...decision },
            { action: 'keepThese', ...decision },
            { action: 'startEnforcing' }
        ];
        assert.deepEqual(requests.map((r) => r.action), [...VALID_ACTIONS]);
        for (const request of requests) {
            assert.deepEqual(validateMessageRequest(request), { valid: true }, request.action);
        }
    });

    it('startEnforcing is global: it needs no window, operation or revision (D4)', () => {
        assert.deepEqual(validateMessageRequest({ action: 'startEnforcing' }), { valid: true });
    });

    it('rejects non-objects, unknown actions and the removed legacy actions', () => {
        for (const request of [null, 'x', 5, {}, { action: 'closeAllTabs' }, { action: 'tabSelected', tabId: 1, windowId: 1, newTabId: 2 },
            { action: 'tabSelectedForReplacement', tabId: 1, windowId: 1 }, { action: 'getSelectorState' }, { action: 'clearSelectorState' }]) {
            assert.equal(validateMessageRequest(request).valid, false, JSON.stringify(request));
        }
    });

    it('requires the per-window fields for per-window commands', () => {
        for (const action of ['closeSelected', 'closePending', 'keepThese']) {
            for (const missing of ['windowId', 'opId', 'revision']) {
                const request = { action, ...decision, tabIds: [2] };
                delete request[missing];
                assert.equal(validateMessageRequest(request).valid, false, `${action} without ${missing}`);
            }
        }
        assert.equal(validateMessageRequest({ action: 'closeSelected', ...decision }).valid, false, 'tabIds missing');
        assert.equal(validateMessageRequest({ action: 'getState' }).valid, false);
    });

    it('rejects malformed IDs, revisions and selections', () => {
        const bad = [
            { windowId: '1' }, { windowId: 0 }, { windowId: -1 }, { windowId: 1.5 }, { windowId: 2 ** 60 },
            { opId: '' }, { opId: 5 }, { opId: 'x'.repeat(65) },
            { revision: -1 }, { revision: '3' }, { revision: 1.5 },
            { tabIds: [] }, { tabIds: ['2'] }, { tabIds: [0] }, { tabIds: [2, 2] }, { tabIds: 'all' },
            { tabIds: Array.from({ length: 1001 }, (_, i) => i + 1) }
        ];
        for (const override of bad) {
            const request = { action: 'closeSelected', ...decision, tabIds: [2], ...override };
            assert.equal(validateMessageRequest(request).valid, false, JSON.stringify(override).slice(0, 60));
        }
    });
});

describe('parseLimitInput (B-09)', () => {
    it('accepts whole numbers in range, with surrounding spaces', () => {
        for (const [input, expected] of [['1', 1], ['10', 10], [' 75 ', 75], ['100', 100], [5, 5], ['007', 7], ['1e2', 100], ['10.0', 10]]) {
            assert.equal(parseLimitInput(input), expected, String(input));
        }
    });

    it('does not rewrite malformed values into different numbers', () => {
        // The old digit-stripping code turned these into 15, 5, 12 and 1
        for (const input of ['1.5', '-5', '1e1.5', '1,5', '1 5', 'abc', '5abc', '0x10', '', '   ', '+', '.', 'Infinity', 'NaN']) {
            assert.equal(parseLimitInput(input), null, JSON.stringify(input));
        }
    });

    it('rejects values outside the range', () => {
        for (const input of ['0', '101', '1e3', '99999999999999999999']) {
            assert.equal(parseLimitInput(input), null, input);
        }
        assert.equal(parseLimitInput('75', 1, 50), null);
        assert.equal(parseLimitInput('50', 1, 50), 50);
    });

    it('rejects non-string, non-number input', () => {
        for (const input of [null, undefined, {}, [], true, NaN]) {
            assert.equal(parseLimitInput(input), null, String(input));
        }
    });
});
