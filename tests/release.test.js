import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// tools/release.sh is run for real in throwaway git repositories, with a stand-in
// package.sh. It must refuse in the wrong state, build only in the right one, and
// never talk to the network, commit or tag.
const OK = process.platform !== 'win32' && spawnSync('git', ['--version']).status === 0;
const SCRIPT = new URL('../tools/release.sh', import.meta.url).pathname;

let base;
before(() => {
    base = mkdtempSync(join(tmpdir(), 'tl-release-'));
});
after(() => rmSync(base, { recursive: true, force: true }));

let counter = 0;
function repo({ branch = 'main', passingTests = true, tag = null } = {}) {
    const dir = join(base, `r${counter++}`);
    for (const sub of ['tools', 'tests', 'extension']) mkdirSync(join(dir, sub), { recursive: true });
    copyFileSync(SCRIPT, join(dir, 'tools/release.sh'));
    chmodSync(join(dir, 'tools/release.sh'), 0o755);
    writeFileSync(join(dir, 'tools/package.sh'),
        '#!/usr/bin/env bash\nroot="$(cd "$(dirname "$0")/.." && pwd)"\nmkdir -p "$root/dist"\ncp "$root/extension/marker.txt" "$root/dist/tab-limiter-1.2.3.zip"\necho packaged\n');
    chmodSync(join(dir, 'tools/package.sh'), 0o755);
    writeFileSync(join(dir, 'extension/manifest.json'), '{"version":"1.2.3"}');
    writeFileSync(join(dir, 'extension/marker.txt'), 'ORIGINAL');
    writeFileSync(join(dir, 'tests/ok.test.js'),
        `import test from 'node:test';\nimport assert from 'node:assert';\nimport { writeFileSync } from 'node:fs';\n` +
        `test('x', () => {\n  if (process.env.EDIT_TARGET) writeFileSync(process.env.EDIT_TARGET, 'EDITED');\n  assert.ok(${passingTests});\n});\n`);
    writeFileSync(join(dir, '.gitignore'), 'dist/\n');
    const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', branch);
    git('add', '-A');
    git('commit', '-qm', 'init');
    if (tag) git('tag', tag);
    return { dir, git };
}

// The outer test runner marks its children (NODE_TEST_CONTEXT); a nested `node --test`
// that inherits it would not report failures, so the script runs without it.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
const run = (dir, args = [], env = {}) =>
    spawnSync(join(dir, 'tools/release.sh'), args, { cwd: dir, encoding: 'utf8', env: { ...cleanEnv(), ...env } });

describe('tools/release.sh', { skip: !OK }, () => {
    it('builds the ZIP from a clean main with passing tests and prints the next steps', () => {
        const { dir } = repo();
        const r = run(dir);
        assert.equal(r.status, 0, r.stderr);
        assert.ok(existsSync(join(dir, 'dist/tab-limiter-1.2.3.zip')));
        assert.match(r.stdout, /Version 1\.2\.3 is ready/);
        assert.match(r.stdout, /sha256: [0-9a-f]{64}/);
        assert.match(r.stdout, /Upload new package/);
    });

    it('does not commit, tag or touch the working tree', () => {
        const { dir, git } = repo();
        const before = git('rev-parse', 'HEAD').stdout;
        run(dir);
        assert.equal(git('rev-parse', 'HEAD').stdout, before);
        assert.equal(git('tag', '-l').stdout, '');
        assert.equal(git('status', '--porcelain').stdout, '');
    });

    it('refuses on a branch other than main', () => {
        const { dir } = repo({ branch: 'sh-dev' });
        const r = run(dir);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /release from main/);
        assert.ok(!existsSync(join(dir, 'dist')));
    });

    it('refuses a dirty working tree', () => {
        const { dir } = repo();
        writeFileSync(join(dir, 'extension/manifest.json'), '{"version":"1.2.4"}');
        const r = run(dir);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /not clean/);
        assert.ok(!existsSync(join(dir, 'dist')));
    });

    it('refuses an untracked file too', () => {
        const { dir } = repo();
        writeFileSync(join(dir, 'stray.txt'), 'x');
        const r = run(dir);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /not clean/);
    });

    it('refuses when the tests fail', () => {
        const { dir } = repo({ passingTests: false });
        const r = run(dir);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /tests fail/);
        assert.ok(!existsSync(join(dir, 'dist')));
    });

    it('refuses a version that is already tagged', () => {
        const { dir } = repo({ tag: 'v1.2.3' });
        const r = run(dir);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /v1\.2\.3 is already tagged/);
        assert.ok(!existsSync(join(dir, 'dist')));
    });

    it('packages the recorded commit, not edits made after the tests (P2)', () => {
        const { dir, git } = repo();
        // The test run edits a tracked file in the real working tree, as an editor could
        const r = run(dir, [], { EDIT_TARGET: join(dir, 'extension/marker.txt') });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(readFileSync(join(dir, 'extension/marker.txt'), 'utf8'), 'EDITED', 'the edit happened');
        assert.equal(readFileSync(join(dir, 'dist/tab-limiter-1.2.3.zip'), 'utf8'), 'ORIGINAL');
        assert.match(r.stdout, new RegExp(`built from commit ${git('rev-parse', 'HEAD').stdout.trim()}`));
    });

    it('tells you to tag the commit that was built (P3)', () => {
        const { dir, git } = repo();
        const built = git('rev-parse', 'HEAD').stdout.trim();
        const r = run(dir);
        assert.match(r.stdout, new RegExp(`git tag v1\\.2\\.3 ${built}\\b`));
        // a later commit must not change what the instruction names
        writeFileSync(join(dir, 'later.txt'), 'x');
        git('add', '-A');
        git('commit', '-qm', 'later');
        assert.notEqual(git('rev-parse', 'HEAD').stdout.trim(), built);
        assert.match(r.stdout, new RegExp(built));
    });

    it('takes no arguments', () => {
        const { dir } = repo();
        assert.equal(run(dir, ['--upload']).status, 2);
    });

    it('contains no network or credential code', () => {
        const text = readFileSync(SCRIPT, 'utf8');
        assert.doesNotMatch(text, /curl|wget|https?:\/\/|CWS_|refresh_token/i);
    });
});
