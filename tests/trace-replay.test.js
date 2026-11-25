// The test tooling for group moves: the chrome mock's new events and hooks, and the
// replay of event orders recorded in real Chrome (tools/live-checks/group-move/traces).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createChromeMock, flush } from './helpers/chrome-mock.js';
import { loadTrace, setupOf, initialTabs, initialGroups, scenarioSteps, replay } from './helpers/trace-replay.js';

function harnessFor(trace, part) {
    const harness = createChromeMock({ tabs: initialTabs(trace, part) });
    harness.groups.push(...initialGroups(trace, part));
    return harness;
}

// The name of every event the mock fires, in order
function listen(harness) {
    const heard = [];
    const names = {
        tabs: ['onCreated', 'onRemoved', 'onUpdated', 'onAttached', 'onDetached', 'onReplaced', 'onMoved'],
        tabGroups: ['onCreated', 'onRemoved', 'onUpdated', 'onMoved'],
        windows: ['onCreated', 'onRemoved']
    };
    for (const [api, events] of Object.entries(names)) {
        for (const name of events) {
            harness.chrome[api][name].addListener(() => heard.push(`${api}.${name}`));
        }
    }
    return heard;
}

const asFired = (step) => (step.ev === 'tabs.onUpdated(groupId)' ? 'tabs.onUpdated' : step.ev);

describe('trace replay', () => {
    // [trace, part, what the recording shows]; the destination is the group's last creation
    const wholeGroupMoves = [
        ['s1', undefined, 'API move to an existing window'],
        ['s2', undefined, 'API move to a new window'],
        ['s3', undefined, 'API move of the only group; the source closes'],
        ['s5', undefined, 'API move with tabs created around it'],
        ['s6', undefined, 'API move with the worker stopped'],
        ['s4', '4a', 'drag into an existing window, through a drag window'],
        ['s4', '4b', 'drag torn off into a new window'],
        ['s4', '4c', 'drag of the only group; the source closes']
    ];

    for (const [name, part, what] of wholeGroupMoves) {
        it(`${name}${part ? ` ${part}` : ''} (${what}): the group arrives whole, with its ID and tab IDs`, async () => {
            const trace = loadTrace(name);
            const setup = setupOf(trace, part);
            const steps = scenarioSteps(trace, part);
            const harness = harnessFor(trace, part);

            await replay(harness, steps);

            const destination = steps.filter((e) => e.ev === 'tabGroups.onCreated' && e.groupId === setup.groupId).at(-1).windowId;
            for (const id of setup.groupTabIds) {
                const tab = await harness.chrome.tabs.get(id);
                assert.equal(tab.windowId, destination, `tab ${id} is in the destination`);
                assert.equal(tab.groupId, setup.groupId, `tab ${id} kept the group ID`);
            }
            assert.deepEqual(
                harness.groups.filter((g) => g.id === setup.groupId).map((g) => g.windowId),
                [destination],
                'tabGroups.query reports the group in the destination only'
            );
        });
    }

    it('4a passes through a temporary drag window that then closes', async () => {
        const trace = loadTrace('s4');
        const setup = setupOf(trace, '4a');
        const steps = scenarioSteps(trace, '4a');
        const created = steps.filter((e) => e.ev === 'tabGroups.onCreated').map((e) => e.windowId);
        assert.equal(created.length, 2, 'two hops');
        assert.ok(![setup.A.windowId, setup.B.windowId].includes(created[0]), 'the first hop is into a new window');
        assert.equal(created[1], setup.B.windowId, 'the second hop is into the target');
        assert.equal(steps.at(-2).ev, 'windows.onRemoved');
        assert.equal(steps.at(-2).windowId, created[0], 'the drag window closes after the second hop');
    });

    it('4d: a subset dragged by a tab arrives ungrouped, and the group stays in the source', async () => {
        const trace = loadTrace('s4');
        const setup = setupOf(trace, '4d');
        const harness = harnessFor(trace, '4d');
        await replay(harness, scenarioSteps(trace, '4d'));

        for (const id of setup.subset) {
            const tab = await harness.chrome.tabs.get(id);
            assert.equal(tab.windowId, setup.B.windowId);
            assert.equal(tab.groupId, -1);
        }
        assert.deepEqual(harness.groups.find((g) => g.id === setup.groupId).windowId, setup.A.windowId);
    });

    it('fires the recorded events in the recorded order', async () => {
        const trace = loadTrace('s1');
        const steps = scenarioSteps(trace);
        const harness = harnessFor(trace);
        const heard = listen(harness);

        await replay(harness, steps);
        assert.deepEqual(heard, steps.map(asFired));
    });

    it('silent replay changes the state and fires nothing', async () => {
        const trace = loadTrace('s1');
        const setup = setupOf(trace);
        const harness = harnessFor(trace);
        const heard = listen(harness);

        await replay(harness, scenarioSteps(trace), { silent: true });
        assert.deepEqual(heard, []);
        assert.equal((await harness.chrome.tabs.get(setup.groupTabIds[0])).windowId, setup.B.windowId);
    });

    it('stops before a chosen step, and the rest can follow silently', async () => {
        const trace = loadTrace('s3');
        const setup = setupOf(trace);
        const steps = scenarioSteps(trace);
        const harness = harnessFor(trace);
        const heard = listen(harness);

        const { stoppedAt } = await replay(harness, steps, { stopBefore: (e) => e.ev === 'tabs.onAttached' });
        assert.equal(steps[stoppedAt].ev, 'tabs.onAttached');
        assert.equal(heard.length, stoppedAt);
        assert.equal((await harness.chrome.tabs.get(setup.groupTabIds[0])).windowId, -2, 'detached: in no window');
        assert.deepEqual(await harness.chrome.tabs.query({ windowId: setup.A.windowId }), [], 'the source holds nothing');

        await replay(harness, steps.slice(stoppedAt), { silent: true });
        assert.equal(heard.length, stoppedAt, 'nothing more was heard');
        assert.equal((await harness.chrome.tabs.get(setup.groupTabIds[0])).windowId, setup.B.windowId);
    });
});

