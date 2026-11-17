// Minimal in-memory stand-in for the chrome.* extension APIs used by Tab Limiter.
// Behaves closely enough to Chrome for unit tests: tabs live in a Map, events
// fire asynchronously after the call that caused them (like Chrome), and
// storage areas deep-copy values in and out.

export const EXTENSION_ID = 'test-extension-id';
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;

function createEvent() {
    const listeners = new Set();
    return {
        addListener: (fn) => listeners.add(fn),
        removeListener: (fn) => listeners.delete(fn),
        hasListeners: () => listeners.size > 0,
        // Test-only helpers
        _listeners: listeners,
        _fire: (...args) => {
            for (const fn of listeners) fn(...args);
        }
    };
}

function createStorageArea() {
    let data = {};
    const clone = (v) => structuredClone(v);

    return {
        async get(keys) {
            if (keys === null || keys === undefined) {
                return clone(data);
            }
            if (typeof keys === 'string') {
                keys = [keys];
            }
            if (Array.isArray(keys)) {
                const out = {};
                for (const k of keys) {
                    if (k in data) out[k] = clone(data[k]);
                }
                return out;
            }
            // Object form: keys with default values
            const out = {};
            for (const [k, def] of Object.entries(keys)) {
                out[k] = k in data ? clone(data[k]) : def;
            }
            return out;
        },
        async set(items) {
            for (const [k, v] of Object.entries(items)) {
                data[k] = clone(v);
            }
        },
        async remove(keys) {
            for (const k of [].concat(keys)) {
                delete data[k];
            }
        },
        async clear() {
            data = {};
        },
        // Test-only helper: synchronous snapshot
        _dump: () => clone(data)
    };
}

