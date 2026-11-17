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