describe('chrome mock hooks', () => {
    it('fires the lifecycle events', async () => {
        const harness = createChromeMock();
        const heard = [];
        harness.chrome.runtime.onStartup.addListener(() => heard.push('startup'));
        harness.chrome.runtime.onInstalled.addListener((details) => heard.push(details.reason));
        harness.fire('runtimeOnStartup');
        harness.applyEvent({ ev: 'runtime.onInstalled', reason: 'update' });
        assert.deepEqual(heard, ['startup', 'update']);
    });

    it('resetListeners drops the new events too', () => {
        const harness = createChromeMock();
        let heard = 0;
        harness.chrome.tabGroups.onCreated.addListener(() => heard++);
        harness.chrome.runtime.onStartup.addListener(() => heard++);
        harness.resetListeners();
        harness.fire('tabGroupsOnCreated', { id: 1, windowId: 1 });
        harness.fire('runtimeOnStartup');
        assert.equal(heard, 0);
    });

    it('pause holds one call until resumed, then restores the method', async () => {
        const harness = createChromeMock({ tabs: [{ id: 1, windowId: 1 }] });
        const held = harness.pause(harness.chrome.tabs, 'get', { nth: 2 });
        assert.equal((await harness.chrome.tabs.get(1)).id, 1, 'the first call passes');

        let done = false;
        const second = harness.chrome.tabs.get(1).then((tab) => {
            done = true;
            return tab;
        });
        assert.deepEqual(await held.reached, [1], 'reached with the call arguments');
        await flush();
        assert.equal(done, false, 'still held');

        held.resume();
        assert.equal((await second).id, 1);
        assert.equal((await harness.chrome.tabs.get(1)).id, 1, 'later calls pass');
    });

    it('pause can wait for a call that matches', async () => {
        const harness = createChromeMock();
        const held = harness.pause(harness.chrome.storage.session, 'set', { when: (items) => 'wanted' in items });
        await harness.chrome.storage.session.set({ other: 1 });
        const write = harness.chrome.storage.session.set({ wanted: 2 });
        await held.reached;
        assert.equal(harness.chrome.storage.session._dump().wanted, undefined, 'not written while held');
        held.resume();
        await write;
        assert.equal(harness.chrome.storage.session._dump().wanted, 2);
    });

    it('injects failures into tabs.query, tabGroups.query and each storage area', async () => {
        const harness = createChromeMock({ tabs: [{ id: 1, windowId: 1 }] });
        harness.failures.tabsQuery = () => true;
        harness.failures.tabGroupsQuery = (info) => info.windowId === 1;
        harness.failures.storage.session = (op) => op === 'set';

        await assert.rejects(harness.chrome.tabs.query({}));
        await assert.rejects(harness.chrome.tabGroups.query({ windowId: 1 }));
        assert.deepEqual(await harness.chrome.tabGroups.query({ windowId: 2 }), []);
        await assert.rejects(harness.chrome.storage.session.set({ a: 1 }));
        await harness.chrome.storage.local.set({ a: 1 });
        assert.deepEqual(await harness.chrome.storage.session.get(null), {}, 'reads still work');
    });

    it('a teardown drops an event queued for the old worker (Codex)', async () => {
        const harness = createChromeMock({ tabs: [{ id: 1, windowId: 1 }] });
        const heardByOld = [];
        const heardByNew = [];
        await harness.startWorker(async () => harness.chrome.tabs.onCreated.addListener((tab) => heardByOld.push(tab.id)));

        harness.userOpensTab({ windowId: 1 }); // onCreated is queued, not yet delivered
        harness.resetListeners();
        await harness.startWorker(async () => harness.chrome.tabs.onCreated.addListener((tab) => heardByNew.push(tab.id)));
        await flush();

        assert.deepEqual(heardByOld, []);
        assert.deepEqual(heardByNew, [], 'the new worker does not receive the old event');
        const later = harness.userOpensTab({ windowId: 1 });
        await flush();
        assert.deepEqual(heardByNew, [later], 'events after the teardown reach the new worker');
    });

    it('a torn-down worker stops where it was: its pending calls and timers never complete', async () => {
        const harness = createChromeMock({ tabs: [{ id: 1, windowId: 1 }] });
        const held = harness.pause(harness.chrome.storage.session, 'get');
        let afterGet = false;
        let timerWrote = false;
        await harness.startWorker(async () => {
            harness.chrome.storage.session.get('x').then(() => (afterGet = true));
            setTimeout(() => harness.chrome.storage.session.set({ fromTimer: 1 }).then(() => (timerWrote = true)), 0);
        });
        await held.reached;

        harness.resetListeners();
        held.resume();
        await new Promise((resolve) => setTimeout(resolve, 5));
        await flush();

        assert.equal(afterGet, false, 'a call made before the teardown never resolves');
        assert.equal(timerWrote, false, "the old worker's timer gets no answer");
        assert.deepEqual(harness.chrome.storage.session._dump(), {}, 'and writes nothing');
        await harness.chrome.storage.session.set({ fromTest: 1 });
        assert.deepEqual(harness.chrome.storage.session._dump(), { fromTest: 1 }, 'the test itself is unaffected');
    });

    it('new tab IDs go above every seeded and replayed ID (Codex)', async () => {
        const trace = loadTrace('s1');
        const harness = harnessFor(trace);
        await replay(harness, scenarioSteps(trace));
        const highest = Math.max(...(await harness.chrome.tabs.query({})).map((t) => t.id));
        const id = harness.userOpensTab({ windowId: setupOf(trace).B.windowId });
        assert.ok(id > highest, `${id} > ${highest}`);
        const created = await harness.chrome.tabs.create({ windowId: setupOf(trace).B.windowId });
        assert.ok(created.id > id);
    });

    it('renumber gives restored windows, tabs and groups new IDs', async () => {
        const harness = createChromeMock({ tabs: [{ id: 1, windowId: 1, groupId: 7 }, { id: 2, windowId: 1 }] });
        harness.groups.push({ id: 7, windowId: 1, title: 'g' });
        const map = harness.renumber();
        const tabs = await harness.chrome.tabs.query({});
        assert.deepEqual(tabs.map((t) => t.id).sort(), [map.tabs.get(1), map.tabs.get(2)].sort());
        assert.ok(![1, 2].includes(map.tabs.get(1)));
        const grouped = tabs.find((t) => t.id === map.tabs.get(1));
        assert.equal(grouped.groupId, map.groups.get(7));
        assert.equal(grouped.windowId, map.windows.get(1));
        assert.deepEqual(harness.groups.map((g) => [g.id, g.windowId]), [[map.groups.get(7), map.windows.get(1)]]);
    });

    it('renumber never maps a group to an ID already seen, unless asked (Codex)', () => {
        const harness = createChromeMock({ tabs: [{ id: 1, windowId: 1, groupId: 7000 }, { id: 2, windowId: 1, groupId: 7001 }] });
        harness.groups.push({ id: 7000, windowId: 1 }, { id: 7001, windowId: 1 }, { id: 9000, windowId: 1 });
        const map = harness.renumber();
        const seen = new Set([7000, 7001, 9000]);
        for (const [from, to] of map.groups) {
            assert.ok(!seen.has(to), `${from} -> ${to}`);
        }
        assert.ok(map.windows.get(1) !== 1 && map.tabs.get(1) !== 1);
    });

    it('renumber can make a restored group reuse an old ID on request', async () => {
        const harness = createChromeMock({ tabs: [{ id: 1, windowId: 1, groupId: 7 }, { id: 2, windowId: 1, groupId: 8 }] });
        harness.groups.push({ id: 7, windowId: 1 }, { id: 8, windowId: 1 });
        const map = harness.renumber({ groupIds: { 8: 7 } });
        assert.equal(map.groups.get(8), 7, 'the restored group gets the old ID 7');
        assert.notEqual(map.groups.get(7), 7);
        assert.equal((await harness.chrome.tabs.get(map.tabs.get(2))).groupId, 7);
    });
});