// Run queued event callbacks and the promise chains they start
export async function flush(rounds = 10) {
    for (let i = 0; i < rounds; i++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

/**
 * Create a fresh chrome mock.
 * @param {object} options
 * @param {Array<{id:number, windowId:number, groupId?:number, url?:string, title?:string}>} options.tabs
 */
export function createChromeMock({ tabs = [] } = {}) {
    const tabMap = new Map();
    let nextTabId = 1000;
    let nextWindowId = 5000;

    const addTab = (tab) => {
        const full = { groupId: -1, url: '', title: '', ...tab };
        tabMap.set(full.id, full);
        return full;
    };
    tabs.forEach(addTab);

    const events = {
        tabsOnCreated: createEvent(),
        tabsOnRemoved: createEvent(),
        tabsOnUpdated: createEvent(),
        tabsOnAttached: createEvent(),
        tabsOnDetached: createEvent(),
        tabsOnReplaced: createEvent(),
        windowsOnRemoved: createEvent(),
        runtimeOnMessage: createEvent(),
        runtimeOnConnect: createEvent()
    };

    // Chrome fires events asynchronously, after the API call resolves
    const fireLater = (event, ...args) => setImmediate(() => event._fire(...args));

    const calls = { openPopup: 0, windowsCreate: [], badge: '', removeAttempts: [] };

    // Failure injection. Set a predicate (tabId) => boolean, or a flag.
    const failures = { removeTab: null, openPopup: false };
    const groups = []; // [{ id, windowId, title, color }] returned by tabGroups.query

    const chrome = {
        runtime: {
            id: EXTENSION_ID,
            getURL: (path) => EXTENSION_ORIGIN + String(path).replace(/^\//, ''),
            onMessage: events.runtimeOnMessage
        },
        storage: {
            local: createStorageArea(),
            session: createStorageArea()
        },
        tabs: {
            async get(tabId) {
                const tab = tabMap.get(tabId);
                if (!tab) throw new Error(`No tab with id: ${tabId}.`);
                return structuredClone(tab);
            },
            async query({ windowId } = {}) {
                return [...tabMap.values()]
                    .filter((t) => windowId === undefined || t.windowId === windowId)
                    .map((t) => structuredClone(t));
            },
            async remove(tabIds) {
                for (const id of [].concat(tabIds)) {
                    calls.removeAttempts.push(id);
                    if (failures.removeTab && failures.removeTab(id)) {
                        throw new Error(`Injected failure removing tab ${id}.`);
                    }
                    const tab = tabMap.get(id);
                    if (!tab) throw new Error(`No tab with id: ${id}.`);
                    tabMap.delete(id);
                    // Closing a window's last tab closes the window
                    const windowEmptied = ![...tabMap.values()].some((t) => t.windowId === tab.windowId);
                    fireLater(events.tabsOnRemoved, id, { windowId: tab.windowId, isWindowClosing: windowEmptied });
                    if (windowEmptied) fireLater(events.windowsOnRemoved, tab.windowId);
                }
            },
            async create({ windowId, url = 'chrome://newtab/', active = true } = {}) {
                const tab = addTab({ id: nextTabId++, windowId, url, active });
                fireLater(events.tabsOnCreated, structuredClone(tab));
                return structuredClone(tab);
            },
            onCreated: events.tabsOnCreated,
            onRemoved: events.tabsOnRemoved,
            onUpdated: events.tabsOnUpdated,
            onAttached: events.tabsOnAttached,
            onDetached: events.tabsOnDetached,
            onReplaced: events.tabsOnReplaced
        },
        windows: {
            async getAll() {
                const ids = [...new Set([...tabMap.values()].map((t) => t.windowId))];
                return ids.map((id) => ({ id }));
            },
            async create(opts) {
                calls.windowsCreate.push(opts);
                return { id: nextWindowId++ };
            },
            onRemoved: events.windowsOnRemoved
        },
        tabGroups: {
            async query({ windowId } = {}) {
                return groups.filter((g) => windowId === undefined || g.windowId === windowId).map((g) => ({ ...g }));
            }
        },
        action: {
            async openPopup() {
                calls.openPopup++;
                if (failures.openPopup) throw new Error('Cannot open popup');
            },
            async setBadgeText({ text }) {
                calls.badge = text;
            },
            async setBadgeBackgroundColor() {}
        }
    };
    chrome.runtime.onConnect = events.runtimeOnConnect;

    // Test-only helpers, kept off the API surface the extension sees
    const harness = {
        chrome,
        calls,
        failures,
        groups,
        tabIds: (windowId) =>
            [...tabMap.values()].filter((t) => windowId === undefined || t.windowId === windowId).map((t) => t.id),
        findTab: (predicate) => [...tabMap.values()].find(predicate),
        // A tab that exists but whose onCreated nobody heard (e.g. the worker was down)
        addTabSilently(tab) {
            return addTab({ id: nextTabId++, ...tab }).id;
        },
        // Simulate the user opening a tab: Chrome adds it, then fires onCreated
        userOpensTab(tab) {
            const full = addTab({ id: nextTabId++, ...tab });
            fireLater(events.tabsOnCreated, structuredClone(full));
            return full.id;
        },
        // Drop all registered listeners (simulates the service worker being torn down).
        // chrome.storage.session survives, like a real worker restart.
        resetListeners() {
            Object.values(events).forEach((e) => e._listeners.clear());
        },
        // A browser restart or extension reload: listeners gone AND session storage cleared
        async restartBrowser() {
            Object.values(events).forEach((e) => e._listeners.clear());
            await chrome.storage.session.clear();
        },
        // Simulate the user dragging a tab to another window (Chrome fires detach, then attach)
        moveTab(tabId, newWindowId, { groupId = -1 } = {}) {
            const tab = tabMap.get(tabId);
            const oldWindowId = tab.windowId;
            tab.windowId = newWindowId;
            tab.groupId = groupId;
            fireLater(events.tabsOnDetached, tabId, { oldWindowId, oldPosition: 0 });
            fireLater(events.tabsOnAttached, tabId, { newWindowId, newPosition: 0 });
        },
        // Put a tab into a group (or -1 to ungroup it)
        setGroup(tabId, groupId) {
            const tab = tabMap.get(tabId);
            tab.groupId = groupId;
            fireLater(events.tabsOnUpdated, tabId, { groupId }, structuredClone(tab));
        },
        navigate(tabId, url) {
            const tab = tabMap.get(tabId);
            tab.url = url;
            fireLater(events.tabsOnUpdated, tabId, { url }, structuredClone(tab));
        },
        retitle(tabId, title) {
            const tab = tabMap.get(tabId);
            tab.title = title;
            fireLater(events.tabsOnUpdated, tabId, { title }, structuredClone(tab));
        },
        // Chrome swaps a tab for another one (e.g. prerender); the old ID disappears
        replaceTab(oldId, newId) {
            const tab = tabMap.get(oldId);
            tabMap.delete(oldId);
            tabMap.set(newId, { ...tab, id: newId });
            fireLater(events.tabsOnReplaced, newId, oldId);
        },
        // A popup connecting to the background; returns the messages the background pushed
        connectPort(sender = { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}popup.html` }) {
            const messages = [];
            const port = {
                name: 'popup',
                sender,
                onDisconnect: createEvent(),
                onMessage: createEvent(),
                postMessage: (m) => messages.push(structuredClone(m)),
                disconnect() {
                    port.onDisconnect._fire(port);
                }
            };
            events.runtimeOnConnect._fire(port);
            return { port, messages };
        },
        // Deliver a runtime message to the background listener(s) and await the response
        sendMessage(request, sender = { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}popup.html` }) {
            return new Promise((resolve, reject) => {
                const listeners = [...events.runtimeOnMessage._listeners];
                if (listeners.length === 0) {
                    reject(new Error('No onMessage listener registered'));
                    return;
                }
                for (const fn of listeners) fn(request, sender, resolve);
            });
        }
    };

    return harness;
}
