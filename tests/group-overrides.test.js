import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    SESSION_TAG_KEY,
    INITIAL_TAG,
    sessionTagOf,
    groupOverrideKey,
    parseGroupOverrideKey,
    parseLegacyGroupLimitKey,
    groupOverridesOf,
    planAdoption
} from '../extension/utils/group-overrides.js';

describe('group override keys', () => {
    it('round-trips a key', () => {
        assert.equal(groupOverrideKey('0', 617140416), 'groupOverride_0_617140416');
        assert.deepEqual(parseGroupOverrideKey('groupOverride_0_617140416'), { tag: '0', groupId: 617140416 });
        const tag = 'b1946ac9-2b4d-4c4e-9f0e-2a1f3c4d5e6f';
        assert.deepEqual(parseGroupOverrideKey(groupOverrideKey(tag, 7)), { tag, groupId: 7 });
    });

    it('rejects anything else', () => {
        for (const key of ['groupOverride_0_', 'groupOverride__7', 'groupOverride_0_-1', 'groupOverride_0_7x', 'groupOverride_a b_7', 'groupLimit_1_7', '__proto__']) {
            assert.equal(parseGroupOverrideKey(key), null, key);
        }
    });

    it('reads a legacy window-keyed group limit, but not the ungrouped limit', () => {
        assert.deepEqual(parseLegacyGroupLimitKey('groupLimit_124397568_617140416'), { windowId: 124397568, groupId: 617140416 });
        assert.equal(parseLegacyGroupLimitKey('groupLimit_1_ungrouped'), null);
        assert.equal(parseLegacyGroupLimitKey('groupOverride_0_7'), null);
    });

    it('a missing or malformed session tag counts as the initial one', () => {
        assert.equal(sessionTagOf({}), INITIAL_TAG);
        assert.equal(sessionTagOf({ [SESSION_TAG_KEY]: 5 }), INITIAL_TAG);
        assert.equal(sessionTagOf({ [SESSION_TAG_KEY]: 'has space' }), INITIAL_TAG);
        assert.equal(sessionTagOf({ [SESSION_TAG_KEY]: 'ab-12' }), 'ab-12');
    });
});

describe('groupOverridesOf', () => {
    it('returns the valid limits under the current tag, by group ID', () => {
        const local = {
            [SESSION_TAG_KEY]: 'b2',
            groupOverride_b2_7: 3,
            groupOverride_b2_8: 100,
            groupOverride_0_9: 4, // an earlier session
            groupLimit_1_10: 5, // legacy: never read as a limit
            groupLimit_1_ungrouped: 6, // the window's own limit: not a group override
            groupOverride_b2_11: 0,
            groupOverride_b2_12: 101,
            groupOverride_b2_13: 2.5,
            groupOverride_b2_14: '4'
        };
        assert.deepEqual(groupOverridesOf(local), { 7: 3, 8: 100 });
    });

    it('uses the initial tag until one is written', () => {
        assert.deepEqual(groupOverridesOf({ groupOverride_0_7: 3, groupOverride_x_8: 4 }), { 7: 3 });
    });
});

describe('planAdoption', () => {
    const tabs = [
        { windowId: 1, groupId: 7 },
        { windowId: 1, groupId: -1 },
        { windowId: 2, groupId: 8 }
    ];

    it('adopts a legacy key whose group is live in the window it names', () => {
        assert.deepEqual(planAdoption({ groupLimit_1_7: 3 }, tabs), { writes: { groupOverride_0_7: 3 }, removes: ['groupLimit_1_7'] });
    });

    it('drops a legacy key whose group is in another window, or gone', () => {
        assert.deepEqual(planAdoption({ groupLimit_1_8: 3, groupLimit_1_99: 4 }, tabs), {
            writes: {},
            removes: ['groupLimit_1_8', 'groupLimit_1_99']
        });
    });

    it('keeps an existing tagged value: an earlier adoption or a newer save', () => {
        assert.deepEqual(planAdoption({ groupLimit_1_7: 3, groupOverride_0_7: 5 }, tabs), { writes: {}, removes: ['groupLimit_1_7'] });
    });

    it('drops an invalid legacy value', () => {
        assert.deepEqual(planAdoption({ groupLimit_1_7: 0 }, tabs), { writes: {}, removes: ['groupLimit_1_7'] });
    });

    it('adopts nothing once the tag has changed, and only removes', () => {
        assert.deepEqual(planAdoption({ [SESSION_TAG_KEY]: 'b2', groupLimit_1_7: 3 }, tabs), { writes: {}, removes: ['groupLimit_1_7'] });
    });

    it('leaves the ungrouped limit and other settings alone', () => {
        assert.deepEqual(planAdoption({ groupLimit_1_ungrouped: 3, tabLimit_1: 4, defaultTabLimit: 5 }, tabs), { writes: {}, removes: [] });
    });
});
