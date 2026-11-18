import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// User-facing wording must not promise more than the code does. Each claim below was
// found wrong by review, so the retracted phrasing must not return and the corrected
// facts must stay stated. Behavior itself is tested elsewhere (export-import.test.js,
// limits.test.js, background.test.js); this guards what the words say.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const popupJs = read('chrome-tab-limiter/popup.js');
const optionsHtml = read('chrome-tab-limiter/options.html');
const readme = read('chrome-tab-limiter/README.md');
const privacy = read('PRIVACY.md');
const caveats = read('CAVEATS.md');
const listing = read('store/LISTING.md');
const flat = (text) => text.replace(/\s+/g, ' ');

describe('"nothing closes until you confirm" is not promised without its exception', () => {
    it('the popup hint is qualified', () => {
        assert.doesNotMatch(popupJs, /Nothing closes until you confirm/);
        assert.match(popupJs, /Tabs you have open close only when you confirm/);
    });

    it('the store listing and caveats state the automatic closing of tabs beyond the pending limit', () => {
        for (const [name, text] of [['LISTING.md', listing], ['CAVEATS.md', caveats]]) {
            assert.doesNotMatch(text, /Nothing is closed until you confirm/, name);
            assert.doesNotMatch(text, /behind your back/, name);
            assert.match(flat(text), /beyond the (waiting|pending) limit.{0,80}closed automatically|closed automatically.{0,160}beyond the (waiting|pending) limit/i, name);
        }
    });

    it('the tabs permission justification does not say only selected tabs are closed', () => {
        assert.doesNotMatch(listing, /close only the tabs the user selects/);
        assert.match(listing, /any further new tabs in that window/);
    });
});

describe('privacy wording matches what the extension receives', () => {
    it('does not claim no access to website data, or that titles exist only while the list is shown', () => {
        assert.doesNotMatch(privacy, /any website's data/);
        assert.doesNotMatch(privacy, /only in the memory of\s+the running extension while it shows you the list/);
        assert.match(flat(privacy), /background process receives them/);
        assert.match(flat(privacy), /never written to storage and are never transmitted/);
    });

    it('the options page does not say titles and URLs are read only to show the list', () => {
        assert.doesNotMatch(optionsHtml, /read only to show the tab list/);
        assert.match(flat(optionsHtml), /to notice when a tab navigates/);
    });

    it('does not say the tabs permission is needed to count tabs, and states what it gates', () => {
        assert.doesNotMatch(flat(readme), /It uses titles and groups to count tabs/);
        assert.doesNotMatch(readme, /it does not use the URL\./);
        assert.match(flat(readme), /Counting tabs and receiving tab events do not need it/);
        assert.match(flat(privacy), /Counting tabs and receiving tab events alone\s+would not need this permission/);
        assert.match(listing, /Counting tabs, tab groups and tab events do not need this permission/);
        // other permissions (host permissions, activeTab) can also expose titles, so it is not "the" requirement
        assert.doesNotMatch(listing, /any extension needs/);
    });
});

describe('export and import are not promised to move limits between devices', () => {
    it('nothing says limits can be transferred or moved with Export and Import', () => {
        for (const [name, text] of [['options.html', optionsHtml], ['README.md', readme], ['CAVEATS.md', caveats], ['LISTING.md', listing]]) {
            assert.doesNotMatch(text, /transfer to another device/i, name);
            assert.doesNotMatch(text, /use Export and Import to move them/i, name);
            assert.doesNotMatch(text, /Export and import your limits as a small JSON file/i, name);
            assert.doesNotMatch(text, /Backup and restore all your tab limit configurations/i, name);
        }
    });

    it('the pages that mention import say window and group limits are not restored and are removed', () => {
        assert.match(flat(optionsHtml), /window and group limits are not imported and must be set again/);
        assert.match(flat(optionsHtml), /existing window and group limits are removed/);
        assert.match(flat(caveats), /do not move them/);
        assert.match(flat(caveats), /removes\*\* the window and group limits you currently have/);
        assert.match(flat(listing), /window and group limits are not imported and must be set again/);
        assert.match(flat(readme), /not\*\* restored, and an import removes the ones you have now/);
    });
});

describe('"Keep these" is described as counting only tabs that are neither pending nor moved', () => {
    it('CAVEATS.md does not say it raises the allowance to the number of tabs the window has now', () => {
        assert.doesNotMatch(flat(caveats), /to the number of tabs it has now/);
        assert.match(flat(caveats), /neither \*pending\* nor \*moved\*/);
        assert.match(flat(caveats), /can still be over its allowance/);
    });
});
