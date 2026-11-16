// Display sanitization helpers shared by the popup and selector pages.
// Pure string functions (no DOM) so they can be unit tested in Node.

const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
};

// Escape text for safe interpolation into HTML (element content or quoted attributes)
export function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

const MAX_TITLE_LENGTH = 100;

// Normalize a tab title for display: strip control and zero-width characters, cap length
export function sanitizeTabTitle(title) {
    if (!title || typeof title !== 'string') {
        return 'Untitled';
    }

    const sanitized = title
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
        .replace(/[​-‍﻿]/g, '')
        .trim();

    if (sanitized.length > MAX_TITLE_LENGTH) {
        return sanitized.substring(0, MAX_TITLE_LENGTH - 3) + '...';
    }

    return sanitized || 'Untitled';
}

// Allow only inline image data URLs as favicons, so the extension never
// makes a network request to a third-party host.
export function isValidFaviconUrl(url) {
    if (typeof url !== 'string' || url.length > 2048) {
        return false;
    }
    return /^data:image\/[a-z0-9.+-]+[;,]/i.test(url);
}
