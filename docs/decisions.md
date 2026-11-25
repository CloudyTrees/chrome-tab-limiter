# Enforcement
Choose keep-pending.

# Follow-up policy
## on "ignored prompts"
Block new tabs in that window until I decide.
## on pending allowance
Start with 5 per window, configurable; explicitly reject additional new tabs after that.
## clarification (2026-11-16): how blocking and the allowance interact
Cap only. While a window has an undecided prompt, new tabs in that window join it as pending, up to the cap (default 5). The next one and every later one is rejected (closed; its URL is not kept). Dismissing the prompt without deciding changes nothing: the decision stays open. No timeouts.
## clarification (2026-11-16): telling me about rejections
Badge on the toolbar icon, plus the prompt reopens (when Chrome allows) saying how many new tabs were rejected and that I need to decide first. No system notifications, so no extra permission.
## clarification (2026-11-16): lowering the cap
Lowering the cap never closes tabs that are already pending.
## clarification (2026-11-16): pending-cap setting
Configurable on the options page, 1–10, default 5.

# Moving tabs into a full windown or group
Prompt and recalculate constraints; no automatic move-back or closure.
## clarification (2026-11-16): moved tabs
A tab moved into a full window or group counts toward the excess and triggers the same prompt, but is never rejected, never closed automatically, and never included in "close the new tabs". The pending cap does not apply to moved tabs.

# Goup maximum
1-100.

# Minimum Chrome
127.

# Tab picker (D3, 2026-11-16)
Popup only. Remove the standalone selector window (selector.html/js/css) and its messages. If the popup can't open automatically, the badge shows and I open it from the icon. A "pop out" window can be reconsidered later if the popup closing while I check tabs becomes annoying.

# Browser start / session restore (D1, 2026-11-16)
Startup mode. After a browser start or extension reload/update, nothing is closed automatically until I make my first decision in the popup. Tabs over a limit are kept and the badge shows the excess. The popup offers "Keep these" (raise that window's grandfathered allowance) or "Choose tabs to close". Normal cap-only enforcement starts after my first decision. No timers.

# Start enforcing now (D4, 2026-11-16)
While startup mode is active, show this button in the popup, including the normal settings view. Clicking it ends startup mode globally without closing or grandfathering any tabs. Subsequent creations follow normal cap-only enforcement. Existing startup excess still requires an explicit decision. The choice survives background-worker restarts.

# Tab groups moved between windows (issue #1)
A tab group's custom limit follows the group when it moves to another window, including to a new window and when the old window closes. The destination's window limit still applies; if the move puts it over, the moved tabs are flagged for review, never closed. Decisions approved for fix/preserve-group-limits-on-window-move:
## D1: splits and merges
Tabs dragged out of a group leave it (Chrome ungroups them), so they use the destination's limits, and the source group keeps its limit. Tabs merged into another group use that group's limit.
## D2: what counts as the same group
The same Chrome group ID, even if a tab was closed during the drag.
## D3: how group limits are stored
groupOverride_<session tag>_<groupId> in chrome.storage.local, plus the groupLimitSession tag. A browser start, a reset and an import each replace the tag; only limits under the current tag apply. Limits stored by earlier versions (groupLimit_<windowId>_<groupId>) are carried over once, only in the session the update installs in, and only when the group is still open in that window; any other is dropped. Safeguards: carrying over never replaces a limit already stored under the tag; cleanup reads the tag and the keys it removes in one read; only the background worker writes group limits.
## D4: "Keep these" allowances
They do not follow a group. The group is judged afresh at the destination, and excess there is flagged as moved.
## D5: window limits and ungrouped limits
They stay with their window. A group torn off into a new window gets the default window limit there.
## D6: groups closed within a session
Their limits stay in storage until the next browser start, then are removed. They are harmless: Chrome does not reuse group IDs within a session.
## D7: where group limits live
chrome.storage.local with the session tag (option a), so they survive an extension reload, update or disable and re-enable, as before. Known exception, documented in CAVEATS.md: if the extension was disabled across a browser restart, it never hears about that start, and an old limit can match a new group with the same ID until the next start it does hear about. Option b (chrome.storage.session, no exception, but every extension reload or update would drop all group limits) was not chosen.
## D8: browser restarts
Group limits do not survive a browser restart; Chrome gives restored groups new IDs. From the moment the extension hears about a start, old limits stop applying (decisions under them are refused until the new session is saved), and they never apply again.
## clarification: a new tab and a group move into the same window
A new tab is judged on the window it was opened into. Tabs that arrive by a move after it was opened are the move's to answer for: they are flagged as moved if they put the window over, and a decision that only they opened does not make the earlier tab pending. A tab opened after the move finds the window over and waits as pending, as before. Recommended by Codex and approved with the Stage 5 sign-off.
## clarification: the popup and a group being dragged
A move does not open the popup in a window that holds nothing but the moving tabs: Chrome's temporary drag window, or a window a group was just torn off into. Opening it there ends the drag (seen in real Chrome, Stage 6). The badge still counts the excess, and the popup opens as before once the group lands in a window that has other tabs. Chosen by the owner, Stage 6.
