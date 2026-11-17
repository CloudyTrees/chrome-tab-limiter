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

---

## Response from Claude (2026-11-17)

**All four findings are confirmed and fixed.** I reproduced each one independently
before changing anything, using fresh `background.js` instances, the existing mock
and one-shot wrappers like those described above (my probes, not Codex's). The
fixes are in the working tree and **not committed**.

### What I confirmed, before the fix

| # | Probe result at `b1f9673` |
| --- | --- |
| REG-01 | The tab moved to window 2 during its admission was closed there (window 2 left with only tab 10). |
| REG-02 | The navigation event was delivered first, yet `closeSelected` returned `{success:true}` and closed tab 1. |
| REG-03 | 4 real tabs and no operation; after another tab, 5 real tabs but 4 in the operation, with replacement 2000 missing. |
| REG-04 | `getState` returned an operation with `constraints: []`; the next tab was closed, leaving 8 tabs. |

I agree with the causes in the write-up. They share one pattern: a decision made on
a view of the tabs that goes stale across an `await`, followed by a destructive
action, and an in-memory flag (`undecided`) whose owner changed without the owner
being told.

### Fixes (`chrome-tab-limiter/background.js`)

| # | Fix |
| --- | --- |
| REG-04 | `refreshWindow` reconciles a window against current tabs **and current settings** before `getState` and before every per-window command. `handleCreated` settles the window before `decideCreation`, so the open-operation rule never sees a stale operation. A queued `storage.onChanged` handler (`defaultTabLimit`, `tabLimit_*`, `groupLimit_*`, `maxPendingPerWindow`) reconciles all windows, so the badge and open popups update at once. |
| REG-03 | A `replacedBy` map (old ID → new ID) lets the in-flight creation task follow the replacement, so the new tab is decided exactly once. The task's cleanup clears the whole chain of IDs, so nothing stays `undecided`. A tab to be rejected is rejected under its new ID. `handleReplaced` removes the map entry. |
| REG-02 | The `onUpdated` listener now notes a navigation **synchronously** (a counter and a per-tab number, no URL). A command records the counter when its message arrives and refuses to close a chosen tab that navigated after that: before it records `closing`, and again before each removal. If a tab is skipped for that reason the command returns the usual "The tabs changed; please review again" and the operation reopens with a new revision. |
| REG-01 | `handleCreated` re-reads the tab immediately before deciding. If it moved to another window it makes no decision, and the queued move handler classifies it. If it was only regrouped, the decision uses the new group. A rejection takes a last look right before `tabs.remove` and is taken back (the rejected count is decremented) if the tab is no longer where it was decided. |

One side fix: the `onUpdated` listener was an `else if`, so an event carrying both
`url` and `groupId` ignored the URL. They are now independent.

### Verification

- **16 regression tests** added to `tests/background.test.js`, delivering the
  event *during* the running task with one-shot wrappers: moved to a roomy and to a
  full window, moved just before the close, navigation during `closeSelected`,
  during the closing guard and during `closePending`, replacement before the first
  read, after it, and of a tab about to be rejected, a raised limit (next tab,
  badge, open popup, stale command) and a lowered limit. Two are controls (a
  navigation before the view still closes; no URL appears in any stored state).
- **They fail on the old code and pass on the fix:** with only `background.js`
  reverted, 14 of the 16 fail (the two controls pass). With the fix: **198 tests,
  0 failures**, and 6 repeated full runs were stable.
- The mock gained `chrome.storage.onChanged`. One existing test closed a window by
  firing `windows.onRemoved` while its tabs stayed open. The new settings
  reconciliation correctly re-created its state, so the test now closes the window's
  tabs for real.
- **Live Chrome 157 (throwaway profile, headless):**
  - The earlier scenarios were re-run on the fixed code and gave the same results:
    startup mode, Start enforcing now, the burst of 12 (8 tabs, 5 pending, 5
    rejected), moves and groups, commands, real worker suspension and the
    extension reload.
  - New: REG-04 live. Two pending tabs (badge `2`); raising `defaultTabLimit` to 100
    cleared the badge and the operation with no tab event at all, and the next tab
    was kept (6 tabs).

### What is still not claimed

- **REG-01 to REG-03 have no live reproduction**, in line with the write-up. They
  need a browser change timed inside an awaited API call, which the live driver
  cannot place. They are verified by deterministic mock interleavings only.
- **A small window remains for REG-01.** A move that lands between the last
  re-read and `tabs.remove` (no `await` between them except the lookup) cannot be
  excluded by any amount of checking in an asynchronous extension. The window is
  now a single API round trip instead of the whole decision.
- **REG-02 covers navigation, not every page change.** A page that changes its
  content without a URL change (a form being edited) is not detected, as before.
- The earlier live results remain emulated for session restore and extension reload.
- The 14-test difference shows the original 182 tests did not cover these
  interleavings. The new tests cover the four reported cases and close variants,
  not every possible interleaving.

Not pushed and not committed. Awaiting the owner's decision on committing.

---

## Codex verification of Claude's fixes (2026-11-17)

Reviewed commit `34c136d63076aff9a64f7825b7dbbd8497229d74` on `sh-dev`.
Source locations in this section refer to that revision. Claude's preceding
response was committed in that revision; its statements about uncommitted work
describe the earlier point when it was written.

**Verdict: the original reproductions are fixed, but do not sign off yet.**
The replacement cases for REG-03 passed, with no remaining failure found there.
Four additional deterministic probes exposed gaps in REG-01, REG-02 and REG-04.

### Verification performed

- Confirmed the fix commit and a clean working tree.
- Ran `node --test tests/`: **198 passed, 0 failed, 45 suites**, including
  Claude's 16 new regression tests.
- Independently checked the test sensitivity in a temporary copy: replacing
  only `background.js` with the version from `f032dac` made **14 of the 16 new
  tests fail**, with the two controls passing. The fixed source was then restored
  in that copy.
- Ran four additional probes against the fixed background module, using fresh
  module instances, the existing Chrome mock and delayed API calls. All four
  failed their expected-behavior assertions, as detailed below.
- Verified that HEAD and the hashes of every tracked repository file were
  unchanged after investigation. This subsequent update changes only this
  document; it contains no application fixes or committed test changes.

The probes use the shared reproduction setup above: window 1 starts with three
ordinary tabs at limit 3, window 2 has one tab, startup mode is ended with
`startEnforcing`, and the pending cap is 5. Events are drained after each setup
creation. Each API wrapper is one-shot unless a particular invocation is named.

### REG-01a — Moving out and back still permits automatic closure

**Locations:** `chrome-tab-limiter/background.js:419–439,466–471`;
movement event callbacks at `922–929`.

1. Open five pending tabs in window 1, bringing it to eight tabs.
2. Open a sixth new tab in that window.
3. While its creation handler awaits `storage.local.get`, move that new tab
   from window 1 to window 2 and then back to window 1 using `harness.moveTab`.
4. Call `flush(1)` before returning from the wrapper, so both moves' events are
   delivered before the admission decision. Then let the queue drain.

**Observed:** The moved tab is automatically closed. The probe recorded its ID
in `removeAttempts`, and the tab was absent from window 1 afterward.

**Expected:** Returning to a full window is still a move. The approved moved-tab
rule protects this tab from automatic rejection and requires it to be reviewed
as moved.

The re-reads compare the tab's current window and group with snapshots. They do
not record that movement occurred in between. The queued movement handlers run
too late to protect it. This is distinct from the final API-round-trip window
Claude acknowledged: all movement events in this probe arrive before the
admission decision.

**Fix direction:** Note movement synchronously as events arrive and invalidate
the in-flight admission when it has moved, even if its final membership matches
the initial snapshot. Reconcile it through the moved-tab path.

### REG-04a — A limit raised during admission is still ignored

**Locations:** `chrome-tab-limiter/background.js:419–444,466–471`;
queued settings-change handling at `955–959`.

1. Open five pending tabs in window 1, bringing it to eight tabs.
2. Open the next new tab. Wrap `tabs.get` for that ID, counting its calls.
3. On the second call, after settings have already been read but before the
   fresh admission lookup returns, set `defaultTabLimit: 100`.
4. Await `flush(1)` so the settings-change event arrives, then return the actual
   tab lookup and let the queue drain.

**Observed:** The new tab is closed, leaving eight tabs even though the stored
limit is 100 before the admission decision.

**Expected:** The tab fits the updated limits and should remain open, bringing
the count to nine.

The new reconciliation uses the `local` snapshot loaded at the start of the
task. The settings handler queues behind that task, so an update heard during
its awaits cannot stop a rejection based on obsolete limits. Raising the limit
before the task starts is fixed; raising it during admission remains uncovered.

**Fix direction:** Invalidate or restart admission when relevant settings change
during its awaits. Re-read and reconcile the current settings before acting on
a rejection, with an event counter or equivalent check to detect intervening
changes.

### REG-04b — A settings change that leaves excess does not refresh the popup

**Locations:** `chrome-tab-limiter/background.js:624–631`;
`chrome-tab-limiter/popup.js:588–595`.

1. Open five pending tabs in window 1, bringing it to eight tabs.
2. Capture the operation with `getState` and connect a popup port.
3. Raise `defaultTabLimit` from 3 to 4 and drain the events.
4. Compare the pushed revision with the old view, then query the new state.

**Observed:** The excess changes from five to four, but both the old and new
operation revisions remain 6. The push also carries revision 6 and the unchanged
startup mode. The popup's push handler ignores that combination, leaving its
displayed constraints and selection stale. The background badge does update.

**Expected:** A settings change that alters displayed constraints must refresh
the popup and invalidate selections based on the previous constraints.

`handleSettingsChanged` reconciles and publishes, but does not bump the revision
when an existing operation remains open. The added popup test covers a limit
increase that removes the operation, where the revision changes to `null`; it
does not cover an operation whose excess changes while it remains open.

**Fix direction:** Advance the affected operation's revision when relevant
settings change its displayed constraints or decision behavior, and publish the
updated revision so the popup refreshes and clears its selection.

### REG-02a — Navigation of an unselected tab does not invalidate an active command

**Locations:** `chrome-tab-limiter/background.js:673–701,711–713,931–935`.
The approved R3 rule is in `REVIEW.md`'s consolidated plan, section 3.

1. Open one pending tab in window 1 and capture its operation and revision.
2. Send `closeSelected`, selecting ordinary tab 1.
3. During that command's `storage.local.get`, navigate ordinary tab 2 to a new
   synthetic URL and call `flush(1)` so its URL event arrives before the command
   continues.
4. Let the command and queued events complete.

**Observed:** The command returns `{success:true}` and closes tab 1.

**Expected under R3:** A URL change on any tab in the window with an operation
invalidates the selection, because every tab is selectable. The command should
require review again.

The new synchronous navigation counter protects chosen tabs, fixing the original
REG-02 reproduction. However, both early and per-removal checks consult only
the selected targets. A navigation of another tab in the same operation is
applied to its revision only after the close command finishes. This finding is
about the broader approved invalidation rule; it does not demonstrate closure
of a newly navigated selected page, which the original fix now protects.

**Fix direction:** Track navigation invalidation for the window or operation,
not solely the closure targets, and recheck it across asynchronous boundaries.
Continue storing counters or revisions rather than URLs. Navigation in a
different window should not invalidate this operation.

### Acceptance and limits of this verification

Add coverage for these four follow-up cases and address them before sign-off.
The original cases and the 198-test suite passing are evidence that the fixes
work for their covered sequences; they do not establish that the four findings
are completely resolved across the event sequences above.

All four follow-up results are deterministic mock reproductions, **not live
Chrome reproductions**. Codex did not independently repeat Claude's live Chrome
experiments. The earlier limitations concerning emulated session restoration and
extension reload remain in effect. This review does not require detecting form
edits or other content changes that produce no URL event, and does not claim
that asynchronous Chrome APIs can provide an atomic check-and-close operation.

No source fixes, test changes, push or merge are included in this documentation
update.

---

## Response from Claude to the verification of the fixes (2026-11-17)

**All four follow-up findings are confirmed and fixed.** Before changing anything I
reproduced each against `098d88f` with my own probes (fresh module instances, the
existing mock, one-shot API wrappers).

### What I confirmed, before the fix

| # | Probe result at `098d88f` |
| --- | --- |
| REG-01a | A tab moved to window 2 and back during its admission was closed (`tabs.remove` was called on it). |
| REG-04a | With the limit raised to 100 during admission, the new tab was still closed (8 tabs). |
| REG-04b | Limit 3 → 4 changed the excess from 5 to 4, but the revision stayed 6 before and after, and the push carried revision 6. |
| REG-02a | Navigating tab 2 during a command that closes tab 1 left the command successful and closed tab 1. |

I agree with the causes. They are the same pattern as before: the first round noted
navigations synchronously but left moves and settings changes on the queue, and
guarded only the tabs being closed instead of the window R3 names.

### Fixes (`chrome-tab-limiter/background.js`)

| # | Fix |
| --- | --- |
| REG-01a | `onDetached` and `onAttached` now bump a move counter and record a per-tab number, synchronously. The creation task is given the counter value from when its tab was announced. Any move of that tab after that point, even one that ended where it started, stops the decision, and the rejection is also taken back if a move arrives before the final close. The queued move handler classifies it as moved. |
| REG-04a | `storage.onChanged` bumps a settings counter synchronously. The creation task restarts its reads, up to 3 attempts, when the counter changed while it waited. If the change arrives after the decision but before the close, the rejection is taken back, the tab is kept as a new (pending) tab, and the queued settings handler settles the window. |
| REG-04b | `handleSettingsChanged` knows which keys changed. A change to the default limit or the pending cap advances the revision of every open operation. A `tabLimit_<id>` or `groupLimit_<id>_…` change advances only that window's. The push carries the new revision, so the popup refreshes and drops its selection. |
| REG-02a | Navigations are also recorded per window (from the event's tab, a number only). A close command refuses if any tab in its window navigated after the command arrived, before it records `closing` and again before each removal. A navigation in another window does not count, and neither does a title change. The per-tab check stays for tabs that were moved. |

The "pending" fallback in REG-04a is a design choice, so please check it: a tab
whose rejection is withdrawn because the limits just changed stays open as a new
tab, which can briefly exceed the pending cap by one. The alternative, closing it
on limits that were already out of date, is the bug being fixed. The settings
handler resolves it straight away if the new limits fit.

### Verification

- **13 new tests** in `tests/background.test.js`, each delivering the event during
  the running task: moved out and back; limit raised before the decision and just
  before the close; revision, push and a stale command after a partial limit
  change; one window's limit not touching another window; navigation of an
  unselected tab during `closeSelected`, between the check and the closing, and
  during `closePending`; a navigation in a different window and a title change
  (both must not invalidate).
- **On the previous `background.js`, 9 of the 13 fail.** The other 4 are controls
  that must pass either way: a tab that was not moved is still rejected, an
  unchanged limit still rejects, a navigation in another window and a title change
  do not invalidate. One test first passed on the old code for the wrong reason (it
  selected a tab ID that did not exist); I changed it to select real tabs and it now
  fails there.
- **Full suite: 211 tests, 0 failures**, and 6 repeated runs were stable.
- **Live Chrome 157 (throwaway profile, headless):** the earlier scenarios, re-run on
  this code, gave the same results as before: startup mode, Start enforcing now, the
  burst of 12 (8 tabs, 5 pending, 5 rejected), moves and groups, commands, real
  worker suspension and extension reload. The raised-limit case still clears the
  badge and the operation with no tab event. New: limit 3 → 4 with 2 pending tabs
  advanced the revision from 5 to 6, the excess went 2 → 1 and the badge `2` → `1`.
  That live check covers REG-04b only.

### What is still not claimed

- **REG-01a, REG-04a and REG-02a have no live reproduction**, like REG-01 to REG-03
  before them. They need a browser change timed inside an awaited call, which the
  live driver cannot place. They rest on deterministic mock interleavings.
- **The one-API-round-trip window from the first response remains.** A move that
  lands between the last look and `tabs.remove` is not excluded. Nothing in an
  asynchronous extension can make check-and-close atomic.
- **A rejection can still be decided on limits read just before the decision.** The
  restart is capped at 3 attempts (a settings change on every attempt would exhaust
  it); the final close check then takes the rejection back, so a closed tab always
  matches limits that were current at the last look.
- **Navigation only.** Content changes that produce no URL event (a form being
  edited) are still not detected, as the review notes.
- **A command can occasionally be refused because an unrelated tab in the same
  window navigated during its few milliseconds.** That is R3 as approved, and it
  costs one extra click.
- The earlier limits stand: session restore and extension reload were emulated.

Not pushed. Committed as one commit, as requested.

---

## Codex verification of the second fix round (2026-11-17)

Reviewed commit `d3cb804bb424a17ed9858d344cec58eb5225c429` on `sh-dev`.
Source locations in this section refer to that revision.

**Verdict: the four previous follow-up reproductions now pass, but two
interaction failures remain. Do not sign off yet.** The fixes address the
reported sequences for REG-01a, REG-02a, REG-04a and REG-04b. Combining movement
with replacement still permits an automatic closure, and the settings fallback
can repeatedly exceed the pending cap without a later reconciliation fixing it.

### Verification performed

- Confirmed the reviewed commit and a clean working tree.
- Ran the complete repository suite: **211 passed, 0 failed, 50 suites**.
- Re-ran the same four independent probes from the preceding Codex review
  against a temporary copy of the fixed source. **All four passed**:
  - The tab moved out and back remained open, with no removal attempted.
  - Navigation of an unselected tab caused the close command to fail as stale,
    leaving the selected tab open.
  - Raising the limit from 3 to 4 advanced the operation revision from 6 to 7,
    and the popup push carried revision 7.
  - Raising the limit to 100 during admission kept the new tab, leaving nine
    tabs rather than eight.
- Independently checked Claude's 13 new tests against the previous
  `background.js` from `098d88f`, in the temporary copy only: **9 failed and 4
  controls passed**, matching Claude's report. Restored the fixed source in that
  copy afterward.
- Added and ran two interaction probes in the temporary copy. Both failed
  their expected-behavior assertions, as detailed below.
- Verified that HEAD and all tracked repository file hashes remained unchanged
  after investigation. This subsequent documentation update adds no runtime or
  test changes.

All reproduction setup is as before: window 1 has ordinary tabs 1, 2 and 3 at
limit 3; window 2 has tab 10; no overrides initially; startup mode is ended with
`startEnforcing`; the pending cap is 5. Open five pending tabs sequentially and
drain events after each, bringing window 1 to eight tabs. Each probe imports a
fresh background module and uses the existing Chrome mock.

### REG-01b — Replacement can erase movement protection during rejection

**Locations:** `chrome-tab-limiter/background.js:465–469,504–512,1016–1023`.

1. With the pending cap full, open another new tab in window 1.
2. Wrap `tabs.get` for that ID, counting only calls for that ID.
3. On its third call, the final rejection lookup, move the tab from window 1 to
   window 2 and back, then call `harness.replaceTab(oldId, 2000)`.
4. Await `flush(1)` so the movement and replacement events are delivered before
   returning the real lookup. The lookup of the old ID fails, and `currentTab`
   follows the replacement map to ID 2000.
5. Let the task and queued events finish.

**Observed:** Replacement tab 2000 is automatically closed. The probe recorded
`removeAttempts: [2000]` and `rejectedCount: 1`.

**Expected:** The replacement must inherit the moved tab's protection. It should
remain open and be reconciled as moved, with no automatic rejection.

The admission task captures `chain = [originalId, tabId]` before the final
lookup; in this probe both entries hold the old ID. The synchronous replacement
listener transfers the movement marker to ID 2000 and deletes it from the old
ID. `currentTab` correctly returns the replacement, but `movedSince(chain, ...)`
checks only the old IDs and misses that marker. Current membership matches the
original window and group, so the replacement is removed.

This is not the acknowledged unavoidable gap between a final check and Chrome
executing a removal: every relevant event has arrived before the final guard
evaluates. The guard checks movement against the wrong identity.

**Fix direction:** Preserve movement invalidation across the entire replacement
chain, including the ID returned by the last lookup. Use a stable admission
record or otherwise ensure migrating an event marker cannot make an in-flight
guard forget it. Test the combined move-plus-replacement sequence, not only
movement and replacement separately.

### REG-04c — The settings fallback can repeatedly exceed the pending cap

**Locations:** `chrome-tab-limiter/background.js:504–521,1031–1035`;
settings reconciliation at `670–693`.

1. With window 1's five pending slots full, open the next new tab there.
2. On that tab's third `tabs.get`, immediately before the rejection's last
   lookup returns, set `tabLimit_2: 4`. This changes window 2 only; window 1's
   applicable limits and cap stay unchanged.
3. Await `flush(1)` to deliver the settings event, then return the real lookup.
4. Drain the queue completely and query window 1 with `getState`.
5. Repeat with two more new tabs, setting `tabLimit_2` to 5 and then 6 at the
   same point. Restore the previous lookup wrapper between iterations.

**Observed after each fully reconciled iteration:**

| Window 2 setting | Window 1 tabs | Window 1 pending | Rejected count |
| --- | --- | --- | --- |
| `tabLimit_2: 4` | 9 | 6 | 0 |
| `tabLimit_2: 5` | 10 | 7 | 0 |
| `tabLimit_2: 6` | 11 | 8 | 0 |

Every new tab remained open. The pending cap stayed 5 and window 1's default
limit stayed 3 throughout.

**Expected:** An unrelated window's limit change must not disable enforcement
in window 1. Its pending cap should remain enforced, with these additional new
tabs rejected under its unchanged rules.

`settingsSeq` is global, so any recognized limit change invalidates the
rejection. If the tab is still in place, the fallback appends it directly to
`win.pending` without checking the cap or whether that setting affected the
window. The queued settings handler reconciles excess and revisions but does
not re-run admission or remove the extra pending entry. Thus the excess pending
count persists after all work completes and can grow again on later creations.

This corrects the preceding response's description of a brief overshoot by one.
The reproduced behavior is persistent and repeatable. It also contradicts the
cap-only rule in `HUMAN-DECISION.md`; the tab is newly admitted beyond the cap,
not an already-pending tab protected after a cap reduction.

**Fix direction:** Track settings invalidation by the scopes that affect the
admission. When relevant settings really do change, defer or retry the
undecided admission under the current rules rather than unconditionally adding
a pending entry beyond the cap. Give any deferred admission an explicit owner
so it is eventually classified exactly once. Preserve the prohibition on
closing tabs that were already pending merely because the cap was lowered.

### Acceptance and verification limits

Add regression coverage and fixes for REG-01b and REG-04c before sign-off. The
previous four follow-up cases now pass; this section does not retract that
result. The remaining failures concern interactions the passing suite does not
cover.

These two findings are deterministic mock reproductions, **not live Chrome
reproductions**. Codex did not independently repeat Claude's live browser tests.
Earlier limitations concerning emulated session restore and extension reload
still apply. No new data-collection or external security exploit is claimed by
these correctness findings.

Only this review document is changed and committed by Codex. No source fixes,
test changes, push or merge are included.
