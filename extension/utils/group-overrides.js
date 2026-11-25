// Custom group limits stored by group identity (plan: fix/preserve-group-limits-on-window-move).
// Pure: no chrome.* calls, so the background worker, the popup and Node tests share it.
//
// A custom limit for a tab group is stored as
//   groupOverride_<tag>_<groupId>: limit
// in chrome.storage.local. The key names no window, so the limit follows its group to
// any window and survives the source window closing. Chrome's group IDs are unique
// only within a browser session, so `tag` names the session: only entries under the
// current tag (groupLimitSession; a missing key counts as "0") ever apply.
//
// The limit for ungrouped tabs (groupLimit_<windowId>_ungrouped) and the window limit
// (tabLimit_<windowId>) stay with their window and are not handled here.
//
// Earlier versions stored a group's limit as groupLimit_<windowId>_<groupId>. Such a
// "legacy" key is never read as a limit. It is adopted once, at a worker start, only
// when the live browser proves it belongs to this session (planAdoption).

export const SESSION_TAG_KEY = 'groupLimitSession';
export const INITIAL_TAG = '0';
export const OVERRIDE_PREFIX = 'groupOverride_';

const OVERRIDE_KEY = /^groupOverride_([A-Za-z0-9-]{1,64})_(\d{1,15})$/;
const LEGACY_KEY = /^groupLimit_(\d{1,15})_(\d{1,15})$/;

export const isValidLimit = (value) => Number.isInteger(value) && value >= 1 && value <= 100;

// The current session tag in a storage.local snapshot
export function sessionTagOf(local) {
    const tag = local?.[SESSION_TAG_KEY];
    return typeof tag === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(tag) ? tag : INITIAL_TAG;
}

export function groupOverrideKey(tag, groupId) {
    return `${OVERRIDE_PREFIX}${tag}_${groupId}`;
}

// { tag, groupId } for a groupOverride_ key, or null
export function parseGroupOverrideKey(key) {
    const match = OVERRIDE_KEY.exec(key);
    return match ? { tag: match[1], groupId: Number(match[2]) } : null;
}

// { windowId, groupId } for a legacy groupLimit_<windowId>_<groupId> key, or null.
// groupLimit_<windowId>_ungrouped is not a legacy group key: it is still current.
export function parseLegacyGroupLimitKey(key) {
    const match = LEGACY_KEY.exec(key);
    return match ? { windowId: Number(match[1]), groupId: Number(match[2]) } : null;
}

// The custom limits that apply now: { [groupId]: limit } for valid entries under the
// current tag. Entries under any other tag, and legacy keys, never apply.
export function groupOverridesOf(local) {
    const tag = sessionTagOf(local);
    const limits = {};
    for (const [key, value] of Object.entries(local ?? {})) {
        const parsed = parseGroupOverrideKey(key);
        if (parsed && parsed.tag === tag && isValidLimit(value)) {
            limits[parsed.groupId] = value;
        }
    }
    return limits;
}

// What to do with legacy keys, given one storage.local snapshot and the live tabs
// ({ windowId, groupId }). Returns { writes: { key: limit }, removes: [key] }.
//   - Only while the tag is still the initial "0" (no browser start, reset or import
//     since the update) is anything adopted; otherwise legacy keys are only removed.
//   - A key is adopted only if its group is live IN ITS WINDOW: both IDs match, which
//     shows it was written in this session. Any other legacy key is removed unused.
//   - An existing tagged value is kept as it is: it is an earlier adoption or a newer
//     save from the popup.
export function planAdoption(local, tabs) {
    const writes = {};
    const removes = [];
    const adopting = sessionTagOf(local) === INITIAL_TAG;
    for (const [key, value] of Object.entries(local ?? {})) {
        const legacy = parseLegacyGroupLimitKey(key);
        if (!legacy) continue;
        removes.push(key);
        const live = tabs.some((tab) => tab.windowId === legacy.windowId && tab.groupId === legacy.groupId);
        const target = groupOverrideKey(INITIAL_TAG, legacy.groupId);
        if (adopting && live && isValidLimit(value) && !(target in local) && !(target in writes)) {
            writes[target] = value;
        }
    }
    return { writes, removes };
}
