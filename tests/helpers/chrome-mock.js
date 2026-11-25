// Minimal in-memory stand-in for the chrome.* extension APIs used by Tab Limiter.
// Behaves closely enough to Chrome for unit tests: tabs live in a Map, events
// fire asynchronously after the call that caused them (like Chrome), and
// storage areas deep-copy values in and out.
//
// Service workers: each one runs inside its own async context (startWorker). A
// teardown (resetListeners, restartBrowser) ends it: its listeners are dropped,
// events scheduled before the teardown are never delivered, and any chrome.* call
// it makes afterwards, from a pending task or a timer, never resolves. So a
// torn-down worker stops where it was, as a stopped service worker does.

import { AsyncLocalStorage } from 'node:async_hooks';

const workerContext = new AsyncLocalStorage();

export const EXTENSION_ID = 'test-extension-id';

// A tab between onDetached and onAttached belongs to no window
const DETACHED = -2;
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;

// A listener runs in the context of the worker that registered it
function createEvent() {
    const listeners = new Map(); // fn -> the worker it was registered from
    return {
        addListener: (fn) => listeners.set(fn, workerContext.getStore()),
        removeListener: (fn) => listeners.delete(fn),
        hasListeners: () => listeners.size > 0,
        // Test-only helpers
        _listeners: listeners,
        _fire: (...args) => {
            for (const [fn, worker] of [...listeners]) {
                if (worker === undefined) fn(...args);
                else workerContext.run(worker, () => fn(...args));
            }
        }
    };
}

