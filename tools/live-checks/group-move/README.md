# Group-move event recorder (dev only, never packaged)

Records what Chrome reports when a tab group moves between windows, and around
the extension's own lifecycle (start-up, reload, enable). It serves the plan
for `fix/preserve-group-limits-on-window-move`. The results are written up in
`docs/review.md`, in two sections:

- "Group moves between windows: Chrome event record"
- "Extension lifecycle: Chrome event record" Nothing here is part of the extension (`tools/package.sh`
packages an explicit list of runtime files).

## Files

- `recorder/`: a throwaway MV3 extension.
  - `background.js` logs every `tabs.*`, `tabGroups.*` and `windows.onCreated/onRemoved` event, plus `runtime.onStartup` and `runtime.onInstalled`, to `chrome.storage.local`. At each worker start it also reports whether its marker in `storage.session` survived.
  - `driver.js` holds the scenarios, run from an extension page.
  - `label.html` names windows and carries the instructions for manual drags.
- `run.mjs`: starts Chrome with `--remote-debugging-pipe`, loads `recorder/` with `Extensions.loadUnpacked`, and takes commands on `127.0.0.1`.
- `analyze.mjs`: prints a trace or raw log as a timeline with short ID aliases.
- `compact.mjs`: turns a raw log into a compact trace for committing.
- `traces/`: compact traces of scenarios 1–6 and of the lifecycle run (`lifecycle.json`), committed. Each keeps every event and marker of the run, verbatim, and the driver's setup and result. It drops the per-event query snapshots, except the one taken at each worker start (what start-up code could see), and the setup events before the first marker. These are the recorded orders Phase B's tests replay.
- `results/`: raw logs, including snapshots. They are git-ignored and stay local.

## What is recorded

Each event is stored with:

- its IDs (tab, group, window)
- `t = performance.now()`, taken synchronously in the listener
- the worker instance ID and `performance.timeOrigin`

Use `abs = timeOrigin + t` to order events across worker restarts; sequence numbers restart with each worker instance. Each event also gets a snapshot of `tabGroups.query({})` and `tabs.query({})`, with the time each query was issued and resolved.

A snapshot is an **observation made after the event**: Chrome may change while the query is in flight. Only the event sequence proves an order.

**No URL or title is ever stored.** Tab lists are reduced to `{id, windowId, groupId}`. The window labels are test text shown in `label.html` pages and are never logged.

## Running

Use a throwaway profile, never a real one.

```sh
node tools/live-checks/group-move/run.mjs --profile <scratch dir> --port 47811 &
curl -s localhost:47811/call/reset          # close test windows, clear the log
curl -s localhost:47811/probe               # confirm the recorder logs events (do this before manual drags)
curl -s localhost:47811/call/s1             # scenarios: s1 s2 s3 s5 s7 s7restartSetup manualSetup
curl -s localhost:47811/save/s1             # write results/s1.json
node tools/live-checks/group-move/analyze.mjs tools/live-checks/group-move/results/s1.json
node tools/live-checks/group-move/compact.mjs tools/live-checks/group-move/results/s1.json tools/live-checks/group-move/traces/s1.json
```

Scenario 6 (a move while the worker is stopped) takes three steps:

1. `call/s6setup`
2. `stop-worker`, which uses `ServiceWorker.stopWorker` through the driver page's session
3. `call/s6move?arg=<setup JSON>`

`restart` quits Chrome and starts it again with `--restore-last-session`. Writing `session.restore_on_startup` into `Preferences` does not work, because Chrome resets it as a tampered tracked preference.

Manual drags (`call/manualSetup`) need headed Chrome and a person; CDP cannot drag the tab strip.

### Lifecycle runs

These routes are for checking the extension's lifecycle:

- `reload?how=button|runtime`
- `disable` and `enable`
- `restart`, which keeps the installed recorder, and `restart?enable=1` for a recorder disabled before the restart
- `state`
- `use?id=`
- `ext?expr=`, which evaluates in `chrome://extensions`

Every action is logged as a marker, and `save` merges the markers into the log.

**Install the recorder by hand for these runs.** A recorder loaded with `Extensions.loadUnpacked` is removed at a browser restart, and a reload leaves it disabled. So `onStartup` and a clean reload can only be seen with an installed copy:

1. Copy `recorder/` to a scratch folder. The copy gets its own extension ID.
2. In the test Chrome, open `chrome://extensions`, turn on Developer mode, and use Load unpacked on the copy. A person has to do this; scripted drops and uninstalls didn't work.
3. Find the copy's ID with `ext?expr=chrome.developerPrivate.getExtensionsInfo()...`, then `use?id=<it>`.

### Checking the extension itself

`--extension <a copy of extension/>` loads the extension under test next to the recorder. The `tl?expr=` route evaluates in its options page (opened in its own window, and reopened after a reset closes it), so limits are saved with the popup's own commands. `tl-stop-worker` stops its worker, and `tl-use?id=` switches to a copy installed by hand, which the reload and restart checks need. The driver's `setupMove` and `move` split scenarios 1, 2, 3, 5 and 6, so a limit can be set between setup and move. The stage 6 results are in `docs/review.md`, "Branch check in real Chrome".

## Known issue

In the first manual run, Chrome sat idle for several days and dropped the recorder's service-worker registration. The extension still showed as enabled, but no events were delivered and nothing was logged. That log is kept locally only.

Run `probe` immediately before handing over for manual drags, and restart on a fresh profile if it fails.
