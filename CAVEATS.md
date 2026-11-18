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

- **Chrome 127 or later on desktop.** Tested only on Chrome 157, on macOS. Other Chromium
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
  closed automatically.
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
  for you to review. Nothing is closed.
- **Number ranges.** Limits accept 1 to 100 tabs; the pending limit 1 to 10.
- **English only.**

## What has and has not been tested

Tested: 270 automated tests at the time of writing (run them with `npm test`), including the real
`background.js` run against an in-memory Chrome stand-in, plus checks in a real Chrome 157 on macOS recorded in `REVIEW.md`: startup mode, the
decision popup, bursts of new tabs, groups and moves, closing windows, the worker being
suspended, and the content security policy's refusals.

Not tested, or only simulated:

- Chrome 127 (the declared minimum).
- A real browser restart with session restore, and a real mouse drag of a tab between windows
  (both were emulated).
- The exact timing of races inside a browser call. Those fixes are covered by simulated
  interleavings, not by real timing.
- Windows and Linux, other Chromium browsers, and Incognito.

## Support

This is a personal project, built mainly for the author's own use and shared with friends. It is
released under CC0 (see `LICENSE`) and provided **as is, with no warranty: use it at your own risk**.
The author uses it too and takes the same risk.

Bug reports and feature requests are welcome in this repository's issue tracker. Nothing is
promised: no support, no response time and no guarantee that a request will be built or a bug fixed.
