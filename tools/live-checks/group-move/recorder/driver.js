// Scenario driver, run inside an extension page so chrome.tabs / tabGroups /
// windows are available. run.mjs calls these functions over CDP. Nothing here
// is attached to the recorder's service worker, so the worker idles normally.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowAbs = () => performance.timeOrigin + performance.now();
const SETTLE_MS = 800;
const AFTER_MS = 2500;

function labelUrl(title, text = '') {
    return chrome.runtime.getURL(`label.html?title=${encodeURIComponent(title)}&text=${encodeURIComponent(text)}`);
}

// A marker in the same log as the recorder's events, on the same absolute clock
async function mark(label, extra = {}) {
    const abs = nowAbs();
    await chrome.storage.local.set({ [`m_${abs.toFixed(3)}`]: { abs, label, ...extra } });
}

async function makeWindow(tabs, opts = {}) {
    const urls = tabs.map((t) => (typeof t === 'string' ? labelUrl(t) : labelUrl(t.title, t.text)));
    const w = await chrome.windows.create({ url: urls, focused: false, ...opts });
    const list = await chrome.tabs.query({ windowId: w.id });
    return { windowId: w.id, tabIds: list.sort((a, b) => a.index - b.index).map((t) => t.id) };
}

async function makeGroup(windowId, tabIds, title, color = 'blue') {
    const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
    await chrome.tabGroups.update(groupId, { title, color });
    return groupId;
}

async function snapshot() {
    return {
        groups: (await chrome.tabGroups.query({})).map((g) => ({ id: g.id, windowId: g.windowId })),
        tabs: (await chrome.tabs.query({})).map((t) => ({ id: t.id, windowId: t.windowId, groupId: t.groupId }))
    };
}

async function driverWindowId() {
    return (await chrome.tabs.getCurrent()).windowId;
}

// Close every window except the driver's, then clear the log
async function reset() {
    const keep = await driverWindowId();
    for (const w of await chrome.windows.getAll()) {
        if (w.id !== keep) {
            try {
                await chrome.windows.remove(w.id);
            } catch {
                // already gone
            }
        }
    }
    await sleep(1500);
    await chrome.storage.local.clear();
    return { driverWindow: keep };
}

async function dump() {
    return chrome.storage.local.get(null);
}

// A window holding a 3-tab group plus one ungrouped tab, and a destination window
async function sourceAndDestination(name, { ungrouped = 1, grouped = 3, destTabs = 2 } = {}) {
    const titles = [];
    for (let i = 0; i < grouped; i++) titles.push(`${name} source, grouped ${i + 1}`);
    for (let i = 0; i < ungrouped; i++) titles.push(`${name} source, ungrouped ${i + 1}`);
    const A = await makeWindow(titles);
    const groupId = await makeGroup(A.windowId, A.tabIds.slice(0, grouped), name);
    const destTitles = [];
    for (let i = 0; i < destTabs; i++) destTitles.push(`${name} destination ${i + 1}`);
    const B = destTabs > 0 ? await makeWindow(destTitles) : null;
    return { A, B, groupId, groupTabIds: A.tabIds.slice(0, grouped) };
}

async function runMove(scenario, setup, act) {
    await sleep(SETTLE_MS);
    await mark('begin', { scenario, setup });
    const result = await act();
    await sleep(AFTER_MS);
    await mark('end', { scenario });
    return { scenario, setup, result, after: await snapshot() };
}

const S = {};

// 1. tabGroups.move to an existing window
S.s1 = async () => {
    const setup = await sourceAndDestination('s1');
    return runMove('s1 api move to existing window', setup, async () => {
        const returned = await chrome.tabGroups.move(setup.groupId, { windowId: setup.B.windowId, index: -1 });
        return { returned: { id: returned?.id, windowId: returned?.windowId } };
    });
};

// 2. windows.create, then tabGroups.move into the new window
S.s2 = async () => {
    const setup = await sourceAndDestination('s2', { destTabs: 0 });
    return runMove('s2 api move to new window', setup, async () => {
        const C = await chrome.windows.create({ url: labelUrl('s2 new window'), focused: false });
        const returned = await chrome.tabGroups.move(setup.groupId, { windowId: C.id, index: -1 });
        return { newWindowId: C.id, returned: { id: returned?.id, windowId: returned?.windowId } };
    });
};

