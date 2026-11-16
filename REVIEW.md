# Privacy, security, and general bug review

Reviewed on 2026-11-16 against commit `ca7fa803f7087b95306b78d74ee83b67604f4aba`.
The working tree was clean when captured. A consistent copy of all 54 repository
files was reviewed in a temporary directory. Source hashes and the revision were
checked again before this report was written; no source changes had occurred.
Line references below refer to that revision.

## Result

No analytics, telemetry, automatic uploads, embedded credentials, or confirmed
externally exploitable security vulnerability was found. The implementation
processes browsing information locally. It nevertheless retains a pending tab's
complete URL in memory longer than its disclosures suggest.

The existing tests all pass, but focused checks reproduced nine functional bugs.
The most consequential involve closing tabs before replacement succeeds, losing
or mixing pending replacement operations, and bypassing configured limits.

| ID | Priority | Area | Finding |
| --- | --- | --- | --- |
| P-01 | P3 / low privacy risk | Privacy | Abandoned selector state retains full URLs; disclosures conflict |
| B-01 | P2 | Replacement | Creation failure closes the existing tab and consumes recovery state |
| B-02 | P2 | Replacement state | Prompts are not bound to distinct operations, and consumption is not atomic |
| B-03 | P2 | Group limits | An allowed selection can cause the replacement to be blocked again |
| B-04 | P2 | Limit enforcement | Rapid creation skips enforcement after the rate limit is reached |
| B-05 | P2 | Tab movement | Moving tabs between windows or groups bypasses enforcement |
| B-06 | P2 | Popup | Error handlers call a function outside its scope |
| B-07 | P2 | Popup | Rejected replacements are treated as success and pending state is cleared |
| B-08 | P3 | Export | Inconsistent alias allocation overwrites exported window limits |
| B-09 | P3 | Input | Numeric input is silently changed, and group save bypasses its displayed maximum |

P2 means a functional defect worth fixing in a normal development cycle; P3 is
lower priority. Functional priorities are not vulnerability severity ratings.
The privacy finding has no demonstrated external reader or transmission path.

## Scope and validation

Reviewed the manifest, all eight runtime JavaScript files, three main HTML pages,
CSS/resource references, icon conversion page and SVG resources, README,
packaging instructions, development scripts, package configuration, and all five
test files plus their Chrome mock. An independent read-only security review
checked the runtime and tests as well.

Validation performed:

- Ran `node --test tests/`, the command used by the package's test script, in the
  isolated copy: **65 passed, 0 failed, 14 suites**, using Node.js v26.13.1.
- Drove the real background module through the existing in-memory Chrome mock,
  using fresh module instances and draining events between scenarios.
- Injected popup-opening and tab-creation failures, interleaved replacement
  messages, created rapid tab bursts, and simulated group/window movement.
- Evaluated the popup script in an isolated JavaScript VM with minimal document,
  window, and Chrome stubs to check function scope, message responses, and input
  behavior. Only its import line was removed for evaluation; no source file was
  changed. This did not exercise browser rendering or a complete DOM.
- Exercised exports with multiple windows and group-only settings.
- Searched current source for network sinks, remote resources, credentials,
  unsafe execution, storage use, and privileged message handlers.

The extension was not loaded into a real Chrome profile. No live network capture,
real browser event-ordering test, or packaged-extension installation was
performed. Mocked reproductions establish code behavior for the supplied events
and failures; they do not prove every Chrome-specific timing detail. No
dependencies were installed. This report is the only repository file written by
the review.

## Privacy and security

### P-01 — Full pending URLs outlive abandoned prompts, and disclosures conflict

**Locations:** `chrome-tab-limiter/background.js:228–238,253–269,387–404`;
`chrome-tab-limiter/popup.js:593–595`;
`chrome-tab-limiter/README.md:10,96–97,141,150–151`;
`chrome-tab-limiter/options.html:109`.

The full blocked-tab URL is saved as `selectorState.newTabUrl` in
`chrome.storage.session`. Query strings, fragments, document identifiers, and
local file paths may be sensitive. There is no expiry. A failed
`chrome.action.openPopup()` leaves the state behind, closing the source window
does not remove it, and dismissing the popup has no cleanup path. The explicit
popup Cancel button does clear it.

**Reproduction:** Start with a full window, make `action.openPopup` reject, and
open a tab with a synthetic sensitive query/fragment. Inspect session storage;
the complete URL remains. Fire the source window's removal event and flush
callbacks; the URL still remains. Both outcomes were reproduced.

