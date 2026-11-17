import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    capacityOf,
    computeExcess,
    fitsAll,
    decideCreation,
    resolvesAll,
    shrinkAllowance,
    keepAllowance,
    keepEligibleIds
} from '../chrome-tab-limiter/utils/limits.js';

// n tabs with IDs start..start+n-1, all in `groupId`
const tabsIn = (n, groupId = -1, start = 1) =>
    Array.from({ length: n }, (_, i) => ({ id: start + i, groupId }));

const config = (windowLimit, groupLimits = {}, defaultLimit = windowLimit) => ({ windowLimit, groupLimits, defaultLimit });

// Window limit only: groups (including ungrouped) are effectively unlimited
const windowOnly = (windowLimit) => config(windowLimit, {}, 100);

describe('capacityOf', () => {
    it('is the larger of the limit and the allowance', () => {
        assert.equal(capacityOf(10, undefined), 10);
        assert.equal(capacityOf(10, null), 10);
        assert.equal(capacityOf(10, 12), 12);
        assert.equal(capacityOf(10, 4), 10);
    });
});

describe('computeExcess', () => {
    it('is not over at or below the limit', () => {
        for (const n of [0, 4, 5]) {
            const result = computeExcess(tabsIn(n), config(5));
            assert.equal(result.over, false, String(n));
            assert.equal(result.window.excess, 0);
        }
    });

    it('reports window excess', () => {
        const result = computeExcess(tabsIn(8), config(5));
        assert.deepEqual(result.window, { count: 8, limit: 5, capacity: 5, excess: 3 });
        assert.equal(result.over, true);
        assert.equal(result.totalExcess, 3);
    });

    it('reports group excess against the group limit, falling back to the default', () => {
        const tabs = [...tabsIn(3, 7), ...tabsIn(2, 8, 10)];
        // window limit 10 (fine); group 7 limited to 2; group 8 uses the default of 5
        const result = computeExcess(tabs, config(10, { 7: 2 }, 5));
        assert.equal(result.groups[7].excess, 1);
        assert.equal(result.groups[8].excess, 0);
        assert.equal(result.groups[8].limit, 5);
        assert.equal(result.over, true);
    });

    it('treats ungrouped tabs as group -1', () => {
        const result = computeExcess(tabsIn(4, -1), config(10, { '-1': 3 }));
        assert.equal(result.groups[-1].excess, 1);
    });

    it('counts a tab once toward the window even when a group is also over', () => {
        // window 5/4 over by 1; group 7 has 3 tabs with limit 2: over by 1; closing one grouped tab fixes both
        const tabs = [...tabsIn(3, 7), ...tabsIn(2, -1, 10)];
        const result = computeExcess(tabs, config(4, { 7: 2 }, 4));
        assert.equal(result.window.excess, 1);
        assert.equal(result.groups[7].excess, 1);
        assert.equal(result.totalExcess, 1);
    });

    it('sums group excesses when they exceed the window excess', () => {
        const tabs = [...tabsIn(3, 7), ...tabsIn(3, 8, 10)];
        const result = computeExcess(tabs, config(6, { 7: 2, 8: 2 }));
        assert.equal(result.window.excess, 0);
        assert.equal(result.totalExcess, 2);
    });

    it('uses the allowance as capacity', () => {
        // Codex's example (C3): limit 10, allowance 12, 13 tabs
        const result = computeExcess(tabsIn(13), windowOnly(10), { window: 12, groups: {} });
        assert.equal(result.window.capacity, 12);
        assert.equal(result.window.excess, 1);
        assert.equal(computeExcess(tabsIn(12), windowOnly(10), { window: 12, groups: {} }).over, false);
    });

    it('applies group allowances per group', () => {
        const tabs = tabsIn(4, 7);
        assert.equal(computeExcess(tabs, config(10, { 7: 2 }), { window: null, groups: { 7: 4 } }).over, false);
        assert.equal(computeExcess(tabs, config(10, { 7: 2 })).over, true);
    });
});

describe('fitsAll', () => {
    it('requires room in the window and in the tab\'s group', () => {
        const tabs = [...tabsIn(2, 7), ...tabsIn(1, 8, 10)];
        assert.equal(fitsAll(tabs, 8, config(4, { 7: 2 }, 4)), true);
        assert.equal(fitsAll(tabs, 7, config(4, { 7: 2 }, 4)), false, 'group 7 is full');
        assert.equal(fitsAll([...tabs, ...tabsIn(1, 9, 20)], 8, config(4, { 7: 2 }, 4)), false, 'window is full');
    });

    it('honours allowances', () => {
        assert.equal(fitsAll(tabsIn(10), -1, windowOnly(10)), false);
        assert.equal(fitsAll(tabsIn(10), -1, windowOnly(10), { window: 12, groups: {} }), true);
        assert.equal(fitsAll(tabsIn(12), -1, windowOnly(10), { window: 12, groups: {} }), false);
    });
});

