import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, sanitizeTabTitle, isValidFaviconUrl } from '../extension/utils/sanitize.js';

describe('escapeHtml', () => {
    it('escapes all HTML-significant characters', () => {
        assert.equal(escapeHtml(`<a href="x" onclick='y'>&</a>`),
            '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    });

    it('neutralizes a malicious tab title', () => {
        const out = escapeHtml('<img src=x onerror=alert(1)>');
        assert.equal(out.includes('<'), false);
        assert.equal(out.includes('>'), false);
    });

    it('leaves plain text unchanged', () => {
        assert.equal(escapeHtml('Inbox (3) — Mail'), 'Inbox (3) — Mail');
    });

    it('does not double-escape across calls in an unexpected way', () => {
        assert.equal(escapeHtml('&amp;'), '&amp;amp;');
    });

    it('stringifies non-strings and treats null/undefined as empty', () => {
        assert.equal(escapeHtml(42), '42');
        assert.equal(escapeHtml(null), '');
        assert.equal(escapeHtml(undefined), '');
    });
});

describe('sanitizeTabTitle', () => {
    it('returns Untitled for empty or non-string input', () => {
        for (const value of ['', '   ', null, undefined, 5, {}]) {
            assert.equal(sanitizeTabTitle(value), 'Untitled', String(value));
        }
    });

    it('strips control and zero-width characters and trims', () => {
        assert.equal(sanitizeTabTitle('  Hel\u0000lo​ Wor\u0007ld﻿  '), 'Hello World');
    });

    it('keeps titles of exactly 100 characters intact', () => {
        const title = 'a'.repeat(100);
        assert.equal(sanitizeTabTitle(title), title);
    });

    it('truncates long titles to 100 characters with an ellipsis', () => {
        const out = sanitizeTabTitle('b'.repeat(500));
        assert.equal(out.length, 100);
        assert.ok(out.endsWith('...'));
    });

    it('does not escape HTML (that is escapeHtml\'s job)', () => {
        assert.equal(sanitizeTabTitle('<b>x</b>'), '<b>x</b>');
    });
});

describe('isValidFaviconUrl', () => {
    it('accepts inline image data URLs', () => {
        assert.equal(isValidFaviconUrl('data:image/png;base64,iVBORw0KGgo='), true);
        assert.equal(isValidFaviconUrl('data:image/svg+xml,%3Csvg%3E%3C/svg%3E'), true);
        assert.equal(isValidFaviconUrl('data:image/x-icon;base64,AAAB'), true);
    });

    it('rejects anything that would cause a network request', () => {
        for (const url of [
            'https://example.com/favicon.ico',
            'http://example.com/favicon.ico',
            '//example.com/favicon.ico',
            'chrome://favicon/https://example.com'
        ]) {
            assert.equal(isValidFaviconUrl(url), false, url);
        }
    });

    it('rejects non-image data URLs and script URLs', () => {
        for (const url of ['data:text/html,<script>1</script>', 'data:image', 'javascript:alert(1)']) {
            assert.equal(isValidFaviconUrl(url), false, url);
        }
    });

    it('rejects oversized and non-string values', () => {
        assert.equal(isValidFaviconUrl('data:image/png;base64,' + 'A'.repeat(3000)), false);
        assert.equal(isValidFaviconUrl(undefined), false);
        assert.equal(isValidFaviconUrl(123), false);
    });
});
