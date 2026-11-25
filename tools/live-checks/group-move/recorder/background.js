// Event recorder for the group-move investigation (plan Phase A, and the
// Phase B startup check). Dev only.
//
// For every tab, tab-group and window event it stores, in chrome.storage.local:
//   e_<instance>_<seq>    the event: name, IDs, arrival time
//   e_<instance>_<seq>_s  a snapshot of tabGroups.query({}) and tabs.query({}),
//                         each with the time the query was issued and resolved
// Never a URL or a title.
//
// Timing: `t` is performance.now() taken synchronously when the listener runs.
// performance.now() restarts in every worker instance, so each entry also
// carries `abs` = performance.timeOrigin + t, which is comparable across
// instances (and with the driver page's markers). A snapshot is an observation
// made AFTER the event, while Chrome may still be changing: it shows what was
// true by the time each query resolved, not what was true at the event.

const instance = crypto.randomUUID().slice(0, 8);
const timeOrigin = performance.timeOrigin;
let seq = 0;

const put = (key, value) => chrome.storage.local.set({ [key]: value }).catch(() => {});

function record(ev, data) {
    const t = performance.now(); // first, before any other work
    const n = ++seq;
    const key = `e_${instance}_${String(n).padStart(6, '0')}`;
    put(key, { instance, timeOrigin, seq: n, t, abs: timeOrigin + t, ev, ...data });

    const snap = {};
    const groupsIssued = performance.now();
    const groups = chrome.tabGroups.query({}).then((list) => {
        const resolved = performance.now();
        snap.groups = {
            issued: groupsIssued,
            resolved,
            issuedAbs: timeOrigin + groupsIssued,
            resolvedAbs: timeOrigin + resolved,
            list: list.map((g) => ({ id: g.id, windowId: g.windowId }))
        };
    });
    const tabsIssued = performance.now();
    const tabs = chrome.tabs.query({}).then((list) => {
        const resolved = performance.now();
        snap.tabs = {
            issued: tabsIssued,
            resolved,
            issuedAbs: timeOrigin + tabsIssued,
            resolvedAbs: timeOrigin + resolved,
            list: list.map((tab) => ({ id: tab.id, windowId: tab.windowId, groupId: tab.groupId }))
        };
    });
    Promise.all([groups, tabs])
        .then(() => put(`${key}_s`, snap))
        .catch((error) => put(`${key}_s`, { error: String(error?.message ?? error) }));
}

record('worker-start', {});

// Lifecycle (plan Phase B, startup check). Registered first, synchronously, as
// Tab Limiter would. onStartup and onInstalled carry no IDs.
chrome.runtime.onStartup.addListener(() => record('runtime.onStartup', {}));
chrome.runtime.onInstalled.addListener((details) =>
    record('runtime.onInstalled', { reason: details.reason, previousVersion: details.previousVersion ?? null })
);

// Does storage.session survive? Each worker instance reports the marker it
// finds (the instance that wrote it, or null), then writes its own if absent.
chrome.storage.session
    .get('marker')
    .then(({ marker }) => {
        record('session-marker', { found: marker ?? null });
        return marker ? null : chrome.storage.session.set({ marker: instance });
    })
    .catch((error) => record('session-marker', { error: String(error?.message ?? error) }));

chrome.windows.onCreated.addListener((w) => record('windows.onCreated', { windowId: w.id, type: w.type }));
chrome.windows.onRemoved.addListener((windowId) => record('windows.onRemoved', { windowId }));

chrome.tabs.onCreated.addListener((tab) =>
    record('tabs.onCreated', { tabId: tab.id, windowId: tab.windowId, groupId: tab.groupId })
);
chrome.tabs.onRemoved.addListener((tabId, info) =>
    record('tabs.onRemoved', { tabId, windowId: info.windowId, isWindowClosing: info.isWindowClosing })
);
chrome.tabs.onDetached.addListener((tabId, info) =>
    record('tabs.onDetached', { tabId, oldWindowId: info.oldWindowId, oldPosition: info.oldPosition })
);
chrome.tabs.onAttached.addListener((tabId, info) =>
    record('tabs.onAttached', { tabId, newWindowId: info.newWindowId, newPosition: info.newPosition })
);
chrome.tabs.onMoved.addListener((tabId, info) =>
    record('tabs.onMoved', { tabId, windowId: info.windowId, fromIndex: info.fromIndex, toIndex: info.toIndex })
);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.groupId !== undefined) {
        record('tabs.onUpdated(groupId)', { tabId, groupId: changeInfo.groupId, windowId: tab?.windowId });
    }
});
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) =>
    record('tabs.onReplaced', { addedTabId, removedTabId })
);

for (const name of ['onCreated', 'onRemoved', 'onUpdated', 'onMoved']) {
    chrome.tabGroups[name].addListener((group) =>
        record(`tabGroups.${name}`, { groupId: group.id, windowId: group.windowId })
    );
}
