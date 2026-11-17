import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createChromeMock } from './helpers/chrome-mock.js';

// export-import.js is a classic script that attaches its API to `window`
// (loaded by options.html). Evaluate it with a stub window and our chrome mock.
const SOURCE = readFileSync(
    new URL('../chrome-tab-limiter/utils/export-import.js', import.meta.url),
    'utf8'
);

function loadExportImport(chrome) {
    const window = {};
    new Function('window', 'chrome', SOURCE)(window, chrome);
    return window.TabLimiterExportImport;
}

let harness;
let api;

beforeEach(() => {
    harness = createChromeMock();
    api = loadExportImport(harness.chrome);
});

const validFile = (settings = {}) => ({
    version: '1.0.0',
    settings: { defaultTabLimit: 12, windowLimits: {}, groupLimits: {}, ...settings }
});

describe('validateImportData', () => {
    it('accepts a well-formed settings file', () => {
        assert.deepEqual(api.validateImportData(validFile()), { valid: true });
    });

    it('rejects non-objects and missing settings', () => {
        for (const data of [null, 'x', 5, {}, { settings: 'nope' }]) {
            assert.equal(api.validateImportData(data).valid, false, JSON.stringify(data));
        }
    });

    it('rejects out-of-range or non-integer limits', () => {
        for (const limit of [0, -1, 101, 1.5, '10', null]) {
            assert.equal(api.validateImportData(validFile({ defaultTabLimit: limit })).valid, false, String(limit));
        }
    });

    it('rejects files from a newer major version', () => {
        assert.equal(api.validateImportData({ ...validFile(), version: '2.0.0' }).valid, false);
    });

    it('rejects prototype-pollution and malformed keys', () => {
        const polluted = JSON.parse('{"settings":{"windowLimits":{"__proto__":5}}}');
        assert.equal(api.validateImportData(polluted).valid, false);

        const badWindowKey = validFile({ windowLimits: { 'window 1; drop': 5 } });
        assert.equal(api.validateImportData(badWindowKey).valid, false);

        const badGroupKey = validFile({ groupLimits: { tabLimit_1: 5 } });
        assert.equal(api.validateImportData(badGroupKey).valid, false);
    });
});

describe('exportSettings', () => {
    it('anonymizes window and group IDs and omits the date', async () => {
        await harness.chrome.storage.local.set({
            defaultTabLimit: 9,
            tabLimit_1234567: 5,
            groupLimit_1234567_888: 4,
            hasSeenWelcome: true
        });

        const exported = await api.exportSettings();
        const json = JSON.stringify(exported);

        assert.equal(exported.settings.defaultTabLimit, 9);
        assert.equal(json.includes('1234567'), false, 'real window ID leaked');
        assert.equal(json.includes('888'), false, 'real group ID leaked');
        assert.equal(exported.exportDate, 'Privacy Protected');
        assert.equal(json.includes('hasSeenWelcome'), false);
    });

    it('produces a file that passes import validation', async () => {
        await harness.chrome.storage.local.set({ defaultTabLimit: 9, tabLimit_1: 5, groupLimit_1_2: 4 });
        const exported = await api.exportSettings();
        assert.deepEqual(api.validateImportData(exported), { valid: true });
    });
});

describe('exportSettings alias allocation (B-08)', () => {
    const SETTINGS = {
        groupLimit_10_1: 4,
        groupLimit_20_2: 5,
        tabLimit_20: 6,
        tabLimit_30: 7
    };

    const permutations = (items) =>
        items.length <= 1
            ? [items]
            : items.flatMap((item, i) =>
                  permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])
              );

    it('keeps every custom setting and relationship for every key order', async () => {
        for (const order of permutations(Object.keys(SETTINGS))) {
            const local = harness.chrome.storage.local;
            await local.clear();
            for (const key of order) {
                await local.set({ [key]: SETTINGS[key] });
            }

            const { settings, metadata } = await api.exportSettings();
            const label = order.join(', ');

            assert.deepEqual(Object.values(settings.windowLimits).sort(), [6, 7], `window limits lost: ${label}`);
            assert.equal(metadata.totalWindows, 3, `window count: ${label}`);
            assert.equal(metadata.totalCustomLimits, 4, label);

            // Window 20's group limit must hang off the alias that holds window 20's limit (6)
            const group20 = Object.entries(settings.groupLimits).find(([, v]) => v === 5);
            const aliasOfGroup20 = group20[0].split('_').slice(1, 3).join('_');
            assert.equal(settings.windowLimits[aliasOfGroup20], 6, `group 20 detached: ${label}`);

            // Window 10 (group limit only) must not share an alias with a window that has a limit
            const group10 = Object.entries(settings.groupLimits).find(([, v]) => v === 4);
            const aliasOfGroup10 = group10[0].split('_').slice(1, 3).join('_');
            assert.equal(aliasOfGroup10 in settings.windowLimits, false, `window 10 collided: ${label}`);
        }
    });
});

describe('pending-tab cap in export and import', () => {
    it('exports the cap, defaulting to 5', async () => {
        assert.equal((await api.exportSettings()).settings.maxPendingPerWindow, 5);
        await harness.chrome.storage.local.set({ maxPendingPerWindow: 8 });
        assert.equal((await api.exportSettings()).settings.maxPendingPerWindow, 8);
    });

    it('imports a valid cap', async () => {
        await api.importSettings(validFile({ maxPendingPerWindow: 7 }));
        assert.equal(harness.chrome.storage.local._dump().maxPendingPerWindow, 7);
    });

    it('rejects a cap outside 1-10 or not an integer', () => {
        for (const value of [0, 11, -1, 2.5, '5', null]) {
            assert.equal(api.validateImportData(validFile({ maxPendingPerWindow: value })).valid, false, String(value));
        }
    });

    it('still accepts older files without the cap', () => {
        assert.equal(api.validateImportData(validFile()).valid, true);
    });
});

describe('importSettings', () => {
    it('replace mode (the default) clears existing settings first', async () => {
        await harness.chrome.storage.local.set({ defaultTabLimit: 3, tabLimit_1: 5 });

        const result = await api.importSettings(validFile({ defaultTabLimit: 12 }));

        assert.equal(result.success, true);
        assert.deepEqual(harness.chrome.storage.local._dump(), { defaultTabLimit: 12 });
    });

    it('merge mode keeps other settings and lets imported values win', async () => {
        await harness.chrome.storage.local.set({ defaultTabLimit: 3, tabLimit_1: 5 });

        await api.importSettings(validFile({ defaultTabLimit: 12 }), { mergeLimits: true });

        assert.deepEqual(harness.chrome.storage.local._dump(), { defaultTabLimit: 12, tabLimit_1: 5 });
    });

    it('never imports window or group limits (IDs are not portable)', async () => {
        const result = await api.importSettings(
            validFile({ windowLimits: { window_1: 5 }, groupLimits: { groupLimit_window_1_group_1: 4 } })
        );
        assert.deepEqual(harness.chrome.storage.local._dump(), { defaultTabLimit: 12 });
        assert.equal(result.privacyNotice.skippedWindowLimits, 1);
        assert.equal(result.privacyNotice.skippedGroupLimits, 1);
    });

    it('rejects invalid data without touching storage', async () => {
        await harness.chrome.storage.local.set({ defaultTabLimit: 3 });
        await assert.rejects(api.importSettings(validFile({ defaultTabLimit: 999 })), /Invalid import data/);
        assert.deepEqual(harness.chrome.storage.local._dump(), { defaultTabLimit: 3 });
    });
});
