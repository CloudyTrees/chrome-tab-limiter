# Tab Limiter: assumptions, caveats and known limits

Tab Limiter is a personal project, published as is. The Chrome Web Store description is
short on purpose; this page holds the detail. It is kept honest: anything that was not tested
is listed under "What has and has not been tested".

## What it is meant for

You use desktop Chrome and want to be **asked** before the tabs you have open are closed. You set
how many tabs a window (and each tab group in it) may hold. When a new tab goes over, it stays
open and the popup lets you choose what to close. **The one exception:** while a window is
waiting for your decision, new tabs beyond the pending limit (default 5) are closed automatically
(see below).

## Assumptions it makes

- **Chrome 127 or later on desktop.** Tested only on Chrome 157 and 158, on macOS. Other Chromium
  browsers (Edge, Brave and so on), Windows and Linux are untested.
- **Limits are per window**, and per tab group inside a window. There is no limit across all
  windows combined.
- **Every tab counts**, including pinned tabs.
- **Limits stay on this device.** They are not synced to your Google account or other computers.
  **Export and Import do not move them.** An export is a backup, but Import restores only the
  default limit and the pending-tab limit. Window and group limits are not imported and must be
  recreated by hand, and an import also **removes** the window and group limits you currently have.
- **Incognito:** Chrome keeps extensions off in Incognito unless you allow them. If you allow
  Tab Limiter there, how it behaves is untested.

## Things that may surprise you

- **A new install, a browser restart and an extension update all start "startup mode".** Until
  your first decision (Keep these, Close, or Start enforcing now) nothing is closed
  automatically, and a tab over the limit is simply kept and flagged. This protects restored
  windows. It also means that right after installing, nothing is enforced until you press
  "Start enforcing now" in the popup.
- **A tab over the limit is not blocked.** It stays open as *pending* until you decide. While a
  window waits, more new tabs wait too, up to the pending limit (default 5, 1 to 10 in
  settings). Beyond that, further new tabs **are closed**, and the popup says how many. A closed
  tab's address is not remembered, and the tab may already have started loading.
- **Closing pending tabs discards what they had** (a half-filled form, for example). That only
  happens when you press the labeled button.
- **The last tab in a window is never closed.**
- **A tab you drag into a full window or group** counts as excess and asks you, but is never
  closed automatically. The same holds for a whole group moved into a window: if it puts the
  window or the group over a limit, its tabs are flagged as moved, and nothing is closed.
- **A group's limit follows the group to another window, for one browser session.** Window
  limits and the limit for ungrouped tabs stay with their window. After a browser restart,
  Chrome gives restored groups new identities, so they use the default limit until you set one
  again. Reloading, updating, or disabling and re-enabling the extension keeps group limits.
- **Right after a browser start, custom group limits pause for a moment.** Until the extension
  has started a new session for them (normally a few milliseconds), every group uses the default
  limit, and Close and Keep these are refused with "Limits are being updated after the browser
  start; please review again". If that save fails, it is retried every 5 seconds.
- **The popup does not open while you drag a group.** If a group is over its own limit, the
  window Chrome uses during the drag, or a new window you tear the group off into, counts as
  over. The popup is not opened there, because it would end the drag; the badge shows it, and
  the popup opens once the group lands in a window that has other tabs.
- **A tab opened just before a group moves into its window** is judged on the window as it was
  when you opened it. If it fit then, it stays an ordinary tab, and the group's tabs are the ones
  flagged as moved.
- **"Keep these" raises an allowance only for the tabs that were already there.** It counts the
  tabs that are neither *pending* nor *moved* in (dragged into) the window or group, and
  grandfathers that many. It never lowers an allowance, and the allowance shrinks again as you
  close tabs. Pending and moved tabs are not covered, so after "Keep these" the window can still
  be over its allowance, with those tabs still waiting for a decision.
- **The popup may not open by itself.** Chrome decides when an extension may open its popup. The
  toolbar badge always shows how many tabs are over; click the icon to decide.