This is local session retention, not evidence of remote collection. Chrome
documents session storage as memory-backed and cleared on browser restart or
extension disable/reload/update. Exports read `storage.local`, so this URL is not
included in exported settings. See the
[Chrome storage documentation](https://developer.chrome.com/docs/extensions/reference/api/storage).

The README now acknowledges session state at lines 96–97, but line 150 still
says tab URLs are never written to storage. The options page also promises no
personal browsing-data storage. The README still advertises syncing at line 10
and suggests checking Sync at line 141, despite using local storage.

**Recommendation:** Add bounded retention and cleanup for failed, expired, and
orphaned operations. Keep a complete URL only while necessary to reopen the
requested page; blindly stripping query parameters could break the page.
Describe local processing and temporary session retention accurately throughout
the UI and documentation. A suitable core statement is: “We do not receive your
browsing data. Settings stay on your device. A pending tab URL is temporarily
held in memory to complete tab replacement.” Match the stated lifetime to the
implemented cleanup policy.

### Controls that held up under review

- No remote runtime dependencies, analytics SDKs, upload endpoints, `fetch`, XHR,
  WebSocket, or beacon paths were found in shipped code.
- The manifest declares no host permissions, content scripts, web-accessible
  resources, or external-message configuration. CSP specifies
  `connect-src 'none'` and limits images to local/data sources.
- `utils/validation.js:19–23` requires the extension's own ID and origin for
  runtime messages. Background handlers also validate IDs, active/pending state,
  URL schemes, and affected tabs' window membership.
- Replacement URLs come from background-owned state rather than a message's
  `newTabUrl`. The operation-binding problem in B-02 remains a correctness issue
  within that trusted extension boundary.
- Tab/group titles are escaped or assigned with `textContent`. Favicons accept
  bounded inline image URLs and use DOM attribute serialization. No actionable
  injection path was established.
- Imports are local JSON files bounded to 1 MB. Limit values are checked as safe
  integers from 1 to 100; only selected settings are written. The UI requires
  confirmation. No prototype-pollution or imported-code execution path was found.
- Production debug flags are false. Some error paths still log complete Error
  objects, but no concrete sensitive-value disclosure through those errors was
  established.

“No data collection by the developer” is supported by this source review.
“No data is accessed or retained at all” would be inaccurate: tab metadata is
processed, settings are persisted locally, and pending URLs enter session
storage. CSP is a useful control, not a substitute for tracing behavior; normal
reopened tabs still navigate to their requested websites.

### Security hardening notes, not confirmed vulnerabilities

1. **Explain the `tabs` permission accurately.** It exposes URL, pending URL,
   title, and favicon metadata. Basic counting and many management operations do
   not require it, but the current selector and URL recreation use those fields.
   Keeping the permission is defensible for these features. Removing it requires
   a product behavior change; `activeTab` is not an equivalent way to read every
   tab in the selector. See the
   [Chrome Tabs API documentation](https://developer.chrome.com/docs/extensions/reference/api/tabs).
2. **Separate signing-key backups from ordinary archives.**
   `chrome-tab-limiter/packaging_instructions.md:181` includes `*.pem` in a backup
   ZIP, and line 221 recommends cloud backups. No private key was present in this
   snapshot. Keep future signing keys in a separately protected backup and out of
   archives intended for distribution or casual sharing.

## General bugs

### B-01 — Replacement creation failure loses the existing live tab

**Locations:** `chrome-tab-limiter/background.js:591–615`.
**Confidence:** High for the failure path; reproduced with an injected API
rejection, not a live Chrome failure.

The handler consumes selector state and removes the selected tab before calling
`chrome.tabs.create`. If creation rejects, the original tab is already closed,
its live state is lost, and the pending replacement URL has been discarded.
Reopening an old URL would not recover unsaved forms or other live page state.

**Reproduction:** With three tabs and limit 3, open a blocked URL, replace
`tabs.create` with a rejecting implementation, and select tab 2. The response is
`{success:false,error:'Failed to replace tab'}`; only original tabs 1 and 3 remain,
and selector state is absent.

**Recommendation:** Preserve the original live tab and operation state until
replacement creation is confirmed. Coordinate any temporary admission exemption
with the creation-event handler so it does not immediately block the replacement.
Retain a retryable operation on failure. Add failure-path tests before relying on
the successful creation-only mock. See B-07 for the popup's separate handling of
rejected responses.

### B-02 — Pending replacements are neither operation-bound nor atomically consumed

**Locations:** `chrome-tab-limiter/background.js:253–259,483–494,591–607`;
`chrome-tab-limiter/popup.js:39–42,665–673`.
**Confidence:** High for the reproduced message/state interleavings.

All windows and prompts share one `selectorState` key. A newer blocked tab
overwrites it. Confirmation checks only active mode and window ID; there is no
operation ID connecting the visible prompt's captured state to the state being
consumed. State loading, validation, and removal also have asynchronous gaps.

**Reproductions:**

- Block URL A and capture the state used by its popup. Block URL B in the same
  window. Confirm through A's captured handler data. The background reopens B,
  even if the message carries A's URL. Ignoring message-provided URLs is the
  correct security control; the missing control is operation identity.
- Submit two valid confirmations concurrently for different existing tabs against
  one pending operation. Both returned success; both originals were removed and
  two replacement tabs were created. The existing replay test checks sequential
  requests only.

Multiple operations or extension UI instances are prerequisites for these
interleavings. No external website messaging exploit was established. An
unconditional clear/cancel from an older popup can likewise discard a newer
operation, including one for another window.

**Recommendation:** Give each operation a unique ID, associate it with its window
and prompt, and require the ID on confirm/cancel/clear. Queue or explicitly reject
overlapping requests. Serialize validation and consumption so one operation can
commit once, including across duplicate messages.

### B-03 — Choosing a different group can make the replacement fail again

**Locations:** `chrome-tab-limiter/background.js:335–351,597–615`;
`chrome-tab-limiter/popup.js:603–623`.
**Confidence:** High; reproduced through background events and messages.

A group-limit violation opens a selector containing every tab in the window.
Closing a tab outside the constrained group does not free space in that group.
The replacement is always created without group information, so it is ungrouped
and can immediately violate the ungrouped limit again. The original creation's
group is not retained in selector state either.

**Reproduction:** Set default/window capacity to 10 and the ungrouped limit to 2.
Have two ungrouped tabs and one tab in group 7. Open a new ungrouped URL and select
the group-7 tab to close. The request returns success and removes that tab, but
the replacement is immediately blocked. Only the two old ungrouped tabs remain,
and another selector operation is created by the background.

**Recommendation:** Retain the violated constraint and intended destination group
in the operation. Only offer selections that actually make the replacement
admissible, or validate the resulting counts before closing anything. Preserve
group membership when appropriate, and test group-specific replacement and
grandfathered windows whose groups already exceed their limits.

### B-04 — The creation rate limiter disables limit enforcement during bursts

**Locations:** `chrome-tab-limiter/background.js:14–16,320–327`.
**Confidence:** High; reproduced with the current mock.

After ten creation events in a second, `handleTabCreated` returns before counting
or enforcing the limit. This limits the handler's work while admitting the excess
tabs it is supposed to control. The limiter is global, so busy activity in one
window can also suppress enforcement in another.

**Reproduction:** Start with three tabs and limit 3. Open twelve tabs in one burst
before draining events. The first ten events run enforcement; the last two skip
it. Five tabs remain in the window, exceeding the limit of three.

**Recommendation:** Apply admission decisions to every creation event. Serialize
work per window or reconcile actual counts after bursts. Rate-limit presentation
of prompts independently, while retaining pending work rather than skipping
enforcement.

### B-05 — Moving existing tabs bypasses window and group limits

**Locations:** `chrome-tab-limiter/background.js:642–666`.
**Confidence:** High for the missing enforcement; movements were simulated, not
performed through the live Chrome UI.

Only tab creation enforces limits. No `onAttached`/`onDetached` listeners handle
cross-window movement, and group updates recalculate counts without checking
whether the resulting group exceeds its limit. Recounting on the next creation
does not resolve the already excessive window or group.

**Reproductions:**

- Start a window at its limit of 2. Move a third existing tab into it. No attachment
  listener is registered, the count becomes 3, and no prompt opens.
- Start group 7 with two tabs and a limit of 2. Change an ungrouped tab's group to
  7 and deliver `onUpdated` with the new group ID. All three tabs remain in group
  7 and no prompt opens.

**Recommendation:** Define a non-destructive policy for transfers into full
windows/groups and enforce it from attachment and group-change events. Add tests
for both source and destination windows, group moves, and startup/restart behavior.
The relevant browser event semantics are documented in the
[Chrome Tabs API reference](https://developer.chrome.com/docs/extensions/reference/api/tabs).

### B-06 — Popup error handling throws `ReferenceError`

**Locations:** `chrome-tab-limiter/popup.js:34–56,111–113,126–129,180–182`;
the same issue affects the other top-level callers of `safeErrorLog`.
**Confidence:** High; reproduced by evaluating the popup script.

`safeErrorLog` is declared inside the `DOMContentLoaded` callback. Functions such
as `loadInitialData`, `updateTabCount`, and the save handlers are defined outside
that callback and cannot access it. An API failure therefore throws a new
`ReferenceError` from the catch block before the intended recovery or error UI
can run. Initialization can also abort instead of showing a useful error.

**Reproduction:** Make `chrome.tabs.query` reject, then invoke `updateTabCount`.
The result is `ReferenceError: safeErrorLog is not defined`, rather than an
updated error display and a zero result.

**Recommendation:** Put the logging helper in module scope or import it explicitly.
Add popup initialization and API-failure tests, including failed queries and
storage writes.

### B-07 — Popup discards pending state after a rejected replacement

**Locations:** `chrome-tab-limiter/popup.js:662–674`.
**Confidence:** High; reproduced with a rejected response object.

`chrome.runtime.sendMessage` can resolve successfully while the background's
response says `{success:false}`. The popup ignores that response, clears selector
state, and closes itself. For example, if the selected tab has moved to another
window or no longer exists, the background correctly rejects the selection and
keeps the operation available; the popup then discards it anyway. The user cannot
pick another tab or see the reason for failure.

**Reproduction:** Return `{success:false,error:'Synthetic rejection'}` for
`tabSelectedForReplacement`. The popup still sends `clearSelectorState` and calls
`window.close()` once. This path was reproduced without a real DOM.

**Recommendation:** Check `response?.success`. On rejection, preserve the matching
operation, show the error, and refresh the list when necessary. Only complete or
cancel the identified operation intentionally. The legacy selector already checks
the background response at `selector.js:447–450`.

### B-08 — Export alias collisions overwrite window settings

**Locations:** `chrome-tab-limiter/utils/export-import.js:49–85`.
**Confidence:** High; reproduced through `exportSettings`.

New aliases for `tabLimit_` entries use `windowCount + 1`, while group-limit entries
use `windowIdMap.size + 1`. These counters diverge when group settings introduce
windows before per-window limits are processed. Distinct real windows can receive
the same alias, and writing `windowLimits[alias]` can overwrite another limit.

**Reproduction:** Store keys in this order:

```json
{
  "groupLimit_10_1": 4,
  "groupLimit_20_2": 5,
  "tabLimit_20": 6,
  "tabLimit_30": 7
}
```

The export contains `windowLimits: {"window_2": 7}` while metadata reports two
window limits. Window 20's limit of 6 was overwritten, and its group association
now shares window 30's alias. Storage key enumeration order should not determine
whether export preserves settings. This is data corruption, not an ID disclosure.

**Recommendation:** Use one alias-allocation function backed exclusively by the
map's size, or collect all IDs and allocate aliases before exporting values. Add
multi-window tests with different key orders and verify that every custom setting
and window/group relationship survives export. Import intentionally skips
window/group overrides; this finding concerns loss during export itself.

### B-09 — Numeric sanitization changes values and the group handler permits 51–100

**Locations:** `chrome-tab-limiter/popup.js:295–308,435–437,475–479,491–505,527–528`.
**Confidence:** High; reproduced through the input and save functions.

Removing every non-digit character turns `1.5` into 15, `-5` into 5, and `1e2`
into 12. These are valid text representations users can enter in number inputs;
silently rewriting them can save a substantially different limit.

The group input and live validation limit groups to 50, but
`handleSaveGroupLimit` checks the shared 1–100 validator. The Enter-key handler
calls it directly even when validation disabled the Save button.

**Reproduction:** Set a group input to 75. `validateGroupInput` disables Save, but
calling its Enter-key save handler stores `groupLimit_1_7: 75`. The decimal,
negative, and exponent transformations above were also reproduced.

**Recommendation:** Parse the whole value, then validate it as an integer in the
appropriate range. Apply the same group bound in both the UI and save handler;
do not rely on a disabled button or HTML `max` to guard keyboard submissions.

## Earlier findings and remaining validation gaps

- The earlier blocked-tab counter drift is fixed: creation and removal now use
  `syncWindowCounts`, and the expanded regression tests pass. It is not reported
  as a current defect.
- The README now explains local storage structure and temporary session state,
  but the conflicting privacy and Sync statements identified in P-01 remain.
- No DOM/UI tests currently execute popup initialization, rejection feedback,
  confirmation buttons, or keyboard submissions. Pure helper tests do not cover
  these integration paths.
- The Chrome mock always succeeds at tab creation, never closes a window when its
  last tab is removed, and does not model attachment/detachment, group changes,
  browser-managed popup lifecycle, or real storage latency unless extended by a
  test. These omissions matter to the findings above.
- Follow-up browser validation should cover replacing the last tab of a window,
  blocked popups, overlapping prompts across windows, rapid tab bursts, grouped
  replacement, dragging tabs, service-worker restarts, and recovery from API
  failures. These are test gaps, not additional confirmed findings in this report.

Address the tab/state-loss paths first (B-01 through B-03 and B-07), then ensure
that all creation and movement paths observe the limits (B-04/B-05). Correct
P-01's retention and disclosures alongside those changes. None of the recommended
application changes has been applied by this review.
