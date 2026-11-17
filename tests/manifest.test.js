import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';

const ROOT = new URL('../chrome-tab-limiter/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', ROOT), 'utf8'));
const csp = Object.fromEntries(
    manifest.content_security_policy.extension_pages
        .split(';')
        .map((directive) => directive.trim())
        .filter(Boolean)
        .map((directive) => {
            const [name, ...sources] = directive.split(/\s+/);
            return [name, sources];
        })
);

describe('manifest: least privilege (S-2)', () => {
    it('asks for exactly the permissions the extension uses, and no host access', () => {
        assert.deepEqual([...manifest.permissions].sort(), ['storage', 'tabGroups', 'tabs']);
        for (const key of ['host_permissions', 'optional_permissions', 'optional_host_permissions', 'content_scripts', 'web_accessible_resources', 'externally_connectable']) {
            assert.equal(key in manifest, false, `${key} must not be declared`);
        }
    });

    it('the code does not use the permissions it does not ask for', () => {
        const sources = ['background.js', 'popup.js', 'options.js'].map((file) => readFileSync(new URL(file, ROOT), 'utf8')).join('\n');
        for (const api of ['chrome.cookies', 'chrome.history', 'chrome.identity', 'chrome.webRequest', 'chrome.notifications', 'chrome.scripting', 'chrome.storage.sync']) {
            assert.equal(sources.includes(api), false, api);
        }
    });
});

describe('manifest: content security policy (S-4)', () => {
    it('allows scripts and objects only from the extension itself', () => {
        assert.deepEqual(csp['script-src'], ["'self'"]);
        assert.deepEqual(csp['object-src'], ["'self'"]);
    });

    it('blocks every network connection, frame, form post and base URL', () => {
        assert.deepEqual(csp['connect-src'], ["'none'"]);
        assert.deepEqual(csp['frame-src'], ["'none'"]);
        assert.deepEqual(csp['form-action'], ["'none'"]);
        assert.deepEqual(csp['base-uri'], ["'none'"]);
    });

    it('allows images only from the extension: no data: and no remote hosts', () => {
        assert.deepEqual(csp['img-src'], ["'self'"]);
    });

    it('no page uses an image, so img-src does not need more', () => {
        for (const file of ['popup.html', 'options.html']) {
            assert.equal(/<img\b/i.test(readFileSync(new URL(file, ROOT), 'utf8')), false, file);
        }
    });

    it('the pages load no inline or remote script', () => {
        for (const file of ['popup.html', 'options.html']) {
            const html = readFileSync(new URL(file, ROOT), 'utf8');
            for (const [, tag] of html.matchAll(/<script\b([^>]*)>/gi)) {
                assert.match(tag, /src="[^":]+"/, `${file}: ${tag}`);
            }
            assert.equal(/\son[a-z]+\s*=/i.test(html), false, `${file} has an inline event handler`);
        }
    });
});

describe('shipped scripts', () => {
    const walk = (dir) =>
        readdirSync(dir).flatMap((name) => {
            const path = new URL(`${name}${statSync(new URL(`${dir.href}${name}`)).isDirectory() ? '/' : ''}`, dir);
            return statSync(path).isDirectory() ? walk(path) : [path];
        });

    it('make no network request and contain no remote URL', () => {
        const files = walk(ROOT).filter((path) => /\.(js|html|css)$/.test(path.pathname));
        assert.ok(files.length > 10);
        for (const path of files) {
            const text = readFileSync(path, 'utf8');
            assert.equal(/\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|importScripts)\b\s*\(/.test(text), false, path.pathname);
            assert.equal(/\beval\s*\(|new\s+Function\s*\(/.test(text), false, path.pathname);
            assert.equal(/https?:\/\//.test(text), false, `${path.pathname} contains a URL`);
        }
    });
});
