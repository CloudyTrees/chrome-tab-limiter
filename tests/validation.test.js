import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    isTrustedSender,
    isSafeReopenUrl,
    validateMessageRequest,
    VALID_ACTIONS
} from '../chrome-tab-limiter/utils/validation.js';

const SELF = { id: 'ext-id', origin: 'chrome-extension://ext-id/' };

describe('isTrustedSender', () => {
    it('accepts this extension\'s own pages', () => {
        for (const page of ['popup.html', 'selector.html?windowId=1', 'options.html']) {
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

describe('isSafeReopenUrl', () => {
    it('allows ordinary page and browser URLs', () => {
        for (const url of [
            'https://example.com/path?q=1',
            'http://localhost:8080/',
            'file:///Users/me/notes.html',
            'chrome://newtab/',
            'about:blank'
        ]) {
            assert.equal(isSafeReopenUrl(url), true, url);
        }
    });

    it('blocks script and data schemes', () => {
        for (const url of [
            'javascript:alert(1)',
            'JAVASCRIPT:alert(1)',
            'data:text/html,<script>alert(1)</script>',
            'blob:https://example.com/uuid',
            'chrome-extension://abc/page.html',
            'vbscript:msgbox(1)'
        ]) {
            assert.equal(isSafeReopenUrl(url), false, url);
        }
    });

    it('rejects non-URLs', () => {
        for (const value of [null, undefined, '', 'not a url', 42, {}]) {
            assert.equal(isSafeReopenUrl(value), false, String(value));
        }
    });
});

describe('validateMessageRequest', () => {
    it('accepts every known action with its required fields', () => {
        const good = {
            tabSelected: { tabId: 1, windowId: 2, newTabId: 3 },
            cancelSelection: { newTabId: 3, windowId: 2 },
            tabSelectedForReplacement: { tabId: 1, windowId: 2 },
            cancelReplacement: { windowId: 2 },
            getGrandfatheredStatus: { windowId: 2 },
            getSelectorState: {},
            clearSelectorState: {}
        };
        assert.deepEqual(Object.keys(good).sort(), [...VALID_ACTIONS].sort());
        for (const [action, fields] of Object.entries(good)) {
            assert.deepEqual(validateMessageRequest({ action, ...fields }), { valid: true }, action);
        }
    });

    it('rejects non-objects and unknown actions', () => {
        for (const request of [null, undefined, 'tabSelected', 7, { action: 'closeAllTabs' }, {}]) {
            assert.equal(validateMessageRequest(request).valid, false, JSON.stringify(request));
        }
    });

    it('rejects IDs that are not safe integers', () => {
        for (const bad of ['1', 1.5, NaN, Infinity, 2 ** 60, null]) {
            for (const field of ['tabId', 'windowId', 'newTabId']) {
                const request = { action: 'tabSelected', tabId: 1, windowId: 2, newTabId: 3, [field]: bad };
                assert.equal(validateMessageRequest(request).valid, false, `${field}=${bad}`);
            }
        }
    });

    it('rejects missing required fields', () => {
        assert.equal(validateMessageRequest({ action: 'tabSelected', tabId: 1, windowId: 2 }).valid, false);
        assert.equal(validateMessageRequest({ action: 'cancelSelection', windowId: 2 }).valid, false);
        assert.equal(validateMessageRequest({ action: 'tabSelectedForReplacement', windowId: 2 }).valid, false);
        assert.equal(validateMessageRequest({ action: 'cancelReplacement' }).valid, false);
    });

    it('does not require a URL for replacement (it comes from background state)', () => {
        assert.equal(
            validateMessageRequest({ action: 'tabSelectedForReplacement', tabId: 1, windowId: 2 }).valid,
            true
        );
    });
});
