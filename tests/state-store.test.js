import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createChromeMock } from './helpers/chrome-mock.js';
import {
    STATE_KEY,
    createState,
    createWindowState,
    isValidState,
    loadState,
    saveState
} from '../chrome-tab-limiter/utils/state-store.js';
import { createSerialQueue } from '../chrome-tab-limiter/utils/serial-queue.js';

describe('state store', () => {
    it('round-trips a state through session storage', async () => {
        const { chrome } = createChromeMock();
        const state = createState(true);
        state.windows[1] = createWindowState();
        state.windows[1].pending.push(7);
        state.windows[1].op = { opId: 'a', revision: 2, kind: 'normal', phase: 'open', closing: [], rejectedCount: 0 };

        await saveState(chrome.storage.session, state);
        assert.deepEqual(await loadState(chrome.storage.session), state);
    });

    it('returns null when nothing is stored (browser start, reload or update)', async () => {
        const { chrome } = createChromeMock();
        assert.equal(await loadState(chrome.storage.session), null);
    });

    it('rejects stored data that does not match the schema', async () => {
        const { chrome } = createChromeMock();
        const valid = createState(false);
        const corruptions = [
            { ...valid, schema: 2 },
            { ...valid, startupMode: 'yes' },
            { ...valid, windows: null },
            { ...valid, windows: { 1: { ...createWindowState(), pending: ['x'] } } },
            { ...valid, windows: { 1: { ...createWindowState(), op: { opId: 5 } } } },
            { ...valid, windows: { 1: { ...createWindowState(), allowance: { window: 'x', groups: {} } } } },
            'nope'
        ];
        for (const bad of corruptions) {
            await chrome.storage.session.set({ [STATE_KEY]: bad });
            assert.equal(await loadState(chrome.storage.session), null, JSON.stringify(bad).slice(0, 60));
        }
        assert.equal(isValidState(valid), true);
    });

    it('stores IDs and counts only, never a URL or a title', () => {
        const state = createState(true);
        state.windows[1] = createWindowState();
        const json = JSON.stringify(state);
        assert.equal(/https?:|title|url/i.test(json), false);
    });
});

describe('serial queue', () => {
    it('runs tasks one at a time, in order', async () => {
        const queue = createSerialQueue();
        const log = [];
        const task = (name, ms) => async () => {
            log.push(`start ${name}`);
            await new Promise((resolve) => setTimeout(resolve, ms));
            log.push(`end ${name}`);
            return name;
        };

        const results = await Promise.all([queue.enqueue(task('a', 15)), queue.enqueue(task('b', 1)), queue.enqueue(task('c', 5))]);

        assert.deepEqual(results, ['a', 'b', 'c']);
        assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    });

    it('continues after a task throws, and only that task\'s promise rejects', async () => {
        const queue = createSerialQueue();
        const failed = queue.enqueue(async () => {
            throw new Error('boom');
        });
        const next = queue.enqueue(async () => 'still runs');

        await assert.rejects(failed, /boom/);
        assert.equal(await next, 'still runs');
    });
});
