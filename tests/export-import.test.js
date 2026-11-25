import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createChromeMock } from './helpers/chrome-mock.js';

// export-import.js is a classic script that attaches its API to `window`
// (loaded by options.html). Evaluate it with a stub window and our chrome mock.
const SOURCE = readFileSync(
    new URL('../extension/utils/export-import.js', import.meta.url),
    'utf8'
);

function loadExportImport(chrome) {
    const window = {};
    new Function('window', 'chrome', SOURCE)(window, chrome);
    return window.TabLimiterExportImport;
}

let harness;
let api;

// Storage after a reset or a replacing import: exactly `expected`, plus a new session
// tag for custom group limits (no limit from before can apply again, plan R6)
function assertReplacedWith(expected) {
    const { groupLimitSession: tag, ...rest } = harness.chrome.storage.local._dump();
    assert.deepEqual(rest, expected);
    assert.match(tag, /^[A-Za-z0-9-]{8,64}$/, 'a new session tag');
}

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
            groupOverride_0_888: 4,
            groupLimit_1234567_ungrouped: 3,
            hasSeenWelcome: true
        });

        const exported = await api.exportSettings();
        const json = JSON.stringify(exported);

        assert.equal(exported.settings.defaultTabLimit, 9);
        assert.equal(json.includes('1234567'), false, 'real window ID leaked');
        assert.equal(json.includes('888'), false, 'real group ID leaked');
        assert.deepEqual(Object.values(exported.settings.groupLimits).sort(), [3, 4], 'both exported');
        assert.equal(exported.exportDate, 'Privacy Protected');
        assert.equal(json.includes('hasSeenWelcome'), false);
    });

    it("exports the current session's group limits anonymized, and nothing from an earlier session", async () => {
        await harness.chrome.storage.local.set({
            defaultTabLimit: 9,
            groupLimitSession: 'cafe-01',
            'groupOverride_cafe-01_987654': 4,
            groupOverride_0_555555: 6
        });

        const exported = await api.exportSettings();
        const json = JSON.stringify(exported);

        assert.deepEqual(exported.settings.groupLimits, { groupLimit_group_1: 4 });
        assert.equal(json.includes('987654'), false, 'real group ID leaked');
        assert.equal(json.includes('cafe'), false, 'the session tag is never exported');
        assert.equal(json.includes('555555'), false);
        assert.equal(exported.metadata.totalGroups, 1);
        assert.deepEqual(api.validateImportData(exported), { valid: true });
        assert.equal((await api.getCurrentSettingsSummary()).groupLimits, 1);
    });

    it('exports only limits that apply: a legacy key left by a failed cleanup is neither exported nor counted (Codex)', async () => {
        await harness.chrome.storage.local.set({ groupOverride_0_777777: 4, groupLimit_1_777777: 9, groupLimit_1_888888: 5, groupLimit_1_ungrouped: 6 });

        const exported = await api.exportSettings();

        assert.deepEqual(Object.values(exported.settings.groupLimits).sort(), [4, 6], 'the tagged limit and the ungrouped limit');
        assert.equal(exported.metadata.totalGroups, 2);
        assert.equal((await api.getCurrentSettingsSummary()).groupLimits, 2);
    });

    it('produces a file that passes import validation', async () => {
        await harness.chrome.storage.local.set({ defaultTabLimit: 9, tabLimit_1: 5, groupOverride_0_2: 4, groupLimit_1_ungrouped: 3 });
        const exported = await api.exportSettings();
        assert.deepEqual(api.validateImportData(exported), { valid: true });
    });
});

describe('exportSettings alias allocation (B-08)', () => {
    // The window-keyed group limit that still applies is the ungrouped one (a tab
    // group's own limit is stored by group ID and has no window)
    const SETTINGS = {
        groupLimit_10_ungrouped: 4,
        groupLimit_20_ungrouped: 5,
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

describe('export file name (S-5)', () => {
    it('carries no date or time, because the file content has none either', () => {
        const name = api.generateExportFilename();
        assert.equal(name, 'tab-limiter-settings.json');
        assert.equal(/\d/.test(name), false);
    });
});

describe('replacing settings never loses them on a failed write (S-7)', () => {
    const seed = () => harness.chrome.storage.local.set({ defaultTabLimit: 7, tabLimit_1: 4, groupLimit_1_2: 3, maxPendingPerWindow: 8, hasSeenWelcome: true });

    it('a failed write during import leaves every existing setting in place', async () => {
        await seed();
        const before = harness.chrome.storage.local._dump();
        const realSet = harness.chrome.storage.local.set;
        harness.chrome.storage.local.set = async () => {
            throw new Error('quota exceeded');
        };

        await assert.rejects(api.importSettings(validFile({ defaultTabLimit: 20 })), /quota/);

        harness.chrome.storage.local.set = realSet;
        assert.deepEqual(harness.chrome.storage.local._dump(), before);
    });

    it('a failed write during reset leaves every existing setting in place', async () => {
        await seed();
        const before = harness.chrome.storage.local._dump();
        const realSet = harness.chrome.storage.local.set;
        harness.chrome.storage.local.set = async () => {
            throw new Error('quota exceeded');
        };

        await assert.rejects(api.resetAllSettings(), /Failed to reset/);

        harness.chrome.storage.local.set = realSet;
        assert.deepEqual(harness.chrome.storage.local._dump(), before);
    });

    it('a successful import still replaces everything', async () => {
        await seed();
        await api.importSettings(validFile({ defaultTabLimit: 20, maxPendingPerWindow: 3 }));
        assertReplacedWith({ defaultTabLimit: 20, maxPendingPerWindow: 3 });
    });

    it('a successful reset still leaves only the default limit', async () => {
        await seed();
        await api.resetAllSettings();
        assertReplacedWith({ defaultTabLimit: 10 });
    });

    it('merging keeps the settings that are not imported', async () => {
        await seed();
        await api.importSettings(validFile({ defaultTabLimit: 20 }), { mergeLimits: true });
        const stored = harness.chrome.storage.local._dump();
        assert.equal(stored.defaultTabLimit, 20);
        assert.equal(stored.tabLimit_1, 4);
    });
});

describe('importSettings', () => {
    it('replace mode (the default) clears existing settings first', async () => {
        await harness.chrome.storage.local.set({ defaultTabLimit: 3, tabLimit_1: 5 });

        const result = await api.importSettings(validFile({ defaultTabLimit: 12 }));

        assert.equal(result.success, true);
        assertReplacedWith({ defaultTabLimit: 12 });
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
        assertReplacedWith({ defaultTabLimit: 12 });
        assert.equal(result.privacyNotice.skippedWindowLimits, 1);
        assert.equal(result.privacyNotice.skippedGroupLimits, 1);
    });

    it('rejects invalid data without touching storage', async () => {
        await harness.chrome.storage.local.set({ defaultTabLimit: 3 });
        await assert.rejects(api.importSettings(validFile({ defaultTabLimit: 999 })), /Invalid import data/);
        assert.deepEqual(harness.chrome.storage.local._dump(), { defaultTabLimit: 3 });
    });
});