- **Chrome's install prompt says "Read your browsing history".** That is Chrome's standard wording
  for the `tabs` permission, which makes tab titles and addresses available to an extension.
  Tab Limiter uses titles to show you the list and uses address changes to notice navigation. It
  has no history permission, does not read your history, keeps neither titles nor addresses in
  storage, and sends nothing anywhere (see [PRIVACY.md](PRIVACY.md)).

## Known technical limits

- **Stale choices.** Before closing the tabs you selected, the extension checks that nothing you
  were shown has changed (tabs moved, regrouped or navigated, or a limit changed) and cancels the
  close if so. It does not notice text you typed into a page.
- **One tiny window remains.** Between that final check and the close there is one browser call
  (milliseconds long). A change inside that instant cannot be excluded.
- **Worker restarts.** If Chrome restarts the extension's background worker at the wrong moment,
  a new tab may not be recognised as pending. It then appears as unexplained excess in the popup
  for you to review. Nothing is closed. A tab or group that moved while the worker was stopped is
  recognised when it starts again, and flagged as moved where the destination is over.
- **A worker restart around a group move can change whether a tab is shown as moved.** Nothing
  is closed in either case; only whether a tab is shown as *moved* can differ.
  - A group is closed or ungrouped in a window, and within 10 seconds a single tab is dragged
    out of that same window. Until those 10 seconds pass, the extension takes the tab for part
    of a group move. If the background worker restarts once in that time, the tab is judged
    again on its new window as it is then.
  - Chrome reported that a moved group had arrived, but the worker stopped before handling it.
    For up to 10 seconds, a further restart judges the group's tabs again on the window as it
    is then.
- **An extension that was disabled across a browser restart.** Chrome does not tell an extension
  about a browser start that happened while it was off, so after you re-enable it, group limits
  from the earlier session are still current. Until the next browser start the extension sees,
  an old limit can apply to a new group that happens to get the same ID. The group then has the
  wrong limit, which can change whether a new tab in it is admitted, held pending or closed
  automatically, and whether moved tabs are flagged.
- **Smaller gaps around a browser start**, with the same effect:
  - The background worker's first pass after a start can run a few milliseconds before Chrome
    reports the start, so it can judge restored groups under old limits. That is corrected as
    soon as the start is reported, and every decision shown before then must be reviewed again.
  - If saving the new session fails and the background worker then restarts before a retry
    succeeds, and its note of the pending save could not be written either.
  - If the extension is reloaded before the new session is saved.
- **Number ranges.** Limits accept 1 to 100 tabs; the pending limit 1 to 10.
- **English only.**

## What has and has not been tested

Tested: 464 automated tests at the time of writing (run them with `npm test`), including the real
`background.js` run against an in-memory Chrome stand-in, plus checks in a real Chrome 157 on macOS recorded in `docs/review.md`: startup mode, the
decision popup, bursts of new tabs, groups and moves, closing windows, the worker being
suspended, and the content security policy's refusals. Group limits that follow their group
were checked in a real Chrome 158 on macOS: moves by the API and by mouse drags (into another
window, torn off into a new one, a window's only group, part of a group), the worker stopped
before a move, an extension reload, and a browser restart with session restore.

Not tested, or only simulated:

- Chrome 127 (the declared minimum).
- A browser restart done by a person quitting and reopening Chrome: the restart checked was
  Chrome started again by a script with its last session restored.
- A worker restart in the middle of a group move, and the two restart cases above: only
  simulated.
- The exact timing of races inside a browser call. Those fixes are covered by simulated
  interleavings, not by real timing.
- Windows and Linux, other Chromium browsers, and Incognito.

## Support

This is a personal project, built mainly for the author's own use and shared with friends. It is
released under CC0 (see `LICENSE`) and provided **as is, with no warranty: use it at your own risk**.
The author uses it too and takes the same risk.

Bug reports and feature requests are welcome in this repository's issue tracker. Nothing is
promised: no support, no response time and no guarantee that a request will be built or a bug fixed.