// `shouldFail(op, arg)`, if it returns true, makes that call reject (failure injection)
function createStorageArea(onChange = () => {}, shouldFail = () => false) {
    let data = {};
    const clone = (v) => structuredClone(v);
    const check = (op, arg) => {
        if (shouldFail(op, arg)) throw new Error(`Injected storage failure: ${op}`);
    };

    return {
        async get(keys) {
            check('get', keys);
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
            check('set', items);
            const changes = {};
            for (const [k, v] of Object.entries(items)) {
                changes[k] = { oldValue: data[k], newValue: clone(v) };
                data[k] = clone(v);
            }
            onChange(changes);
        },
        async remove(keys) {
            check('remove', keys);
            const changes = {};
            for (const k of [].concat(keys)) {
                if (k in data) changes[k] = { oldValue: data[k] };
                delete data[k];
            }
            onChange(changes);
        },
        async clear() {
            const changes = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { oldValue: v }]));
            data = {};
            onChange(changes);
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
    // Chrome hands out increasing IDs. Background admission relies on that (it
    // ignores tabs above the highest ID it has heard of), so new IDs always go
    // above every ID seen, including seeded and replayed ones.
    let nextTabId = 1000;
    let nextWindowId = 5000;
    let nextGroupId = 7000;
    const seeTab = (id) => (nextTabId = Math.max(nextTabId, id + 1));
    const seeWindow = (id) => (nextWindowId = Math.max(nextWindowId, id + 1));
    const seeGroup = (id) => {
        if (id > 0) nextGroupId = Math.max(nextGroupId, id + 1);
    };

    const addTab = (tab) => {
        const full = { groupId: -1, url: '', title: '', ...tab };
        tabMap.set(full.id, full);
        seeTab(full.id);
        if (full.windowId > 0) seeWindow(full.windowId);
        seeGroup(full.groupId);
        return full;
    };
    tabs.forEach(addTab);

    // The current service worker. A teardown moves on to the next generation. A
    // worker's context names its harness too, so a timer left over from another test
    // (another harness) is always stale.
    const owner = Symbol('harness');
    let generation = 0;
    let current = { owner, generation };
    const stale = () => {
        const worker = workerContext.getStore();
        return worker !== undefined && worker !== current;
    };
    const never = () => new Promise(() => {});

    const events = {
        tabsOnCreated: createEvent(),
        tabsOnRemoved: createEvent(),
        tabsOnUpdated: createEvent(),
        tabsOnAttached: createEvent(),
        tabsOnDetached: createEvent(),
        tabsOnReplaced: createEvent(),
        tabsOnMoved: createEvent(),
        windowsOnCreated: createEvent(),
        windowsOnRemoved: createEvent(),
        tabGroupsOnCreated: createEvent(),
        tabGroupsOnRemoved: createEvent(),
        tabGroupsOnUpdated: createEvent(),
        tabGroupsOnMoved: createEvent(),
        runtimeOnStartup: createEvent(),
        runtimeOnInstalled: createEvent(),
        runtimeOnMessage: createEvent(),
        runtimeOnConnect: createEvent(),
        storageOnChanged: createEvent()
    };

    // Chrome fires events asynchronously, after the API call resolves. An event
    // still queued at a teardown is dropped with the worker it was meant for.
    const fireLater = (event, ...args) => {
        const scheduledIn = current;
        setImmediate(() => {
            if (scheduledIn === current) event._fire(...args);
        });
    };

    const calls = { openPopup: 0, popupWindows: [], windowsCreate: [], badge: '', removeAttempts: [] };

    // Failure injection. Set a predicate, or a flag.
    //   removeTab(tabId), tabsQuery(queryInfo), tabGroupsQuery(queryInfo): true makes the call reject
    //   storage.local / storage.session (op, arg): op is 'get', 'set' or 'remove'
    const failures = { removeTab: null, openPopup: false, tabsQuery: null, tabGroupsQuery: null, storage: { local: null, session: null } };
    const storageFails = (area) => (op, arg) => Boolean(failures.storage[area]?.(op, arg));
    const groups = []; // [{ id, windowId, title, color }] returned by tabGroups.query

    const chrome = {
        runtime: {
            id: EXTENSION_ID,
            getURL: (path) => EXTENSION_ORIGIN + String(path).replace(/^\//, ''),
            onMessage: events.runtimeOnMessage,
            onStartup: events.runtimeOnStartup,
            onInstalled: events.runtimeOnInstalled
        },
        storage: {
            local: createStorageArea((changes) => fireLater(events.storageOnChanged, changes, 'local'), storageFails('local')),
            session: createStorageArea((changes) => fireLater(events.storageOnChanged, changes, 'session'), storageFails('session')),
            onChanged: events.storageOnChanged
        },
        tabs: {
            async get(tabId) {
                const tab = tabMap.get(tabId);
                if (!tab) throw new Error(`No tab with id: ${tabId}.`);
                return structuredClone(tab);
            },
            async query(queryInfo = {}) {
                if (failures.tabsQuery?.(queryInfo)) throw new Error('Injected failure in tabs.query');
                const { windowId } = queryInfo;
                return [...tabMap.values()]
                    .filter((t) => (windowId === undefined ? t.windowId !== DETACHED : t.windowId === windowId))
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
            onReplaced: events.tabsOnReplaced,
            onMoved: events.tabsOnMoved
        },
        windows: {
            async getAll() {
                const ids = [...new Set([...tabMap.values()].map((t) => t.windowId))].filter((id) => id !== DETACHED);
                return ids.map((id) => ({ id }));
            },
            async create(opts) {
                calls.windowsCreate.push(opts);
                return { id: nextWindowId++ };
            },
            onCreated: events.windowsOnCreated,
            onRemoved: events.windowsOnRemoved
        },
        tabGroups: {
            async query(queryInfo = {}) {
                if (failures.tabGroupsQuery?.(queryInfo)) throw new Error('Injected failure in tabGroups.query');
                const { windowId } = queryInfo;
                return groups.filter((g) => windowId === undefined || g.windowId === windowId).map((g) => ({ ...g }));
            },
            onCreated: events.tabGroupsOnCreated,
            onRemoved: events.tabGroupsOnRemoved,
            onUpdated: events.tabGroupsOnUpdated,
            onMoved: events.tabGroupsOnMoved
        },
        action: {
            async openPopup(options) {
                calls.openPopup++;
                calls.popupWindows.push(options?.windowId);
                if (failures.openPopup) throw new Error('Cannot open popup');
            },
            async setBadgeText({ text }) {
                calls.badge = text;
            },
            async setBadgeBackgroundColor() {}
        }
    };
    chrome.runtime.onConnect = events.runtimeOnConnect;

    // A call from a torn-down worker never resolves, and neither does a call it
    // made before the teardown. Methods are looked up when called, so pause()
    // and tests that replace a method still apply.
    for (const api of [chrome.runtime, chrome.storage.local, chrome.storage.session, chrome.tabs, chrome.windows, chrome.tabGroups, chrome.action]) {
        for (const [name, fn] of Object.entries(api)) {
            if (typeof fn !== 'function' || name.startsWith('_')) continue;
            const real = fn;
            api[name] = (...args) => {
                if (stale()) return never();
                const result = real(...args);
                return result instanceof Promise ? result.then((value) => (stale() ? never() : value)) : result;
            };
        }
    }

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
            if (tab.id !== undefined) return addTab(tab).id;
            return addTab({ id: nextTabId++, ...tab }).id;
        },
        // Simulate the user opening a tab: Chrome adds it, then fires onCreated
        userOpensTab(tab) {
            const full = addTab({ id: nextTabId++, ...tab });
            fireLater(events.tabsOnCreated, structuredClone(full));
            return full.id;
        },
        // Run a service worker's start-up code (an import of background.js) in a
        // context of its own, so a later teardown can end it
        startWorker(load) {
            globalThis.chrome = chrome;
            return workerContext.run(current, load);
        },
        // The service worker is torn down: its listeners are dropped, queued events
        // are dropped, and anything it was still doing stops. chrome.storage.session
        // survives, like a real worker restart.
        resetListeners() {
            generation += 1;
            current = { owner, generation };
            Object.values(events).forEach((e) => e._listeners.clear());
        },
        // A browser restart or extension reload: the worker is torn down AND
        // chrome.storage.session is cleared. The caller starts the next worker and
        // delivers runtime.onStartup or runtime.onInstalled (see the test helpers).
        async restartBrowser() {
            this.resetListeners();
            await chrome.storage.session.clear();
        },
        // After a browser restart Chrome gives restored windows, tabs and groups new
        // IDs. Returns the old -> new maps. New IDs never repeat one already seen, so a
        // restored group matches an old ID only when a test asks for it:
        // `groupIds: { [old]: new }` forces those (Chrome's group IDs are unique only
        // within a session, so a later session can reuse one).
        renumber({ groupIds = {} } = {}) {
            for (const group of groups) seeGroup(group.id); // tests may push groups directly
            const windows = new Map();
            const tabsMap = new Map();
            const groupsMap = new Map(Object.entries(groupIds).map(([from, to]) => [Number(from), to]));
            const newWindow = (id) => windows.get(id) ?? windows.set(id, nextWindowId++).get(id);
            const newGroup = (id) => (id === -1 ? -1 : groupsMap.get(id) ?? groupsMap.set(id, nextGroupId++).get(id));
            const old = [...tabMap.values()];
            tabMap.clear();
            for (const tab of old) {
                const id = nextTabId++;
                tabsMap.set(tab.id, id);
                addTab({ ...tab, id, windowId: newWindow(tab.windowId), groupId: newGroup(tab.groupId) });
            }
            for (const group of groups) {
                group.windowId = newWindow(group.windowId);
                group.id = newGroup(group.id);
            }
            return { windows, tabs: tabsMap, groups: groupsMap };
        },
        // Fire a browser-level event: harness.fire('runtimeOnStartup') or ('runtimeOnInstalled', { reason: 'update' })
        fire(name, ...args) {
            events[name]._fire(...args);
        },

        // Hold the next matching call to target[name] until resume() is called.
        // One-shot: the method is restored as soon as the call is caught.
        // `reached` resolves (with the call's arguments) when the call is held.
        // Never resuming models a worker that stopped in the middle of that call.
        pause(target, name, { nth = 1, when = () => true } = {}) {
            const real = target[name];
            let seen = 0;
            let resume;
            const resumed = new Promise((resolve) => (resume = resolve));
            let reachedWith;
            const reached = new Promise((resolve) => (reachedWith = resolve));
            target[name] = async (...args) => {
                if (when(...args) && ++seen === nth) {
                    target[name] = real;
                    reachedWith(args);
                    await resumed;
                }
                return real(...args);
            };
            return { reached, resume: () => resume() };
        },

        // Apply one recorded Chrome event (see tests/helpers/trace-replay.js): change
        // the browser state the way Chrome had, then fire the event synchronously,
        // unless `silent` (the worker never heard it).
        applyEvent(e, { silent = false } = {}) {
            const emit = (name, ...args) => {
                if (!silent) events[name]._fire(...args);
            };
            const groupOf = (id) => groups.find((g) => g.id === id);
            switch (e.ev) {
                case 'windows.onCreated':
                    seeWindow(e.windowId);
                    return emit('windowsOnCreated', { id: e.windowId, type: e.type ?? 'normal' });
                case 'windows.onRemoved':
                    return emit('windowsOnRemoved', e.windowId);
                case 'tabs.onCreated': {
                    const tab = addTab({ id: e.tabId, windowId: e.windowId, groupId: e.groupId ?? -1 });
                    return emit('tabsOnCreated', structuredClone(tab));
                }
                case 'tabs.onRemoved':
                    tabMap.delete(e.tabId);
                    return emit('tabsOnRemoved', e.tabId, { windowId: e.windowId, isWindowClosing: e.isWindowClosing });
                case 'tabs.onDetached':
                    tabMap.get(e.tabId).windowId = DETACHED;
                    return emit('tabsOnDetached', e.tabId, { oldWindowId: e.oldWindowId, oldPosition: e.oldPosition ?? 0 });
                case 'tabs.onAttached':
                    tabMap.get(e.tabId).windowId = e.newWindowId;
                    seeWindow(e.newWindowId);
                    return emit('tabsOnAttached', e.tabId, { newWindowId: e.newWindowId, newPosition: e.newPosition ?? 0 });
                case 'tabs.onMoved':
                    return emit('tabsOnMoved', e.tabId, { windowId: e.windowId, fromIndex: e.fromIndex, toIndex: e.toIndex });
                case 'tabs.onUpdated(groupId)': {
                    const tab = tabMap.get(e.tabId);
                    tab.groupId = e.groupId;
                    return emit('tabsOnUpdated', e.tabId, { groupId: e.groupId }, structuredClone(tab));
                }
                case 'tabs.onReplaced': {
                    const tab = tabMap.get(e.removedTabId);
                    tabMap.delete(e.removedTabId);
                    addTab({ ...tab, id: e.addedTabId });
                    return emit('tabsOnReplaced', e.addedTabId, e.removedTabId);
                }
                case 'tabGroups.onCreated':
                case 'tabGroups.onUpdated': {
                    seeGroup(e.groupId);
                    const group = groupOf(e.groupId) ?? groups[groups.push({ id: e.groupId, title: '', color: 'grey' }) - 1];
                    group.windowId = e.windowId;
                    return emit(e.ev === 'tabGroups.onCreated' ? 'tabGroupsOnCreated' : 'tabGroupsOnUpdated', { ...group });
                }
                case 'tabGroups.onRemoved': {
                    const at = groups.findIndex((g) => g.id === e.groupId);
                    const group = at >= 0 ? groups.splice(at, 1)[0] : { id: e.groupId, windowId: e.windowId };
                    return emit('tabGroupsOnRemoved', { ...group, windowId: e.windowId });
                }
                case 'tabGroups.onMoved':
                    return emit('tabGroupsOnMoved', { ...(groupOf(e.groupId) ?? { id: e.groupId }), windowId: e.windowId });
                case 'runtime.onStartup':
                    return emit('runtimeOnStartup');
                case 'runtime.onInstalled':
                    return emit('runtimeOnInstalled', { reason: e.reason, previousVersion: e.previousVersion ?? undefined });
                default:
                    throw new Error(`applyEvent: unknown event ${e.ev}`);
            }
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
            addTab({ ...tab, id: newId });
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
                if (!events.runtimeOnMessage.hasListeners()) {
                    reject(new Error('No onMessage listener registered'));
                    return;
                }
                events.runtimeOnMessage._fire(request, sender, resolve);
            });
        }
    };

    return harness;
}
