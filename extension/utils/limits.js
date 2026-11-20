// Pure limit arithmetic for Tab Limiter (docs/review.md, consolidated plan §2 and §5).
// No chrome.* calls, no storage, no clock: everything is a function of its inputs,
// so the background worker and the popup preview can share it and Node can test it.
//
// Shapes used below:
//   tabs:       [{ id, groupId }]            real tabs of ONE window (groupId -1 = ungrouped)
//   config:     { windowLimit, groupLimits, defaultLimit }
//               windowLimit  - effective limit of the window
//               groupLimits  - { [groupId]: limit } for groups with an override
//               defaultLimit - limit of every group without an override
//   allowance:  { window: number|null, groups: { [groupId]: number } } | null | undefined
//               grandfathered capacity; raised only by the user's explicit "Keep these"

export const UNGROUPED = -1;

const emptyAllowance = () => ({ window: null, groups: {} });

// Limit of one group: its override, or the default
export function groupLimitOf(config, groupId) {
    return config.groupLimits?.[groupId] ?? config.defaultLimit;
}

// capacity = max(limit, allowance ?? 0)
export function capacityOf(limit, allowance) {
    return Math.max(limit, allowance ?? 0);
}

function countByGroup(tabs) {
    const counts = new Map();
    for (const tab of tabs) {
        counts.set(tab.groupId, (counts.get(tab.groupId) ?? 0) + 1);
    }
    return counts;
}

function scope(count, limit, allowance) {
    const capacity = capacityOf(limit, allowance);
    return { count, limit, capacity, excess: Math.max(0, count - capacity) };
}

/**
 * Excess of one window and each of its groups.
 *
 * Returns { window, groups, over, totalExcess } where `window` and each entry of
 * `groups` (keyed by group ID, only groups that have tabs) is
 * { count, limit, capacity, excess }.
 *
 * `totalExcess` is the fewest tabs that must be closed to resolve the window:
 * closing tabs in different groups can't count twice toward a group's excess,
 * but they all count toward the window's, so it is max(window excess, sum of
 * group excesses).
 */
export function computeExcess(tabs, config, allowance) {
    const allow = allowance ?? emptyAllowance();
    const windowScope = scope(tabs.length, config.windowLimit, allow.window);

    const groups = {};
    let groupExcess = 0;
    for (const [groupId, count] of countByGroup(tabs)) {
        const g = scope(count, groupLimitOf(config, groupId), allow.groups?.[groupId]);
        groups[groupId] = g;
        groupExcess += g.excess;
    }

    const totalExcess = Math.max(windowScope.excess, groupExcess);
    return { window: windowScope, groups, over: totalExcess > 0, totalExcess };
}

// Would a tab in `groupId` fit every constraint, given the tabs already counted?
// (`tabs` must exclude the new tab itself and any other undecided tab.)
export function fitsAll(tabs, groupId, config, allowance) {
    const allow = allowance ?? emptyAllowance();
    const windowCapacity = capacityOf(config.windowLimit, allow.window);
    if (tabs.length + 1 > windowCapacity) {
        return false;
    }
    const inGroup = tabs.filter((tab) => tab.groupId === groupId).length;
    return inGroup + 1 <= capacityOf(groupLimitOf(config, groupId), allow.groups?.[groupId]);
}

/**
 * What to do with a newly created tab (plan §5, in this order).
 *
 *   input.tabs          real tabs of the window excluding the new tab and other undecided tabs
 *   input.groupId       the new tab's group
 *   input.config        see above
 *   input.allowance     see above
 *   input.startupMode   true until the user's first decision (D1) or startEnforcing (D4)
 *   input.hasOperation  the window already has an open operation
 *   input.pendingCount  tabs currently pending in the window
 *   input.cap           maximum pending tabs per window
 *
 * Returns { action, opKind }:
 *   action  'admit' | 'startup' | 'pending' | 'reject'
 *   opKind  kind of operation to open if the window has none: 'startup' | 'normal',
 *           or null when the tab is admitted or rejected. An existing operation
 *           keeps its own kind.
 */
