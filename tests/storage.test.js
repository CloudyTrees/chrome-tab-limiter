import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createChromeMock } from './helpers/chrome-mock.js';
import {
    getTabLimit,
    setTabLimit,
    getDefaultLimit,
    getGroupLimit,
    setGroupLimit,
    getGroupLimits,
    removeAllGroupData,
    removeWindowData,
    DEFAULT_TAB_LIMIT
} from '../chrome-tab-limiter/utils/storage.js';

let harness;

beforeEach(() => {
    harness = createChromeMock();
    globalThis.chrome = harness.chrome;
});

describe('tab limits', () => {
    it('falls back to the built-in default when nothing is stored', async () => {
        assert.equal(await getDefaultLimit(), DEFAULT_TAB_LIMIT);
        assert.equal(await getTabLimit(1), DEFAULT_TAB_LIMIT);
    });

    it('uses the stored default, then a per-window override', async () => {
        await chrome.storage.local.set({ defaultTabLimit: 7 });
        assert.equal(await getTabLimit(1), 7);

        await setTabLimit(1, 3);
        assert.equal(await getTabLimit(1), 3);
        assert.equal(await getTabLimit(2), 7);
    });

    it('removeWindowData drops only that window\'s override', async () => {
        await setTabLimit(1, 3);
        await setTabLimit(2, 4);
        await removeWindowData(1);
        assert.deepEqual(harness.chrome.storage.local._dump(), { tabLimit_2: 4 });
    });
});

describe('group limits', () => {
    it('stores ungrouped tabs under a dedicated key', async () => {
        await setGroupLimit(1, -1, 5);
        await setGroupLimit(1, 42, 6);
        assert.deepEqual(harness.chrome.storage.local._dump(), {
            groupLimit_1_ungrouped: 5,
            groupLimit_1_42: 6
        });
        assert.equal(await getGroupLimit(1, -1), 5);
        assert.equal(await getGroupLimit(1, 42), 6);
    });

    it('falls back to the default limit for groups without an override', async () => {
        await chrome.storage.local.set({ defaultTabLimit: 8 });
        assert.equal(await getGroupLimit(1, 99), 8);
    });

    it('getGroupLimits returns numeric group IDs, with -1 for ungrouped', async () => {
        await setGroupLimit(1, -1, 5);
        await setGroupLimit(1, 42, 6);
        await setGroupLimit(2, 7, 9);
        assert.deepEqual(await getGroupLimits(1), { '-1': 5, 42: 6 });
    });

    it('removeAllGroupData only touches the given window (not window 12 when removing 1)', async () => {
        await setGroupLimit(1, 42, 6);
        await setGroupLimit(12, 42, 6);
        await chrome.storage.local.set({ defaultTabLimit: 4 });
        await removeAllGroupData(1);
        assert.deepEqual(harness.chrome.storage.local._dump(), {
            groupLimit_12_42: 6,
            defaultTabLimit: 4
        });
    });
});
