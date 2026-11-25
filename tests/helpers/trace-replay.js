// Replays Chrome event orders recorded in real Chrome (tools/live-checks/group-move/traces)
// against the chrome mock, so tests run on the orders Chrome actually produced.
//
//   const trace = loadTrace('s1');
//   harness = createChromeMock({ tabs: initialTabs(trace) });
//   harness.groups.push(...initialGroups(trace));
//   const steps = scenarioSteps(trace);
//   await replay(harness, steps);
//
// IDs are the recorded ones. The traces hold IDs only, never URLs or titles.

import { readFileSync } from 'node:fs';
import { flush } from './chrome-mock.js';

const TRACES = new URL('../../tools/live-checks/group-move/traces/', import.meta.url);

// Entries that aren't Chrome events: the recorder's own bookkeeping
const NOT_EVENTS = new Set(['worker-start', 'session-marker']);

export function loadTrace(name) {
    return JSON.parse(readFileSync(new URL(`${name}.json`, TRACES), 'utf8'));
}

// The setup the driver recorded, for a scenario run or one manual drag (s4: '4a' ... '4d')
export function setupOf(trace, part) {
    const result = trace.driverResult ?? {};
    const setup = 'setup' in result ? result.setup : result;
    return part ? setup[part] : setup;
}

// Walk a setup for { windowId, tabIds } and { groupId, groupTabIds } pairs
function collect(setup, windows = [], groupings = []) {
    if (!setup || typeof setup !== 'object') return { windows, groupings };
    if (typeof setup.windowId === 'number' && Array.isArray(setup.tabIds)) {
        windows.push({ windowId: setup.windowId, tabIds: setup.tabIds });
    }
    if (typeof setup.groupId === 'number' && Array.isArray(setup.groupTabIds)) {
        groupings.push({ groupId: setup.groupId, tabIds: setup.groupTabIds });
    }
    for (const value of Object.values(setup)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) collect(value, windows, groupings);
    }
    return { windows, groupings };
}

// The tabs as they were before the scenario began
export function initialTabs(trace, part) {
    const { windows, groupings } = collect(setupOf(trace, part));
    const groupOf = new Map(groupings.flatMap(({ groupId, tabIds }) => tabIds.map((id) => [id, groupId])));
    return windows.flatMap(({ windowId, tabIds }) =>
        tabIds.map((id) => ({ id, windowId, groupId: groupOf.get(id) ?? -1, url: `https://tab-${id}.example/` }))
    );
}

// The groups as they were before the scenario began, for tabGroups.query
export function initialGroups(trace, part) {
    const tabs = initialTabs(trace, part);
    const { groupings } = collect(setupOf(trace, part));
    return groupings.map(({ groupId, tabIds }) => ({
        id: groupId,
        windowId: tabs.find((t) => t.id === tabIds[0]).windowId,
        title: `Group ${groupId}`,
        color: 'blue'
    }));
}

// Every recorded Chrome event, in order (absolute time, then sequence within a worker)
export function allSteps(trace) {
    return Object.entries(trace.log)
        .filter(([key, value]) => key.startsWith('e_') && !key.endsWith('_s') && !NOT_EVENTS.has(value.ev))
        .map(([, value]) => value)
        .sort((a, b) => a.abs - b.abs || a.seq - b.seq);
}

// The events of one scenario: those about its tabs and group, and about the windows
// those tabs passed through (including a temporary drag window), and tabs created in
// those windows during the run. Events before the begin marker (the driver's setup) and
// events in unrelated windows are left out.
export function scenarioSteps(trace, part) {
    const steps = allSteps(trace);
    const { windows, groupings } = collect(setupOf(trace, part));
    const tabs = new Set([...windows.flatMap((w) => w.tabIds), ...groupings.flatMap((g) => g.tabIds)]);
    const groupIds = new Set(groupings.map((g) => g.groupId));
    const windowIds = new Set(windows.map((w) => w.windowId));
    const begin = Object.values(trace.log).find((m) => m.label === 'begin');
    const inRun = steps.filter((e) => !begin || e.abs >= begin.abs);
    // First pass: every window the scenario's tabs pass through
    for (const e of inRun) {
        if (tabs.has(e.tabId) && e.newWindowId !== undefined) windowIds.add(e.newWindowId);
    }
    // Second pass, in order: tabs created in those windows during the run belong to it too
    // (a tab opened in the destination mid-move, the first tab of a new window)
    return inRun.filter((e) => {
        if (e.ev === 'tabs.onCreated' && windowIds.has(e.windowId)) tabs.add(e.tabId);
        return (
            tabs.has(e.tabId) ||
            groupIds.has(e.groupId) ||
            ((e.ev === 'windows.onCreated' || e.ev === 'windows.onRemoved') && windowIds.has(e.windowId))
        );
    });
}

// Replay steps against the mock.
//   flushBetween: flush rounds after each step (0 = deliver the whole burst first, as
//                 Chrome did, so tasks read a state that is already ahead of them)
//   stopBefore:   (step, index) => true to stop there; the result says where
//   silent:       change the state without firing anything (the worker never heard it)
export async function replay(harness, steps, { flushBetween = 0, stopBefore, silent = false } = {}) {
    for (let i = 0; i < steps.length; i++) {
        if (stopBefore?.(steps[i], i)) return { stoppedAt: i };
        harness.applyEvent(steps[i], { silent });
        if (flushBetween > 0) await flush(flushBetween);
    }
    await flush();
    return { stoppedAt: steps.length };
}
