import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { remainingNeeds, canCloseSelection } from '../extension/utils/selection.js';

const tab = (id, reduces) => ({ id, reduces });

describe('remainingNeeds', () => {
    const constraints = [
        { id: 'window', excess: 2 },
        { id: 'group:7', excess: 1 }
    ];
    const tabs = [tab(1, ['window', 'group:7']), tab(2, ['window', 'group:7']), tab(3, ['window']), tab(4, ['window'])];

    it('counts only selected tabs that reduce each constraint', () => {
        assert.deepEqual(remainingNeeds(constraints, tabs, [3]), [
            { id: 'window', need: 1 },
            { id: 'group:7', need: 1 }
        ]);
        assert.deepEqual(remainingNeeds(constraints, tabs, [1, 3]), [
            { id: 'window', need: 0 },
            { id: 'group:7', need: 0 }
        ]);
    });

    it('never reports a negative need', () => {
        assert.deepEqual(remainingNeeds(constraints, tabs, [1, 2, 3, 4]).map((e) => e.need), [0, 0]);
    });

    it('ignores selected IDs that are not in the list', () => {
        assert.equal(remainingNeeds(constraints, tabs, [99])[0].need, 2);
    });
});

describe('canCloseSelection', () => {
    const constraints = [{ id: 'window', excess: 1 }];
    const tabs = [tab(1, ['window']), tab(2, ['window']), tab(3, ['window'])];

    it('needs a non-empty selection that resolves every constraint', () => {
        assert.equal(canCloseSelection(constraints, tabs, []), false);
        assert.equal(canCloseSelection(constraints, tabs, [1]), true);
    });

    it('requires the window and the group constraint together (simultaneous violations)', () => {
        const both = [{ id: 'window', excess: 1 }, { id: 'group:7', excess: 1 }];
        const mixed = [tab(1, ['window', 'group:7']), tab(2, ['window']), tab(3, ['window'])];
        assert.equal(canCloseSelection(both, mixed, [2]), false, 'group 7 is still over');
        assert.equal(canCloseSelection(both, mixed, [1]), true);
    });

    it('refuses to select every tab in the window', () => {
        assert.equal(canCloseSelection(constraints, tabs, [1, 2, 3]), false);
        assert.equal(canCloseSelection(constraints, [tab(1, ['window'])], [1]), false);
    });
});