describe('decideCreation (plan §5)', () => {
    const base = (overrides) => ({
        tabs: tabsIn(3),
        groupId: -1,
        config: config(5),
        allowance: null,
        startupMode: false,
        hasOperation: false,
        pendingCount: 0,
        cap: 5,
        ...overrides
    });

    it('admits a tab that fits', () => {
        assert.deepEqual(decideCreation(base()), { action: 'admit', opKind: null });
    });

    it('makes the first excess tab pending and opens a normal operation', () => {
        assert.deepEqual(decideCreation(base({ tabs: tabsIn(5) })), { action: 'pending', opKind: 'normal' });
    });

    it('joins an open operation as pending until the cap, then rejects', () => {
        const open = base({ tabs: tabsIn(10), hasOperation: true, cap: 5 });
        assert.equal(decideCreation({ ...open, pendingCount: 4 }).action, 'pending');
        assert.equal(decideCreation({ ...open, pendingCount: 5 }).action, 'reject');
        assert.equal(decideCreation({ ...open, pendingCount: 5 }).opKind, null);
    });

    it('honours the configured cap', () => {
        const open = base({ tabs: tabsIn(10), hasOperation: true });
        assert.equal(decideCreation({ ...open, cap: 1, pendingCount: 1 }).action, 'reject');
        assert.equal(decideCreation({ ...open, cap: 10, pendingCount: 9 }).action, 'pending');
    });

    it('C1: an open operation takes precedence even when the tab would fit', () => {
        // Group A (7) is over; a new tab in group B (8) would fit both window and group
        const tabs = tabsIn(3, 7);
        const input = base({ tabs, groupId: 8, config: config(10, { 7: 2 }, 10), hasOperation: true });
        assert.equal(fitsAll(tabs, 8, input.config, null), true);
        assert.equal(decideCreation({ ...input, pendingCount: 0 }).action, 'pending');
        assert.equal(decideCreation({ ...input, pendingCount: 5 }).action, 'reject');
    });

    describe('startup mode (D1)', () => {
        it('admits a tab that fits', () => {
            assert.deepEqual(decideCreation(base({ startupMode: true })), { action: 'admit', opKind: null });
        });

        it('keeps a tab that does not fit as startup, never pending or rejected', () => {
            assert.deepEqual(decideCreation(base({ startupMode: true, tabs: tabsIn(9) })), {
                action: 'startup',
                opKind: 'startup'
            });
        });

        it('R1: never rejects, even with an open operation and a full cap', () => {
            const over = base({ startupMode: true, tabs: tabsIn(9), hasOperation: true, pendingCount: 5, cap: 5 });
            assert.equal(decideCreation(over).action, 'startup');
        });

        it('R1: a tab that fits its own group is admitted while another group\'s operation is open, below and above the cap', () => {
            const tabs = tabsIn(3, 7); // group 7 over its limit of 2
            const input = base({ tabs, groupId: 8, config: config(10, { 7: 2 }, 10), startupMode: true, hasOperation: true });
            for (const pendingCount of [0, 4, 5, 9]) {
                assert.deepEqual(
                    decideCreation({ ...input, pendingCount, cap: 5 }),
                    { action: 'admit', opKind: null },
                    `pendingCount ${pendingCount}`
                );
            }
        });

        it('R1: a tab that does not fit stays a startup tab at and above the cap', () => {
            const tabs = tabsIn(3, 7);
            const input = base({ tabs, groupId: 7, config: config(10, { 7: 2 }, 10), startupMode: true, hasOperation: true });
            for (const pendingCount of [0, 5, 9]) {
                assert.equal(decideCreation({ ...input, pendingCount, cap: 5 }).action, 'startup', String(pendingCount));
            }
        });
    });
});

describe('resolvesAll', () => {
    it('is true when the selection brings every constraint within capacity', () => {
        const tabs = tabsIn(8);
        assert.equal(resolvesAll(tabs, [1, 2, 3], config(5)), true);
        assert.equal(resolvesAll(tabs, [1, 2], config(5)), false);
    });

    it('requires the window AND every group to be resolved', () => {
        // window 6/4 (over by 2) and group 7 3/1 (over by 2)
        const tabs = [...tabsIn(3, 7), ...tabsIn(3, -1, 10)];
        const cfg = config(4, { 7: 1 }, 4);
        assert.equal(resolvesAll(tabs, [10, 11], cfg), false, 'window fixed but group 7 is not');
        assert.equal(resolvesAll(tabs, [1, 2], cfg), true, 'group fixed and window fixed');
        assert.equal(resolvesAll(tabs, [1], cfg), false);
    });

    it('is satisfied by closing tabs from an over group even if other groups are untouched', () => {
        const tabs = [...tabsIn(3, 7), ...tabsIn(1, 8, 10)];
        assert.equal(resolvesAll(tabs, [1], config(10, { 7: 2 })), true);
    });

    it('respects allowances', () => {
        assert.equal(resolvesAll(tabsIn(13), [1], windowOnly(10), { window: 12, groups: {} }), true);
    });
});

