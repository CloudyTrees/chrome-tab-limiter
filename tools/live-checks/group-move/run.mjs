#!/usr/bin/env node
// Drives the group-move event recorder in a real Chrome (plan Phase A).
//
// Launches Chrome with a throwaway profile and --remote-debugging-pipe, loads
// ./recorder with the DevTools Extensions.loadUnpacked command (branded Chrome
// ignores --load-extension), opens the recorder's driver page, and then takes
// commands over a local HTTP port so scenarios can be run one at a time, with
// pauses for manual drags:
//
//   node tools/live-checks/group-move/run.mjs --profile <dir> [--port 47811] [--chrome <path>]
//   curl -s localhost:47811/call/s1                 run a scenario (driver.js S.*)
//   curl -s localhost:47811/save/s1                 save the log to results/s1.json
//   curl -s localhost:47811/stop-worker             stop the recorder's service worker
//   curl -s localhost:47811/restart                 quit Chrome, start it again (same profile, last session restored)
//   curl -s localhost:47811/restart?enable=1        the same, for a recorder disabled before the restart: enable it after
//   curl -s localhost:47811/reload                  reload the recorder (chrome.runtime.reload)
//   curl -s localhost:47811/disable  /enable        disable or enable the recorder through chrome://extensions
//   curl -s localhost:47811/quit
//
// With --extension <a copy of extension/>, the extension under test is
// loaded too, and these routes drive it through its own options page (so its
// commands take the real message path; the page sits in its own window):
//   curl -s 'localhost:47811/tl?expr=<expression>'  evaluate in that page
//   curl -s localhost:47811/tl-stop-worker          stop its service worker
//   curl -s 'localhost:47811/tl-use?id=<id>'        drive a copy installed by hand
//
// The HTTP port listens on 127.0.0.1 only. Never point --profile at a real profile.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
    process.argv.slice(2).reduce((pairs, value, i, all) => (value.startsWith('--') ? [...pairs, [value.slice(2), all[i + 1]]] : pairs), [])
);
const CHROME = args.chrome ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = args.profile && resolve(args.profile);
const PORT = Number(args.port ?? 47811);
const RECORDER = join(here, 'recorder');
const RESULTS = join(here, 'results');
const EXTENSION = args.extension && resolve(args.extension);

if (!PROFILE) {
    console.error('--profile <throwaway dir> is required');
    process.exit(2);
}

// ----------------------------------------------------------- CDP over a pipe

let browser = null; // { proc, send, on, extensionId, driverSession, version }

// `extra` is used by /restart: --restore-last-session makes Chrome restore the
// windows and groups of the previous run. (Writing session.restore_on_startup
// into Preferences does not work: Chrome resets it as a tampered tracked pref.)
function launch(extra = []) {
    return new Promise((resolveLaunch, rejectLaunch) => {
        const proc = spawn(
            CHROME,
            [
                '--remote-debugging-pipe',
                '--enable-unsafe-extension-debugging',
                `--user-data-dir=${PROFILE}`,
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-search-engine-choice-screen',
                ...extra
            ],
            { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }
        );
        const out = proc.stdio[3];
        const input = proc.stdio[4];
        let nextId = 1;
        const waiting = new Map();
        const listeners = new Set();
        let buffer = Buffer.alloc(0);

        input.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            let end;
            while ((end = buffer.indexOf(0)) !== -1) {
                const message = JSON.parse(buffer.subarray(0, end).toString('utf8'));
                buffer = buffer.subarray(end + 1);
                if (message.id && waiting.has(message.id)) {
                    const { ok, fail } = waiting.get(message.id);
                    waiting.delete(message.id);
                    message.error ? fail(new Error(`${message.error.message} ${message.error.data ?? ''}`)) : ok(message.result);
                } else {
                    for (const fn of listeners) fn(message);
                }
            }
        });
        proc.on('error', rejectLaunch);
        proc.on('exit', () => {
            for (const { fail } of waiting.values()) fail(new Error('Chrome exited'));
            waiting.clear();
        });

        const send = (method, params = {}, sessionId) =>
            new Promise((ok, fail) => {
                const id = nextId++;
                waiting.set(id, { ok, fail });
                out.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
            });
        const on = (fn) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
        };
        resolveLaunch({ proc, send, on });
    });
}