// 3. Moving a window's only group: the source window closes
S.s3 = async () => {
    const setup = await sourceAndDestination('s3', { ungrouped: 0, grouped: 3, destTabs: 1 });
    return runMove('s3 api move of the only group (source closes)', setup, async () => {
        const returned = await chrome.tabGroups.move(setup.groupId, { windowId: setup.B.windowId, index: -1 });
        return { returned: { id: returned?.id, windowId: returned?.windowId } };
    });
};

// 5. New tabs created in the destination during and just after a move
S.s5 = async () => {
    const setup = await sourceAndDestination('s5');
    return runMove('s5 creations in the destination around a move', setup, async () => {
        const moving = chrome.tabGroups.move(setup.groupId, { windowId: setup.B.windowId, index: -1 });
        const during = chrome.tabs.create({ windowId: setup.B.windowId, url: labelUrl('s5 created during move'), active: false });
        const [returned, duringTab] = await Promise.all([moving, during]);
        const afterTab = await chrome.tabs.create({ windowId: setup.B.windowId, url: labelUrl('s5 created after move'), active: false });
        const intoGroup = await chrome.tabs.create({ windowId: setup.B.windowId, url: labelUrl('s5 added to moved group'), active: false });
        const regroup = await chrome.tabs.group({ groupId: returned.id, tabIds: [intoGroup.id] });
        return {
            returned: { id: returned?.id, windowId: returned?.windowId },
            createdDuring: { id: duringTab.id, windowId: duringTab.windowId, groupId: duringTab.groupId },
            createdAfter: { id: afterTab.id, windowId: afterTab.windowId, groupId: afterTab.groupId },
            addedToMovedGroup: { id: intoGroup.id, groupIdReturned: regroup }
        };
    });
};

// 6. Worker stopped: set up first, run.mjs stops the worker, then move
S.s6setup = async () => {
    const setup = await sourceAndDestination('s6');
    await sleep(SETTLE_MS);
    await mark('setup done', { scenario: 's6 move while worker stopped', setup });
    return setup;
};
S.s6move = async (setup) =>
    runMove('s6 move while worker stopped', setup, async () => {
        const returned = await chrome.tabGroups.move(setup.groupId, { windowId: setup.B.windowId, index: -1 });
        return { returned: { id: returned?.id, windowId: returned?.windowId } };
    });

// Split versions of scenarios 1-3, 5 and 6 for checking the extension under test:
// set up, let run.mjs set a group limit through the extension, then move.
//   S.setupMove('s1')                 A: a 3-tab group + 1 tab; B: 2 tabs
//   S.setupMove('s3', { ungrouped: 0, destTabs: 1 })
//   S.move(setup, { to: 'B' | 'new', createDuring: true })
S.setupMove = async (name, opts = {}) => {
    const setup = await sourceAndDestination(name, opts);
    await sleep(SETTLE_MS);
    await mark('setup done', { scenario: name, setup });
    return setup;
};
S.move = async (setup, { to = 'B', createDuring = false } = {}) =>
    runMove(`move to ${to}`, setup, async () => {
        let windowId = setup.B?.windowId;
        if (to === 'new') {
            windowId = (await chrome.windows.create({ url: labelUrl('new window'), focused: false })).id;
        }
        const moving = chrome.tabGroups.move(setup.groupId, { windowId, index: -1 });
        const during = createDuring
            ? chrome.tabs.create({ windowId, url: labelUrl('created during move'), active: false })
            : null;
        const [returned, duringTab] = await Promise.all([moving, during]);
        return { windowId, returned: { id: returned?.id, windowId: returned?.windowId }, createdDuring: duringTab?.id ?? null };
    });

// 7. ID allocation within the session: create and ungroup repeatedly
S.s7 = async () => {
    const A = await makeWindow(['s7 tab 1', 's7 tab 2', 's7 tab 3']);
    const B = await makeWindow(['s7 other window tab 1', 's7 other window tab 2']);
    await sleep(SETTLE_MS);
    await mark('begin', { scenario: 's7 id allocation', setup: { A, B } });
    const ids = [];
    for (let i = 0; i < 8; i++) {
        const windowSide = i % 2 === 0 ? A : B;
        const g = await chrome.tabs.group({ tabIds: [windowSide.tabIds[0]], createProperties: { windowId: windowSide.windowId } });
        ids.push({ round: i, windowId: windowSide.windowId, groupId: g });
        await chrome.tabs.ungroup(windowSide.tabIds[0]);
    }
    await sleep(AFTER_MS);
    await mark('end', { scenario: 's7 id allocation' });
    return { ids, windows: { A: A.windowId, B: B.windowId }, tabIds: { A: A.tabIds, B: B.tabIds } };
};

