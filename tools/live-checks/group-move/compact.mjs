#!/usr/bin/env node
// Writes a compact trace of a raw recorder log, for committing.
//
//   node tools/live-checks/group-move/compact.mjs results/s1.json traces/s1.json
//
// The raw logs in results/ stay local (git-ignored). A compact trace keeps what
// is needed to replay a move: every event and marker from the first marker
// (begin, setup done or manual setup done) to the 'end' marker, verbatim, and
// the driver's setup and result. It drops the per-event query snapshots (except
// the one taken at each worker start, which shows what start-up code could
// see), the driver's final snapshot, and the events of the setup before the
// first marker.
// analyze.mjs reads both formats.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
    console.error('usage: compact.mjs <raw log> <compact trace>');
    process.exit(2);
}

const raw = JSON.parse(readFileSync(input, 'utf8'));
const entries = Object.entries(raw.log);
const markers = entries.filter(([key]) => key.startsWith('m_')).sort(([, a], [, b]) => a.abs - b.abs);
if (markers.length === 0) throw new Error(`${input} has no markers`);
const from = markers[0][1].abs;
const end = markers.find(([, m]) => m.label === 'end')?.[1].abs ?? Infinity;

const inRange = (value) => value.abs >= from && value.abs <= end;
const kept = entries
    .filter(([key, value]) => (key.startsWith('m_') || (key.startsWith('e_') && !key.endsWith('_s'))) && inRange(value))
    .sort(([, a], [, b]) => a.abs - b.abs);
// The snapshot of each kept worker start, placed right after its event
for (let i = kept.length - 1; i >= 0; i--) {
    const [key, value] = kept[i];
    if (value.ev === 'worker-start' && raw.log[`${key}_s`]) kept.splice(i + 1, 0, [`${key}_s`, raw.log[`${key}_s`]]);
}

// Scenario runs return { scenario, setup, result, after }; manualSetup returns the setup itself
const driverResult =
    raw.driverResult && 'setup' in raw.driverResult
        ? { scenario: raw.driverResult.scenario, setup: raw.driverResult.setup, result: raw.driverResult.result }
        : raw.driverResult;

const head = {
    name: raw.name,
    chrome: raw.chrome,
    notes: raw.notes,
    compactedFrom: basename(input),
    dropped: 'query snapshots (e_*_s) except at worker starts, the driver\'s final snapshot, events before the first marker',
    driverResult
};

// One log entry per line, so diffs and greps stay readable
const headJson = JSON.stringify(head, null, 2);
const logLines = kept.map(([key, value]) => `    ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
const text = `${headJson.slice(0, -2)},\n  "log": {\n${logLines.join(',\n')}\n  }\n}\n`;
JSON.parse(text); // fail loudly rather than write a broken file

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, text);
console.log(`${output}: ${kept.length} entries`);