// `knownId`: after a restart, the recorder may already be installed in the
// profile. Loading it again would be an install of its own (onInstalled, and no
// onStartup for this start), so it is loaded only if the driver page can't open.
async function start(extra = [], knownId = null) {
    const b = await launch(extra);
    const { product } = await b.send('Browser.getVersion');
    browser = { ...b, extensionId: knownId, driverSession: null, version: product, extensionsSession: null };
    let loaded = false;
    let found = null;
    if (knownId) {
        // Give a restored session time to come up; ask chrome://extensions, not the driver page
        for (let i = 0; i < 15 && !found?.enabled; i++) {
            await new Promise((r) => setTimeout(r, 1000));
            found = await recorderState();
        }
        act('recorder at start', { state: found });
    }
    if (!knownId || found?.error || !found?.enabled || !(await openDriver(20))) {
        if (knownId) act('loading the recorder again');
        const { id } = await b.send('Extensions.loadUnpacked', { path: RECORDER });
        browser.extensionId = id;
        loaded = true;
        if (!(await openDriver())) throw new Error('driver page did not open after loading the recorder');
    }
    return { version: product, extensionId: browser.extensionId, loadedUnpacked: loaded };
}

// Open (or reopen) the driver page and attach to it. False if it doesn't load,
// for example because the recorder is disabled or not installed.
async function openDriver(tries = 10) {
    await new Promise((r) => setTimeout(r, 1000));
    const { targetId } = await browser.send('Target.createTarget', { url: `chrome-extension://${browser.extensionId}/driver.html` });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    browser.driverSession = sessionId;
    for (let i = 0; i < tries; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const r = await browser
            .send('Runtime.evaluate', { expression: 'typeof S', returnByValue: true }, sessionId)
            .catch(() => null);
        if (r?.result?.value === 'object') return true;
    }
    await browser.send('Target.closeTarget', { targetId }).catch(() => {});
    browser.driverSession = null;
    return false;
}

// ---------------------------------------------- the extension under test

const tl = { id: null, session: null, targetId: null };

async function loadTabLimiter() {
    const { id } = await browser.send('Extensions.loadUnpacked', { path: EXTENSION });
    tl.id = id;
    tl.session = null;
    return id;
}

async function openTabLimiterPage() {
    const { targetId } = await browser.send('Target.createTarget', {
        url: `chrome-extension://${tl.id}/options.html`,
        newWindow: true,
        background: true
    });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    tl.targetId = targetId;
    tl.session = sessionId;
    for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const r = await browser
            .send('Runtime.evaluate', { expression: 'typeof chrome?.runtime?.sendMessage', returnByValue: true }, sessionId)
            .catch(() => null);
        if (r?.result?.value === 'function') return;
    }
    throw new Error('the extension page did not load');
}

// Evaluate in the extension's options page. The driver's reset closes every window
// but its own, this page's too, so a failed call reopens the page and tries again.
async function tlEvaluate(expression) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            if (!tl.session) await openTabLimiterPage();
            const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, tl.session);
            if (result.exceptionDetails) {
                throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
            }
            return result.result.value;
        } catch (error) {
            tl.session = null;
            if (attempt === 1) throw error;
        }
    }
}

async function tlStopWorker() {
    if (!tl.session) await openTabLimiterPage();
    const versions = new Map();
    const off = browser.on((message) => {
        if (message.method === 'ServiceWorker.workerVersionUpdated' && message.sessionId === tl.session) {
            for (const v of message.params.versions) versions.set(v.versionId, v);
        }
    });
    try {
        await browser.send('ServiceWorker.enable', {}, tl.session);
        await new Promise((r) => setTimeout(r, 500));
        const running = [...versions.values()].filter((v) => v.runningStatus === 'running' || v.runningStatus === 'starting');
        for (const v of running) {
            await browser.send('ServiceWorker.stopWorker', { versionId: v.versionId }, tl.session);
        }
        await new Promise((r) => setTimeout(r, 1500));
        return { stopped: running.length, versions: [...versions.values()].map((v) => v.runningStatus) };
    } finally {
        off();
        await browser.send('ServiceWorker.disable', {}, tl.session).catch(() => {});
    }
}

