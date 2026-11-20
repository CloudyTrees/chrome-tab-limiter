// Pure helpers for the popup's tab picker. The background re-checks everything
// (resolvesAll in utils/limits.js); this only gives the user live feedback.
//
// `constraints` and `tabs` are the ones the background sends with getState:
//   constraints: [{ id, scope, excess, ... }]   violated limits only
//   tabs:        [{ id, reduces: [constraintId] }]

// How many more tabs must be closed to satisfy each violated constraint
export function remainingNeeds(constraints, tabs, selectedIds) {
    const selected = new Set(selectedIds);
    return constraints.map((constraint) => {
        const closing = tabs.filter((tab) => selected.has(tab.id) && tab.reduces.includes(constraint.id)).length;
        return { id: constraint.id, need: Math.max(0, constraint.excess - closing) };
    });
}

// Can the selection be submitted? It must resolve every constraint, be
// non-empty, and leave at least one tab in the window.
export function canCloseSelection(constraints, tabs, selectedIds) {
    const selected = new Set(selectedIds);
    if (selected.size === 0 || selected.size >= tabs.length) {
        return false;
    }
    return remainingNeeds(constraints, tabs, selected).every((entry) => entry.need === 0);
}
