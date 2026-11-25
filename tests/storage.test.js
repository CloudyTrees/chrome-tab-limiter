import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createChromeMock } from './helpers/chrome-mock.js';
import {
    getTabLimit,
    setTabLimit,
    getDefaultLimit,
    removeWindowData,
    DEFAULT_TAB_LIMIT
} from '../extension/utils/storage.js';

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