// chrome://extensions has the management API, so it can disable and enable the
// recorder without a second helper extension.
// The driver's reset closes this page's window too, so a lost session is reopened once.
async function extensionsPage(expression) {
    for (let attempt = 0; attempt < 2; attempt++) {
        if (!browser.extensionsSession) {
            const { targetId } = await browser.send('Target.createTarget', { url: 'chrome://extensions' });
            const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
            await new Promise((r) => setTimeout(r, 1500));
            browser.extensionsSession = sessionId;
        }
        let result;
        try {
            result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, browser.extensionsSession);
        } catch (error) {
            browser.extensionsSession = null;
            if (attempt === 1) throw error;
            continue;
        }
        if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
        }
        return result.result.value;
    }
}

async function setEnabled(enabled) {
    const id = JSON.stringify(browser.extensionId);
    const before = await extensionsPage(`chrome.management.get(${id}).then((e) => e.enabled)`);
    await extensionsPage(`chrome.management.setEnabled(${id}, ${enabled})`);
    await new Promise((r) => setTimeout(r, 1500));
    const after = await extensionsPage(`chrome.management.get(${id}).then((e) => e.enabled)`);
    const driver = enabled ? await openDriver() : false;
    if (!enabled) browser.driverSession = null;
    return { before, after, driverOpen: driver };
}

async function evaluate(expression) {
    const result = await browser.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        browser.driverSession
    );
    if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
}