// 7b. Before a browser restart: leave a labelled group open for session restore
S.s7restartSetup = async () => {
    const A = await makeWindow(['s7r tab 1', 's7r tab 2', 's7r tab 3']);
    const groupId = await makeGroup(A.windowId, A.tabIds.slice(0, 2), 's7r restored group', 'green');
    await sleep(SETTLE_MS);
    return { windowId: A.windowId, tabIds: A.tabIds, groupId, snapshot: await snapshot() };
};

// Groups with their titles, for matching restored groups (titles here are test labels)
S.groupsWithTitles = async () =>
    (await chrome.tabGroups.query({})).map((g) => ({ id: g.id, windowId: g.windowId, title: g.title }));

// 4. Manual drags: lay out labelled windows; the owner performs the drags
S.manualSetup = async () => {
    const W = screen.availWidth;
    const H = screen.availHeight;
    const colW = Math.floor(W / 4);
    const rowH = Math.floor(H / 2);
    const at = (col, row) => ({ left: screen.availLeft + col * colW, top: screen.availTop + row * rowH, width: colW, height: rowH });

    const out = {};
    // 4a: drag the group header into another window
    {
        const A = await makeWindow(
            [
                { title: '4a SOURCE', text: 'Drag the group "4a" by its header into the window "4a TARGET" (below).' },
                '4a source grouped 2',
                '4a source grouped 3',
                '4a source ungrouped'
            ],
            at(0, 0)
        );
        const g = await makeGroup(A.windowId, A.tabIds.slice(0, 3), '4a', 'blue');
        const B = await makeWindow([{ title: '4a TARGET', text: 'Drop group "4a" into this window\'s tab strip.' }, '4a target 2'], at(0, 1));
        out['4a'] = { A, B, groupId: g, groupTabIds: A.tabIds.slice(0, 3) };
    }
    // 4b: tear the group off into a new window
    {
        const A = await makeWindow(
            [
                { title: '4b SOURCE', text: 'Drag the group "4b" by its header OUT of this window onto empty desktop space, so it becomes a new window.' },
                '4b source grouped 2',
                '4b source grouped 3',
                '4b source ungrouped'
            ],
            at(1, 0)
        );
        const g = await makeGroup(A.windowId, A.tabIds.slice(0, 3), '4b', 'red');
        out['4b'] = { A, groupId: g, groupTabIds: A.tabIds.slice(0, 3) };
    }
    // 4c: drag a window's last (only) group out, into another window
    {
        const A = await makeWindow(
            [{ title: '4c SOURCE', text: 'This window holds only group "4c". Drag the group by its header into "4c TARGET" (below). This window should close.' }, '4c source grouped 2'],
            at(2, 0)
        );
        const g = await makeGroup(A.windowId, A.tabIds, '4c', 'green');
        const B = await makeWindow([{ title: '4c TARGET', text: 'Drop group "4c" into this window\'s tab strip.' }], at(2, 1));
        out['4c'] = { A, B, groupId: g, groupTabIds: A.tabIds };
    }
    // 4d: drag a subset of a group's tabs to another window
    {
        const A = await makeWindow(
            [
                { title: '4d SOURCE', text: 'Cmd-click to select the tabs "4d source grouped 3" and "4d source grouped 4" (only those two), then drag them by a tab (not the header) into "4d TARGET" (below).' },
                '4d source grouped 2',
                '4d source grouped 3',
                '4d source grouped 4',
                '4d source ungrouped'
            ],
            at(3, 0)
        );
        const g = await makeGroup(A.windowId, A.tabIds.slice(0, 4), '4d', 'purple');
        const B = await makeWindow([{ title: '4d TARGET', text: 'Drop the two dragged "4d" tabs into this window\'s tab strip.' }], at(3, 1));
        out['4d'] = { A, B, groupId: g, groupTabIds: A.tabIds.slice(0, 4), subset: A.tabIds.slice(2, 4) };
    }
    await sleep(SETTLE_MS);
    await mark('manual setup done', { setup: out });
    return out;
};

S.mark = mark;
S.snapshot = snapshot;
S.reset = reset;
S.dump = dump;

globalThis.S = S;