describe('shrinkAllowance', () => {
    it('lowers the allowance to the remaining count and clears it at or below the limit', () => {
        const allowance = { window: 12, groups: {} };
        assert.deepEqual(shrinkAllowance(allowance, tabsIn(11), config(10)), { window: 11, groups: {} });
        assert.equal(shrinkAllowance(allowance, tabsIn(10), config(10)), null);
        assert.equal(shrinkAllowance(allowance, tabsIn(7), config(10)), null);
    });

    it('never raises an allowance', () => {
        assert.deepEqual(shrinkAllowance({ window: 12, groups: {} }, tabsIn(20), config(10)), { window: 12, groups: {} });
    });

    it('shrinks each group allowance independently and drops emptied groups', () => {
        const allowance = { window: null, groups: { 7: 6, 8: 4 } };
        const tabs = [...tabsIn(5, 7), ...tabsIn(3, 8, 10)];
        // group 7: min(6, 5) = 5 > limit 3, kept; group 8: min(4, 3) = 3 <= limit 3, cleared
        assert.deepEqual(shrinkAllowance(allowance, tabs, config(20, { 7: 3, 8: 3 })), { window: null, groups: { 7: 5 } });
        // group gone entirely
        assert.equal(shrinkAllowance({ window: null, groups: { 9: 6 } }, tabs, config(20, {}, 3)), null);
    });

    it('accepts a missing allowance', () => {
        assert.equal(shrinkAllowance(undefined, tabsIn(3), config(10)), null);
        assert.equal(shrinkAllowance(null, tabsIn(3), config(10)), null);
    });

    it('does not mutate its input', () => {
        const allowance = { window: 12, groups: { 7: 5 } };
        const copy = structuredClone(allowance);
        shrinkAllowance(allowance, tabsIn(11), config(10));
        assert.deepEqual(allowance, copy);
    });
});

describe('keepAllowance', () => {
    it('raises the window allowance to the count of Keep-eligible tabs', () => {
        const tabs = tabsIn(13);
        const eligible = keepEligibleIds(tabs, { pending: [13] });
        assert.deepEqual(keepAllowance(null, tabs, eligible, windowOnly(10)), { window: 12, groups: {} });
    });

    it('also raises the ungrouped allowance when the ungrouped limit is exceeded too', () => {
        // 13 ungrouped tabs with the default limit 10 for the window and for the ungrouped group
        const tabs = tabsIn(13);
        const eligible = keepEligibleIds(tabs, { pending: [13] });
        assert.deepEqual(keepAllowance(null, tabs, eligible, config(10)), { window: 12, groups: { '-1': 12 } });
    });

    it('excludes pending and moved tabs (R2)', () => {
        const tabs = tabsIn(14);
        const eligible = keepEligibleIds(tabs, { pending: [13], moved: [14] });
        assert.equal(eligible.length, 12);
        assert.deepEqual(keepAllowance(null, tabs, eligible, windowOnly(10)), { window: 12, groups: {} });
        // With the pending and moved tabs, the window is still over afterwards
        const after = computeExcess(tabs, windowOnly(10), keepAllowance(null, tabs, eligible, windowOnly(10)));
        assert.equal(after.window.excess, 2);
    });

    it('sets the allowance of each over group, and only over groups', () => {
        const tabs = [...tabsIn(4, 7), ...tabsIn(2, 8, 10), ...tabsIn(1, -1, 20)];
        const result = keepAllowance(null, tabs, tabs.map((t) => t.id), config(10, { 7: 2, 8: 2 }, 10));
        assert.deepEqual(result, { window: null, groups: { 7: 4 } });
    });

    it('does not lower an existing allowance and drops a value that would not exceed the limit', () => {
        const tabs = tabsIn(13);
        assert.deepEqual(keepAllowance({ window: 12, groups: {} }, tabs, [1, 2, 3], config(10)), { window: 12, groups: {} });
        assert.equal(keepAllowance(null, tabs, [1, 2, 3], config(10)), null, '3 eligible tabs do not exceed the limit');
    });

    it('does nothing when the window is not over', () => {
        const tabs = tabsIn(5);
        assert.equal(keepAllowance(null, tabs, tabs.map((t) => t.id), config(10)), null);
        assert.deepEqual(keepAllowance({ window: 12, groups: {} }, tabs, [1], config(10)), { window: 12, groups: {} });
    });

    it('does not mutate its input', () => {
        const allowance = { window: 11, groups: {} };
        const copy = structuredClone(allowance);
        keepAllowance(allowance, tabsIn(13), tabsIn(13).map((t) => t.id), config(10));
        assert.deepEqual(allowance, copy);
    });
});

describe('keepEligibleIds', () => {
    it('is every tab that is neither pending nor moved', () => {
        const tabs = tabsIn(5);
        assert.deepEqual(keepEligibleIds(tabs, { pending: [1], moved: [2] }), [3, 4, 5]);
        assert.deepEqual(keepEligibleIds(tabs), [1, 2, 3, 4, 5]);
    });
});
