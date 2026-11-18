# Chrome Web Store listing: Tab Limiter 1.0.0

Everything to paste into the [Developer Dashboard](https://chrome.google.com/webstore/devconsole),
field by field. This folder is not packaged into the extension ZIP.

Items marked **DECIDE** are yours to judge. Items marked **CHECK** are my best
understanding of the dashboard, which I could not open; if a label differs, trust the dashboard.

## Order of work

1. Register as a developer (one-time fee) and verify your contact email.
2. `tools/release.sh`, then create a **new item** and upload `dist/tab-limiter-1.0.0.zip`.
3. Fill in the **Store listing**, **Privacy** and **Distribution** tabs with the text below.
4. Make sure `PRIVACY.md` and `CAVEATS.md` are on `main` of the public repository (you push; I never
   do), then paste the privacy policy URL into the dashboard. It is required, see below.
5. Submit for review. After it is accepted, `git tag v1.0.0 <commit that release.sh printed>`.

## Store listing tab

| Field | Value |
| --- | --- |
| Name | Tab Limiter (from the manifest) |
| Summary | Taken from the manifest `description` (max 132 characters). Current text, 118 characters: *Limit the number of open tabs per window. Requires tab access to count and manage tabs. All data stored locally only.* |
| Category | Productivity (**CHECK**: pick a sub-category such as "Tools" or "Workflow & planning" if it asks) |
| Language | English |
| Store icon | `chrome-tab-limiter/icons/icon128.png` (128x128) |
| Screenshots | The five files in `store/screenshots/`, in numeric order (1280x800 JPEG) |
| Small promo tile (440x280) | Optional. Not made. |
| Marquee promo tile (1400x560) | Optional. Not made. |
| Video | None |
| Homepage URL | Optional. `https://github.com/CloudyTrees/chrome-tab-limiter` |
| Support URL | Optional. `https://github.com/CloudyTrees/chrome-tab-limiter/issues` (needs Issues enabled on the repository) |
| Mature content | No |

**Optional manifest change for a better summary.** The store shows the manifest `description` as
the summary, and the current one explains permissions more than it sells the extension. A
sharper 117-character option: *Set tab limits per window and tab group. When you go over, you choose which tabs to close. No data leaves your device.*
Changing it means editing `manifest.json` and committing before you run `tools/release.sh`.
I have not changed it.

### Detailed description (paste as plain text)

```
Tab Limiter keeps tab overload in check and lets you decide which tabs to close.

Set a maximum number of tabs for each browser window, and give individual tab groups (and ungrouped tabs) their own limits. When a new tab goes over a limit, it stays open and waits. Tab Limiter then shows you the tabs in that window and lets you choose which ones to close, or close just the new ones, or decide later. Tabs you already have open are closed only when you confirm. One exception: while a window is waiting for your decision, new tabs beyond the waiting limit (default 5) are closed automatically, and the popup tells you how many.

FEATURES
• Per-window limits, plus a default for new windows (1 to 100 tabs)
• Separate limits for each tab group and for ungrouped tabs
• You decide: pick the tabs to close, close only the new tabs, or decide later
• The close button turns on only when closing your selection would bring every limit back in range, and it never lets you close the last tab in a window
• A toolbar badge shows how many tabs are over, and the popup opens by itself when Chrome allows it
• Waiting tabs are capped (default 5, adjustable from 1 to 10). Beyond that, extra new tabs are closed and the popup tells you how many
• Startup mode: after a browser restart, or when the extension updates, nothing is closed automatically until you make your first decision, so restored windows are safe
• Every tab counts, including pinned tabs
• Export your limits to a small JSON file as a backup. Import restores only the default limit and the pending-tab limit; window and group limits are not imported and must be set again

PRIVACY
Tab Limiter works entirely on your device. It makes no network requests (its content security policy forbids them), has no analytics or telemetry, and asks for no access to website content or browsing history. Chrome makes tab titles and addresses available to it; it processes them in memory on your device, to show you the list and to notice when a tab navigates, and never stores or sends them. Your limits are stored locally and are not synced to your Google account.

PERMISSIONS
• Tabs: makes tab titles and addresses available, to show the list and notice navigation
• Tab groups: read group names and colors, so groups can have their own limits
• Storage: save your limits on this device

Requires Chrome 127 or later.

Chrome's install prompt says "Read your browsing history". That is Chrome's standard wording for the Tabs permission, which this extension uses to read tab titles and detect navigation. Tab Limiter has no history permission and sends nothing anywhere.

A personal project shared as is, with no warranty: use at your own risk. Bug reports and feature requests are welcome in the GitHub issue tracker; nothing is promised.

Assumptions, caveats and known limits: https://github.com/CloudyTrees/chrome-tab-limiter/blob/main/CAVEATS.md
Privacy policy: https://github.com/CloudyTrees/chrome-tab-limiter/blob/main/PRIVACY.md
```

Every sentence above was checked against `chrome-tab-limiter/README.md` and the code. Keep it that
way if you edit it: the store rejects descriptions that promise what the extension does not do.

### Screenshots (store/screenshots/)

| File | Shows | Caption in the image |
| --- | --- | --- |
| `1-limits.jpg` | The popup's settings: window limit, default limit, group limits | Set a limit for each window and tab group |
| `2-you-decide.jpg` | A tab went over; two tabs ticked to close | You decide which tabs close ("Tabs you have open close only when you confirm") |
| `3-startup.jpg` | Startup mode with "Start enforcing now" and "Keep these" | Restored tabs stay until you decide |
| `4-options.jpg` | The options page: pending-tab limit, export, import (with its limits stated) | (none) |
| `5-privacy.jpg` | The options page's privacy section | (none) |

They are real captures of the extension in Chrome 157 with made-up tab titles (the popup images are
the real popup, stitched from scrolled captures because Chrome's popup window is only 600px
tall). Nothing in them is a mock-up of behavior the extension lacks. One thing they show honestly:
the pending-limit box on the options page is tiny. Enlarging it would be a good small polish before
a later release.

## Privacy tab

### Single purpose description

```
Limit the number of open tabs in each browser window and tab group, and let the user decide which tabs to close when a limit is exceeded.
```

### Permission justifications

**tabs**
```
Needed because Chrome withholds tab titles and web addresses from extensions without it. The extension uses tab titles to show the user a list of tabs to choose from when a limit is exceeded, and uses address changes (navigation) to notice that a tab has changed, so it does not act on an out-of-date list. Counting tabs, tab groups and tab events do not need this permission. The extension closes the tabs the user selects and, once a window has as many waiting new tabs as the user's pending-tab limit allows, any further new tabs in that window. It does not read page content, does not store titles or addresses, and does not send tab information anywhere.
```

**tabGroups**
```
Needed to read tab group names and colors, and to be told when groups change, so that each tab group can have its own tab limit and the settings list shows the groups in the current window.
```

**storage**
```
Saves the user's tab limits and the pending-tab setting on the device (chrome.storage.local), and keeps in-progress decisions (window and tab IDs and counts, no titles or URLs) in memory-only session storage so they survive the background worker being suspended.
```

There is no host permission and no content script, so there is nothing to justify for them.

### Remote code

Select **No, I am not using remote code.** (True: Manifest V3, all scripts are packaged, and the
extension's content security policy sets `connect-src 'none'`.)

### Data usage **DECIDE**

The dashboard asks which kinds of user data the extension handles, and then asks you to certify
three statements. Google's [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
says disclosure is required "even when data is processed or stored locally on a user's device",
and defines handling as collecting, transmitting, using or sharing. Tab Limiter reads tab titles and
the address changes of tabs, and keeps neither.

My recommendation is to be conservative:

- Tick **Web browsing activity** (it observes tab titles and navigation events) and, if the dashboard
  offers it, **Website content** (the page title is page text).
- Leave every other box (personal information, health, financial, authentication, communications,
  location, user activity, and so on) unticked. The extension handles none of them.
- Tick all three certifications. They are true: the data is not sold or transferred to third parties,
  is not used for anything unrelated to the extension's single purpose, and is not used for
  creditworthiness or lending.

Ticking a box does not mean you are doing anything wrong; it is a disclosure, and the policy text
below explains that nothing leaves the device. The risk runs the other way: ticking nothing while
the extension reads tab titles is the answer a reviewer is likely to question.

### Privacy policy URL (required)

```
https://github.com/CloudyTrees/chrome-tab-limiter/blob/main/PRIVACY.md
```

The file is `PRIVACY.md` at the repository root. For this link to work for Google's reviewers and for
users, **all of these must be true**, and I could not check them (I have no `gh` here, and
looking the repository up would send its name to GitHub):

1. The repository is **public**. A private repository's files return "404" to everyone else.
2. `PRIVACY.md` is **pushed to `main`**. The link names the `main` branch.
3. If you rename the repository or the branch, the link breaks. Keep it stable, or update the
   dashboard.

Making the repository public also publishes everything in it: `REVIEW.md`, `REGRESSIONS.md`,
`HUMAN-DECISION.md`, the specs and the whole history. Read through them once before you flip it.

I wrote the policy from this code, not from a template, because a policy must describe *your*
extension and copying someone else's would assert facts about theirs. Its structure is the common one
for small open-source extensions that collect nothing (what is handled, what is stored, what leaves the
device, sharing, your control, open source, contact); see for example the public policies of other
small open-source Chrome extensions on GitHub. It meets
what Google's [privacy policy requirement](https://developer.chrome.com/docs/webstore/program-policies/privacy)
asks for: an accurate and up-to-date policy, linked from the dashboard, that discloses how data is
collected, used and shared. Keep it in step with the code: if a future version reads more, change
the policy first.

## Distribution tab

| Field | Value |
| --- | --- |
| Visibility | **Unlisted** (see below) |
| Pricing | Free |
| Regions | All regions (default) |

### What Unlisted means

Per Google's [distribution documentation](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution):
Public lists the item in the store for everyone. **Unlisted** creates no store listing, but anyone who
knows the item's Chrome Web Store URL can install it. **Private** limits installation to people you
name (trusted testers by Google account email, or a Google Group you manage).

Your assumption is right: nobody finds an unlisted item by browsing the store, and it is installable
by whoever you give the link to. Three things to know:

- It still goes through **the same review and the same policy requirements** as a public item. The
  privacy policy, permission justifications and screenshots are still required.
- The URL is not a secret. Anyone who gets it can install it, and Google's page does not say
  whether search engines may index it. Do not post it somewhere you would not want strangers to see it.
- If you want installs limited to yourself, **Private** with your own Google account as a trusted
  tester is the tighter option. Unlisted is the better fit if you want to hand the link to friends.

I could not confirm from the documentation whether visibility can be changed after publishing; check
the dashboard before relying on it.

## Test instructions for the reviewer (optional field)

```
No account or sign-in is needed. After installing, the extension is in "startup mode": nothing is closed automatically until the user makes a first decision. 1) Click the toolbar icon and press "Start enforcing now". 2) Set "Tab limit for this window" to 3 and press Save. 3) Open tabs until the window has 4. The fourth tab stays open, the toolbar badge shows 1, and the popup lists the window's tabs. 4) Tick one tab and press "Close selected tabs", or press "Close the 1 new tab". Tabs that are already open are not closed until a button is pressed. The extension makes no network requests.
```

Why step 1 is there: Tab Limiter does not treat a fresh install differently from a browser restart,
so until the first decision a tab over the limit is kept (and the popup says so) instead of
waiting as "pending". A reviewer who skips step 1 would see that and might think the extension
does nothing. This is also what a brand-new user sees, which is worth knowing: the first time they
go over a limit they get the startup view, not the normal one. If you would rather a fresh install
start enforcing at once, that is a product change (`runtime.onInstalled` with `reason: "install"`),
not something I have done.

## What I could not verify

- The dashboard's exact category list and field labels (I could not open it).
- How the review will judge the data-usage answers.
- Chrome 127, the declared minimum, has not been run; the extension was tested on Chrome 157.