export function decideCreation({ tabs, groupId, config, allowance, startupMode, hasOperation, pendingCount, cap }) {
    const fits = fitsAll(tabs, groupId, config, allowance);

    // 1. Startup mode: nothing is rejected and nothing becomes pending (R1).
    //    This comes before every other rule, even when an operation is open.
    if (startupMode) {
        return fits ? { action: 'admit', opKind: null } : { action: 'startup', opKind: 'startup' };
    }

    // 2. An open operation takes precedence, even if the tab would fit (C1).
    if (hasOperation) {
        return pendingCount < cap ? { action: 'pending', opKind: 'normal' } : { action: 'reject', opKind: null };
    }

    // 3. Fits every constraint.
    if (fits) {
        return { action: 'admit', opKind: null };
    }

    // 4. Otherwise a normal operation opens with the tab pending.
    return { action: 'pending', opKind: 'normal' };
}

/**
 * Would closing `selection` (tab IDs) leave the window with no violation, in the
 * window and in every group? Allowances are unchanged by a removal except that
 * they shrink, which never turns a satisfied constraint into a violated one.
 */
export function resolvesAll(tabs, selection, config, allowance) {
    const closing = new Set(selection);
    const remaining = tabs.filter((tab) => !closing.has(tab.id));
    return !computeExcess(remaining, config, allowance).over;
}

/**
 * Allowance after tabs were removed: never above the current count, and cleared
 * once at or below the limit. Never raises an allowance. `tabs` are the tabs
 * that remain. Returns a new allowance object, or null when nothing is left.
 */
export function shrinkAllowance(allowance, tabs, config) {
    if (!allowance) {
        return null;
    }

    const next = emptyAllowance();

    if (allowance.window != null) {
        const value = Math.min(allowance.window, tabs.length);
        if (value > config.windowLimit) {
            next.window = value;
        }
    }

    const counts = countByGroup(tabs);
    for (const [groupId, stored] of Object.entries(allowance.groups ?? {})) {
        const value = Math.min(stored, counts.get(Number(groupId)) ?? 0);
        if (value > groupLimitOf(config, groupId)) {
            next.groups[groupId] = value;
        }
    }

    return next.window === null && Object.keys(next.groups).length === 0 ? null : next;
}

/**
 * Allowance after the user's explicit "Keep these" (the only way to raise one).
 *
 * `eligibleIds` are the Keep-eligible tabs: every tab that is neither pending nor
 * moved (see `keepEligibleIds`). The window's allowance, and that of each group
 * that is over, becomes that scope's count of eligible tabs, but is never lowered
 * and is dropped when it would not exceed the limit.
 */
export function keepAllowance(allowance, tabs, eligibleIds, config) {
    const eligible = new Set(eligibleIds);
    const eligibleTabs = tabs.filter((tab) => eligible.has(tab.id));
    const excess = computeExcess(tabs, config, allowance);
    const next = { window: allowance?.window ?? null, groups: { ...(allowance?.groups ?? {}) } };

    if (excess.window.excess > 0) {
        const value = Math.max(next.window ?? 0, eligibleTabs.length);
        next.window = value > config.windowLimit ? value : next.window;
    }

    const eligibleByGroup = countByGroup(eligibleTabs);
    for (const [groupId, info] of Object.entries(excess.groups)) {
        if (info.excess > 0) {
            const value = Math.max(next.groups[groupId] ?? 0, eligibleByGroup.get(Number(groupId)) ?? 0);
            if (value > info.limit) {
                next.groups[groupId] = value;
            }
        }
    }

    return next.window === null && Object.keys(next.groups).length === 0 ? null : next;
}

// Keep-eligible tabs (plan §2, R2): everything that is neither pending nor moved.
// Ordinary and `startup` tabs qualify.
export function keepEligibleIds(tabs, { pending = [], moved = [] } = {}) {
    const excluded = new Set([...pending, ...moved]);
    return tabs.filter((tab) => !excluded.has(tab.id)).map((tab) => tab.id);
}
