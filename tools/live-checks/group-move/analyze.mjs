#!/usr/bin/env node
// Prints a recorder log as a timeline.
//
//   node tools/live-checks/group-move/analyze.mjs traces/s1.json [--all]
//
// Reads a compact trace (traces/, committed) or a raw log (results/, local only).
//
// Times are milliseconds from the 'begin' (or first) marker, on the absolute
// clock (performance.timeOrigin + performance.now()), so entries from different
// worker instances line up. Without --all, only entries between the first
// marker and the 'end' marker are shown. IDs are shortened to aliases
// (W1, G1, T1, ...) in order of first appearance; the alias table is printed.
//
// Each event line shows what the snapshot queries returned. A snapshot is an
// observation made after the event: `groups@+x..+y` means tabGroups.query was
// issued x ms and resolved y ms after the event arrived.

import { readFileSync } from 'node:fs';

const [file, flag] = process.argv.slice(2);
const data = JSON.parse(readFileSync(file, 'utf8'));
const log = data.log;

const events = [];
const markers = [];
for (const [key, value] of Object.entries(log)) {
    if (key.startsWith('m_')) markers.push(value);
    else if (key.startsWith('e_') && !key.endsWith('_s')) events.push({ ...value, snap: log[`${key}_s`] ?? null });
}
markers.sort((a, b) => a.abs - b.abs);
events.sort((a, b) => a.abs - b.abs);

const begin = markers.find((m) => m.label === 'begin') ?? markers[0] ?? events[0];
const end = markers.find((m) => m.label === 'end');
const t0 = begin.abs;
const inRange = (abs) => flag === '--all' || (abs >= t0 - 1 && (!end || abs <= end.abs + 1));

const aliases = { W: new Map(), G: new Map(), T: new Map() };
const alias = (kind, id) => {
    if (id === undefined || id === null) return '-';
    if (id === -1) return 'none';
    const map = aliases[kind];
    if (!map.has(id)) map.set(id, `${kind}${map.size + 1}`);
    return map.get(id);
};

// Seed aliases from the setup recorded in the begin marker, so they read naturally
function seed(setup) {
    if (!setup || typeof setup !== 'object') return;
    for (const [key, value] of Object.entries(setup)) {
        if (key === 'windowId') alias('W', value);
        else if (key === 'groupId') alias('G', value);
        else if (key === 'tabIds' || key === 'groupTabIds' || key === 'subset') value.forEach((id) => alias('T', id));
        else if (value && typeof value === 'object') seed(value);
    }
}
seed(begin.setup);
for (const m of markers) seed(m.setup);

const ms = (abs) => (abs - t0).toFixed(1).padStart(8);
const instances = new Map();

function describe(e) {
    const parts = [];
    if (e.tabId !== undefined) parts.push(`tab ${alias('T', e.tabId)}`);
    if (e.addedTabId !== undefined) parts.push(`added ${alias('T', e.addedTabId)} removed ${alias('T', e.removedTabId)}`);
    if (e.groupId !== undefined) parts.push(`group ${alias('G', e.groupId)}`);
    for (const k of ['windowId', 'oldWindowId', 'newWindowId']) if (e[k] !== undefined) parts.push(`${k} ${alias('W', e[k])}`);
    if (e.isWindowClosing !== undefined) parts.push(`isWindowClosing ${e.isWindowClosing}`);
    if (e.type !== undefined) parts.push(`type ${e.type}`);
    if (e.reason !== undefined) parts.push(`reason ${e.reason}`);
    if (e.found !== undefined) parts.push(`session marker ${e.found === null ? 'absent' : `from ${e.found}`}`);
    if (e.error !== undefined) parts.push(`error ${e.error}`);
    return parts.join(', ');
}

// Groups the snapshot saw, and where the tabs of interest were
function describeSnap(e, interestingTabs) {
    const s = e.snap;
    if (!s) return '  (no snapshot)';
    if (s.error) return `  (snapshot error: ${s.error})`;
    const rel = (q) => `+${(q.issuedAbs - e.abs).toFixed(1)}..+${(q.resolvedAbs - e.abs).toFixed(1)}`;
    const groups = s.groups.list.map((g) => `${alias('G', g.id)}@${alias('W', g.windowId)}`).join(' ') || '(none)';
    const tabs = s.tabs.list
        .filter((t) => interestingTabs.has(t.id))
        .map((t) => `${alias('T', t.id)}:${alias('W', t.windowId)}/${alias('G', t.groupId)}`)
        .join(' ');
    return `  groups@${rel(s.groups)} [${groups}]  tabs@${rel(s.tabs)} [${tabs}]`;
}

const interesting = new Set();
const collect = (setup) => {
    if (!setup || typeof setup !== 'object') return;
    for (const [k, v] of Object.entries(setup)) {
        if (k === 'groupTabIds' || k === 'subset') v.forEach((id) => interesting.add(id));
        else if (v && typeof v === 'object') collect(v);
    }
};
for (const m of markers) collect(m.setup);
for (const e of events) {
    if (inRange(e.abs) && (e.ev === 'tabs.onCreated' || e.ev === 'tabs.onAttached' || e.ev === 'tabs.onDetached')) interesting.add(e.tabId);
}

console.log(`# ${data.name} (${data.chrome})`);
if (data.notes) console.log(`notes: ${data.notes}`);
const rows = [
    ...markers
        .filter((m) => inRange(m.abs))
        .map((m) => ({ abs: m.abs, line: `${ms(m.abs)}  ---- marker: ${m.label}${m.state ? ` ${JSON.stringify(m.state)}` : ''}` })),
    ...events
        .filter((e) => inRange(e.abs))
        .map((e) => {
            if (!instances.has(e.instance)) instances.set(e.instance, `I${instances.size + 1}`);
            const head = `${ms(e.abs)}  ${instances.get(e.instance)}#${String(e.seq).padEnd(4)} ${e.ev.padEnd(26)} ${describe(e)}`;
            // Compact traces (traces/) carry no snapshots
            return { abs: e.abs, line: e.snap ? `${head}\n${' '.repeat(10)}${describeSnap(e, interesting)}` : head };
        })
];
rows.sort((a, b) => a.abs - b.abs);
for (const r of rows) console.log(r.line);

console.log('\naliases:');
for (const [kind, map] of Object.entries(aliases)) {
    console.log(`  ${[...map.entries()].map(([id, a]) => `${a}=${id}`).join('  ')}`);
}
console.log(`instances: ${[...instances.entries()].map(([id, a]) => `${a}=${id}`).join('  ')}`);
