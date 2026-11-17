# Implementation verification: remaining regressions

Reviewed on 2026-11-17 against commit
`b1f9673d2389658d0b7ae884941784e70db2ea8c` on `sh-dev`.
Source locations below refer to that revision.

**Verdict: do not sign off or merge yet.** All 182 existing tests pass, but
focused verification reproduced four remaining functional bugs. Two can close
tabs in circumstances the approved safeguards are intended to protect.

## Verification performed

- Confirmed the six reported implementation commits, the reviewed HEAD, and a
  clean working tree.
- Captured a consistent temporary copy of all 61 repository files. The original
  source hashes and HEAD were unchanged after verification.
- Ran `node --test tests/` in that copy with Node.js v26.13.1:
  **182 passed, 0 failed, 40 suites**.
- Ran four focused probes against the real background module with fresh module
  instances, the existing `tests/helpers/chrome-mock.js`, and delayed API calls
  where needed. Each probe asserted the observed failure.
- Checked the current runtime's storage and network paths. The old URL-storage
  and recreation path is gone; no telemetry path was found in the reviewed
  runtime. The findings below concern correctness, not a demonstrated external
  security exploit.

These are deterministic mock-based reproductions, **not new live Chrome
reproductions**. No application code or tests were changed during verification.
The steps below describe the executed probes so CC can turn them into regression
tests. Only this document is added by the subsequent write-up.

## Shared reproduction setup

Use `createChromeMock` and `flush` from `tests/helpers/chrome-mock.js`, and load
the actual `background.js` with a unique import query string for each scenario,
as in `tests/background.test.js`.

Unless specified otherwise:

- Window 1 initially contains ordinary tabs 1, 2, and 3; window 2 contains tab 10.
- Set `defaultTabLimit: 3`, with no window or group overrides.
- Start the service worker, drain events, and send `startEnforcing` so startup
  mode is off.
- Open pending tabs sequentially, draining events after each.
- Capture an operation through `getState`. Decision messages use its current
  `opId` and `revision`.

The delayed API hooks below are one-shot wrappers. They allow native tab state
and its event delivery to change while a background task is already running.
The central queue serializes the extension's handlers, but cannot prevent these
browser-side changes during an awaited API call.

## REG-01 — A moved tab can be automatically closed

**Locations:** `chrome-tab-limiter/background.js:360–383,403–407`;
movement handlers at `433–473`.

### Reproduction

1. Fill window 1's pending allowance with five tabs. It now has eight tabs:
   three ordinary and five pending.
2. Open one more tab in window 1.
3. In a one-shot wrapper around the creation handler's `storage.local.get`,
   move that new tab to window 2, which has room. Yield with `flush(1)` so the
   detach/attach events are delivered before the settings read returns.
4. Let the creation handler and queued events complete.

**Observed:** The moved tab is automatically closed in window 2.

**Expected:** Moving the tab must invoke the approved moved-tab protection.
It must remain open and be reconciled in its destination; it must not be rejected
using its former window's pending count.

### Cause and impact

`handleCreated` reads the tab at line 364, then awaits settings and state reads.
It continues using that cached `windowId` and group. The move events queue behind
the running creation task. The rejection branch calls `tabs.remove(tabId)` without
rechecking whether the tab has moved, so it closes the tab in its new location.
This violates `HUMAN-DECISION.md`'s no-automatic-closure rule for moved tabs.

**Fix direction:** Revalidate identity, current membership, and invalidating
events before an automatic rejection. A moved tab must leave the old admission
decision and enter movement reconciliation. Do not rely on the movement handler
running before the queued creation task finishes.

## REG-02 — Navigation during a close command bypasses stale-selection protection

**Locations:** `chrome-tab-limiter/background.js:630–653`, closure guard at
`588–605`, and navigation event wiring at `827–832`.

### Reproduction

1. Open one pending tab in window 1. Capture its operation and revision.
2. Send `closeSelected` selecting ordinary tab 1, which would resolve the excess.
3. While the command awaits `storage.local.get`, navigate tab 1 to a different
   synthetic URL, such as `https://new-unsaved-work.invalid/`.
4. Yield with `flush(1)` so `onUpdated.url` is delivered before the storage read
   returns. Confirm with an additional listener that the event was delivered
   before removal.
5. Let the command complete.

**Observed:** Tab 1 is closed at the new URL, and the command returns
`{success:true}`.

