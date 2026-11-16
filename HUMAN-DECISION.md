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