async function recorderWorkerTargets() {
    const { targetInfos } = await browser.send('Target.getTargets');
    return targetInfos.filter((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${browser.extensionId}/`));
}

// Stop the recorder's worker through the ServiceWorker domain of the driver page
// (same origin as the extension). Reports what it saw before and after.
async function stopWorker() {
    const versions = new Map();
    const off = browser.on((message) => {
        if (message.method === 'ServiceWorker.workerVersionUpdated' && message.sessionId === browser.driverSession) {
            for (const v of message.params.versions) versions.set(v.versionId, v);
        }
    });
    try {
        await browser.send('ServiceWorker.enable', {}, browser.driverSession);
        await new Promise((r) => setTimeout(r, 500));
        const before = await recorderWorkerTargets();
        const running = [...versions.values()].filter((v) => v.runningStatus === 'running' || v.runningStatus === 'starting');
        for (const v of running) {
            await browser.send('ServiceWorker.stopWorker', { versionId: v.versionId }, browser.driverSession);
        }
        await new Promise((r) => setTimeout(r, 1500));
        const after = await recorderWorkerTargets();
        return {
            method: 'ServiceWorker.stopWorker via the driver page session',
            versionsSeen: [...versions.values()].map((v) => ({ versionId: v.versionId, runningStatus: v.runningStatus, scriptURL: v.scriptURL })),
            workerTargetsBefore: before.length,
            workerTargetsAfter: after.length
        };
    } finally {
        off();
        await browser.send('ServiceWorker.disable', {}, browser.driverSession).catch(() => {});
    }
}

async function quit() {
    if (!browser) return;
    const { proc } = browser;
    const exited = new Promise((r) => proc.once('exit', r));
    await browser.send('Browser.close').catch(() => {});
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
    browser = null;
}

function save(name, log, extra = {}) {
    mkdirSync(RESULTS, { recursive: true });
    const file = join(RESULTS, `${name}.json`);
    writeFileSync(file, JSON.stringify({ name, chrome: browser.version, ...extra, log }, null, 2) + '\n');
    return file;
}

// ------------------------------------------------------------ control server

// The recorder's entry in the profile, read while Chrome is not running
function recorderInProfile(id) {
    try {
        const prefs = JSON.parse(readFileSync(join(PROFILE, 'Default', 'Secure Preferences'), 'utf8'));
        const entry = prefs.extensions?.settings?.[id];
        if (!entry) return { present: false };
        return { present: true, location: entry.location, state: entry.state ?? null, disableReasons: entry.disable_reasons ?? null };
    } catch (error) {
        return { error: String(error?.message ?? error) };
    }
}

const lastResult = new Map(); // scenario name -> driver return value, saved with its log

// Actions taken by this script, as markers on the same clock as the events
// (performance.timeOrigin + performance.now() is epoch milliseconds). They are
// kept here because the driver page can't write markers while the recorder is
// reloading or disabled.
const actions = [];
function act(label, extra = {}) {
    const entry = { abs: Date.now(), label, ...extra };
    actions.push(entry);
    console.log(JSON.stringify({ action: entry }));
}
async function recorderState() {
    const id = JSON.stringify(browser.extensionId);
    return extensionsPage(
        `chrome.management.get(${id}).then((e) => ({ enabled: e.enabled, disabledReason: e.disabledReason ?? null, installType: e.installType }))`
    ).catch((error) => ({ error: String(error?.message ?? error) }));
}

const routes = {
    async call(name, query) {
        const arg = query.get('arg');
        const value = await evaluate(`S[${JSON.stringify(name)}](${arg ?? ''})`);
        lastResult.set(name, value);
        return value;
    },
    async save(name, query) {
        const log = await evaluate('S.dump()');
        actions.forEach((a, i) => {
            log[`m_${a.abs.toFixed(3)}_run${i}`] = a;
        });
        const driverResult = lastResult.get(query.get('from') ?? name) ?? null;
        const notes = query.get('notes') ?? null;
        return { file: save(name, log, { driverResult, notes }) };
    },
    async eval(_name, query) {
        return evaluate(query.get('expr'));
    },
    async 'stop-worker'() {
        act('stop worker');
        return stopWorker();
    },
    // Health check before handing over for manual drags: open and close a tab in
    // the driver's window and confirm the recorder logged both events. (A
    // CDP-loaded recorder once lost its worker registration after days idle and
    // silently recorded nothing.)
    async probe() {
        return evaluate(`(async () => {
            const count = async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('e_') && !k.endsWith('_s')).length;
            const before = await count();
            const { windowId } = await chrome.tabs.getCurrent();
            const tab = await chrome.tabs.create({ windowId, url: 'about:blank', active: false });
            await chrome.tabs.remove(tab.id);
            await new Promise((r) => setTimeout(r, 1500));
            const logged = (await count()) - before;
            const registrations = (await navigator.serviceWorker.getRegistrations()).length;
            await chrome.storage.local.clear();
            return { ok: logged >= 2, logged, registrations };
        })()`);
    },
    async workers() {
        return recorderWorkerTargets();
    },
    // A browser restart that keeps the recorder installed. With ?enable=1, the
    // recorder was disabled before the restart and is enabled once Chrome is up.
    async restart(_name, query) {
        const id = browser.extensionId;
        act(query.get('enable') === '1' ? 'quit (recorder disabled)' : 'quit');
        await quit();
        act('profile after quit', { state: recorderInProfile(id) });
        if (query.get('enable') === '1') {
            const b = await launch(['--restore-last-session']);
            const { product } = await b.send('Browser.getVersion');
            browser = { ...b, extensionId: id, driverSession: null, version: product, extensionsSession: null };
            act('started (recorder disabled)');
            await new Promise((r) => setTimeout(r, 3000));
            act('enable');
            const enabled = await setEnabled(true);
            return { version: product, extensionId: id, loadedUnpacked: false, enabled };
        }
        const started = await start(['--restore-last-session'], id);
        act('driver attached after restart', { loadedUnpacked: started.loadedUnpacked });
        return started;
    },
    // chrome.runtime.reload() from the driver page: the same reload as the
    // button in chrome://extensions. The driver page closes and is reopened.
    // ?how=runtime: chrome.runtime.reload() from the driver page.
    // ?how=button (default): chrome.developerPrivate.reload, which is what the
    // Reload button in chrome://extensions calls.
    async reload(_name, query) {
        const how = query.get('how') ?? 'button';
        act(`reload (${how})`);
        if (how === 'runtime') {
            await browser
                .send('Runtime.evaluate', { expression: 'setTimeout(() => chrome.runtime.reload(), 50); true', returnByValue: true }, browser.driverSession)
                .catch(() => {});
        } else {
            await extensionsPage(`chrome.developerPrivate.reload(${JSON.stringify(browser.extensionId)}, { failQuietly: true })`);
        }
        await new Promise((r) => setTimeout(r, 3000));
        const state = await recorderState();
        act('after reload', { state });
        return { state, driverOpen: state.enabled ? await openDriver() : false };
    },
    async state() {
        return recorderState();
    },
    // Install the recorder the ordinary way, as a person would: Developer mode
    // on, then the recorder folder dropped onto chrome://extensions. An
    // extension loaded with Extensions.loadUnpacked does not survive a browser
    // restart, so onStartup can only be observed for one installed like this.
    // ?path=<a copy of recorder/>: a copy has its own extension ID, so the
    // debugging-loaded recorder needn't be uninstalled first. The driver then
    // switches to the copy.
    async 'install-dropped'(_name, query) {
        const path = resolve(query.get('path') ?? RECORDER);
        act('install by drop', { path: path === RECORDER ? 'recorder/' : 'a copy' });
        const listDev = () =>
            extensionsPage(
                "chrome.developerPrivate.getExtensionsInfo().then((list) => list.filter((e) => e.location === 'UNPACKED').map((e) => ({ id: e.id, path: e.path, state: e.state })))"
            );
        const before = await listDev();
        await extensionsPage('chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })');
        await new Promise((r) => setTimeout(r, 1000));
        const point = { x: 400, y: 300 };
        const data = { items: [], files: [path], dragOperationsMask: 1 };
        for (const type of ['dragEnter', 'dragOver', 'drop']) {
            await browser.send('Input.dispatchDragEvent', { type, ...point, data }, browser.extensionsSession);
            await new Promise((r) => setTimeout(r, 300));
        }
        await new Promise((r) => setTimeout(r, 3000));
        const after = await listDev();
        const added = after.filter((e) => !before.some((b) => b.id === e.id));
        act('after drop', { state: { added: added.map((e) => ({ id: e.id, state: e.state })) } });
        if (added.length !== 1) return { before: before.length, after: after.length, added };
        browser.extensionId = added[0].id;
        return { added, driverOpen: await openDriver(20) };
    },
    // Drive a recorder installed by hand (Load unpacked), by its ID
    async use(_name, query) {
        browser.extensionId = query.get('id');
        act('use recorder installed by hand');
        return { state: await recorderState(), driverOpen: await openDriver(20) };
    },
    // Evaluate in chrome://extensions (developerPrivate and management APIs)
    async ext(_name, query) {
        return extensionsPage(query.get('expr'));
    },
    async act(name) {
        act(name);
        return { ok: true };
    },
    async disable() {
        act('disable');
        return setEnabled(false);
    },
    async enable() {
        act('enable');
        return setEnabled(true);
    },
    async tl(_name, query) {
        return tlEvaluate(query.get('expr'));
    },
    async 'tl-stop-worker'() {
        act('stop the extension under test');
        return tlStopWorker();
    },
    async 'tl-use'(_name, query) {
        tl.id = query.get('id');
        tl.session = null;
        act('use the extension under test, installed by hand');
        return { id: tl.id, page: await tlEvaluate('location.pathname') };
    },
    async 'tl-load'() {
        return { id: await loadTabLimiter() };
    },
    async quit() {
        await quit();
        setTimeout(() => process.exit(0), 100);
        return { ok: true };
    }
};

const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const [, route, name] = url.pathname.split('/');
    const handler = routes[route];
    res.setHeader('content-type', 'application/json');
    if (!handler) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: `unknown route ${route}` }));
        return;
    }
    try {
        res.end(JSON.stringify(await handler(name, url.searchParams), null, 2));
    } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
    }
});

const info = await start();
if (EXTENSION) info.extensionUnderTest = await loadTabLimiter();
// (start() sets `browser`; restart and reload reuse the recorder's ID)
server.listen(PORT, '127.0.0.1', () => {
    console.log(JSON.stringify({ listening: PORT, ...info }));
});