**Expected:** Navigation after the displayed selection must invalidate that
selection and require review again, as required by R3.

### Cause and impact

The navigation callback only queues `handleNavigated`. Its revision update waits
behind the active close command. `checkOperation` therefore compares against the
old stored revision and passes. `closeTabsGuarded` checks window/group membership
and the remaining tab count, but has no check for the intervening navigation.
The newly navigated page may contain work the user did not review when selecting
the old page for closure.

**Fix direction:** Track invalidating browser events as they arrive, not solely
when their queued state-update task runs. Recheck the selection's validity after
asynchronous boundaries and before destructive actions. Add a regression where
navigation is delivered during the command, rather than only before it is sent.
The fix must retain the no-persisted-URLs privacy requirement.

## REG-03 — Replacing an undecided tab can exclude it from enforcement indefinitely

**Locations:** `chrome-tab-limiter/background.js:835–840`, creation cleanup at
`360–366,419–420`, and counted-tab filtering at `98–101`.

### Reproduction

1. Start with window 1 at its limit of three and no pending tabs.
2. Open a new tab and pause its creation handler's `tabs.get(oldId)` before it
   returns the tab.
3. Use `harness.replaceTab(oldId, 2000)` and drain one round of events. This
   swaps the real tab ID and delivers `onReplaced` while the creation task waits.
4. Release the paused read. Looking up the old ID now fails, so its creation
   handler returns.
5. Query the operation, then open one more tab and query again.

**Observed:**

- The first excess was undetected: window 1 had four actual tabs, but `getState`
  reported no operation.
- After another creation, window 1 had **five actual tabs but only four in the
  reported operation**. Replacement tab 2000 still existed but was absent from
  the picker and enforcement counts.

**Expected:** The replacement must receive exactly one admission decision and
remain visible to counting and the picker under its new ID.

### Cause and impact

`onReplaced` transfers the old ID's membership in `undecided` to the new ID, but
the original creation task is still processing the old ID. Its `finally` block
deletes only the old ID. `handleReplaced` substitutes stored IDs but does not
complete admission of the newly undecided ID. The replacement stays in
`undecided`, and `readWindow` excludes it until worker restart clears that set.

**Fix direction:** Coordinate replacement with any in-flight admission task so
the new identity is decided and cleaned up exactly once. Do not leave the new ID
marked undecided without a task responsible for completing it. Test replacement
before the original creation decision, not only replacement of an already
classified pending tab.

## REG-04 — Raising a limit can still cause the next fitting tab to be rejected

**Locations:** `chrome-tab-limiter/background.js:369–383,416`;
operation lookup in `cmdGetState` at `726–745`.

### Reproduction

1. Fill window 1's pending allowance: eight tabs total, five pending, default
   limit 3.
2. Set `defaultTabLimit: 100`. With no overrides, this raises both the window
   and ungrouped limits. The eight existing tabs are now within every limit.
3. Call `getState`: it still returns an operation, but its `constraints` array
   is empty.
4. Open another tab in window 1 and drain events.

**Observed:** The new tab is closed, leaving eight tabs despite capacity 100.

**Expected:** The resolved operation should be cleared, and the new tab should
be admitted, leaving nine tabs.

### Cause and impact

Settings changes do not trigger background reconciliation. The creation handler
loads the new limits but passes the old `win.op` and five pending IDs into
`decideCreation`. Its open-operation branch precedes the fits check, so it
rejects the new tab. Only the subsequent `settleWindow` notices that the operation
has been resolved. The stale operation is also exposed to the popup with no
remaining violated constraints.

**Fix direction:** Reconcile operation state against current tabs and current
settings before deciding admission or accepting operation commands. Handle
relevant storage changes on the queue so views and badges also update promptly;
a storage-change listener alone does not replace validation at the decision.

## Acceptance and live-browser limitations

CC should add regressions for these four cases, fix them, and run the complete
suite before merge. The green 182-test suite does not currently cover the
interleavings and settings transition above.

The six implementation commits and clean source tree were confirmed. I did not
independently repeat CC's live Chrome experiments. Its own record in `REVIEW.md`
labels actual session restoration and the reload workflow as emulated, and its
live scripts were not retained in the repository. Those results must not be
presented as verification of the exact real-user restoration/reload workflows.
No live Chrome reproduction is claimed for REG-01 through REG-04.

This write-up records diagnosis and verification limits only. No fixes, test
changes, push, or merge are included.
