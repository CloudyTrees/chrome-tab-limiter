import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, copyFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The installers are run for real in throwaway folders; the browser is never
// started (TAB_LIMITER_NO_BROWSER). They need the zip and unzip programs.
const has = (program) => spawnSync(program, ['-v'], { stdio: 'ignore' }).status !== null;
const TOOLS_OK = has('zip') && has('unzip') && process.platform !== 'win32';
const SCRIPT = new URL('../tools/install.sh', import.meta.url).pathname;
const BAT = readFileSync(new URL('../tools/install.bat', import.meta.url), 'utf8');

const REQUIRED = ['manifest.json', 'background.js', 'popup.html', 'options.html'];
let root;

before(() => {
    root = mkdtempSync(join(tmpdir(), 'tl-install-'));
});
after(() => rmSync(root, { recursive: true, force: true }));

// A folder holding install.sh and nothing else
function workspace(name) {
    const dir = join(root, name);
    mkdirSync(dir);
    copyFileSync(SCRIPT, join(dir, 'install.sh'));
    return dir;
}

// Make a ZIP of a small fake extension with the given files
function makeZip(dir, zipName, { files = REQUIRED, extra = () => {}, flags = '-qr' } = {}) {
    const content = mkdtempSync(join(root, 'content-'));
    for (const file of files) writeFileSync(join(content, file), `// ${file}\n`);
    extra(content);
    const result = spawnSync('zip', [flags, join(dir, zipName), '.'], { cwd: content });
    assert.equal(result.status, 0, result.stderr?.toString());
}

function install(dir) {
    // Run from somewhere else: the installer must use its own folder, not the caller's
    return spawnSync('bash', [join(dir, 'install.sh')], {
        cwd: root,
        env: { ...process.env, TAB_LIMITER_NO_BROWSER: '1' },
        encoding: 'utf8'
    });
}

const leftovers = (dir) => readdirSync(dir).filter((name) => name.startsWith('.tab-limiter-'));
const OLD = (dir) => {
    mkdirSync(join(dir, 'tab-limiter-extension'));
    writeFileSync(join(dir, 'tab-limiter-extension', 'sentinel.txt'), 'old installation');
};

describe('tools/install.sh', { skip: !TOOLS_OK && 'needs zip and unzip' }, () => {
    it('installs a good archive and leaves no temporary folder behind', () => {
        const dir = workspace('good');
        makeZip(dir, 'tab-limiter-1.0.0.zip');
        const result = install(dir);

        assert.equal(result.status, 0, result.stderr);
        for (const file of REQUIRED) assert.ok(existsSync(join(dir, 'tab-limiter-extension', file)), file);
        assert.deepEqual(leftovers(dir), []);
        assert.match(result.stdout, /Extension extracted/);
    });

    it('S-11: a corrupt archive keeps the existing installation, fails, and reports no success', () => {
        const dir = workspace('corrupt');
        OLD(dir);
        writeFileSync(join(dir, 'tab-limiter-1.0.0.zip'), 'not a zip');
        const result = install(dir);

        assert.notEqual(result.status, 0);
        assert.ok(existsSync(join(dir, 'tab-limiter-extension', 'sentinel.txt')), 'the old installation is untouched');
        assert.equal(/Extension extracted|Next steps/.test(result.stdout), false);
        assert.match(result.stderr, /Nothing was changed/);
        assert.deepEqual(leftovers(dir), []);
    });

    it('S-11: an archive without the required files keeps the existing installation', () => {
        const dir = workspace('incomplete');
        OLD(dir);
        makeZip(dir, 'tab-limiter-1.0.0.zip', { files: ['manifest.json', 'popup.html'] });
        const result = install(dir);

        assert.notEqual(result.status, 0);
        assert.ok(existsSync(join(dir, 'tab-limiter-extension', 'sentinel.txt')));
        assert.match(result.stderr, /missing background\.js/);
        assert.deepEqual(leftovers(dir), []);
    });

    it('replaces an existing installation completely when the new archive is good', () => {
        const dir = workspace('replace');
        OLD(dir);
        makeZip(dir, 'tab-limiter-1.0.0.zip');
        const result = install(dir);

        assert.equal(result.status, 0, result.stderr);
        assert.equal(existsSync(join(dir, 'tab-limiter-extension', 'sentinel.txt')), false, 'old files are gone');
        assert.ok(existsSync(join(dir, 'tab-limiter-extension', 'manifest.json')));
        assert.deepEqual(leftovers(dir), []);
    });

    it('S-10: hostile file names are handled as data and run nothing', () => {
        const names = [
            "tab-limiter-';touch PWNED;#.zip",
            'tab-limiter-$(touch PWNED).zip',
            'tab-limiter-`touch PWNED`.zip',
            'tab-limiter-a b  c.zip',
            'tab-limiter-&touch PWNED&.zip',
            'tab-limiter-"; touch PWNED; ".zip',
            'tab-limiter-*.zip.zip',
            'tab-limiter-%PATH%.zip'
        ];
        for (const [index, name] of names.entries()) {
            const dir = workspace(`hostile-${index}`);
            makeZip(dir, name);
            const result = install(dir);

            assert.equal(result.status, 0, `${name}: ${result.stderr}`);
            assert.ok(existsSync(join(dir, 'tab-limiter-extension', 'manifest.json')), name);
            assert.equal(existsSync(join(dir, 'PWNED')), false, `${name} ran a command`);
            assert.equal(existsSync(join(root, 'PWNED')), false, `${name} ran a command`);
        }
    });

    it('refuses to guess when there is no archive or more than one', () => {
        const none = workspace('none');
        OLD(none);
        assert.notEqual(install(none).status, 0);
        assert.ok(existsSync(join(none, 'tab-limiter-extension', 'sentinel.txt')));

        const two = workspace('two');
        makeZip(two, 'tab-limiter-1.0.0.zip');
        makeZip(two, 'tab-limiter-1.0.1.zip');
        const result = install(two);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /More than one/);
        assert.equal(existsSync(join(two, 'tab-limiter-extension')), false);
    });

    it('does not write outside the extension folder for a path-traversal entry', () => {
        const dir = workspace('traversal');
        const zipPath = join(dir, 'tab-limiter-1.0.0.zip');
        const python = spawnSync('python3', [
            '-c',
            `import zipfile,sys
z=zipfile.ZipFile(sys.argv[1],'w')
for f in ['manifest.json','background.js','popup.html','options.html']: z.writestr(f,'x')
z.writestr('../escaped.txt','x')
z.close()`,
            zipPath
        ]);
        if (python.status !== 0) return; // no python: skip quietly
        install(dir);

        assert.equal(existsSync(join(root, 'escaped.txt')), false);
        assert.equal(existsSync(join(dir, 'escaped.txt')), false);
    });

    it('refuses an archive that contains a symbolic link', () => {
        const dir = workspace('symlink');
        OLD(dir);
        makeZip(dir, 'tab-limiter-1.0.0.zip', {
            flags: '-qry',
            extra: (content) => symlinkSync('manifest.json', join(content, 'link')) // harmless target: any link is refused
        });
        const result = install(dir);

        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /symbolic links/);
        assert.ok(existsSync(join(dir, 'tab-limiter-extension', 'sentinel.txt')));
    });
});

// The Windows installer cannot be run here. These checks hold it to the rules that
// keep a hostile file name from becoming code.
describe('tools/install.bat (static checks; not run on Windows)', () => {
    const lines = BAT.split(/\r?\n/).filter((line) => !/^\s*rem\b/i.test(line));
    const code = lines.join('\n');

    it('never writes the archive name out: %TL_ZIP% does not appear', () => {
        assert.equal(/%TL_ZIP%/i.test(code), false);
        assert.equal(/!TL_ZIP!/i.test(code), false);
    });

    it('stores the name only with a quoted set, and reads it as $env:TL_ZIP', () => {
        assert.match(code, /set "TL_ZIP=%%f"/);
        const powershell = lines.filter((line) => /powershell/i.test(line));
        assert.equal(powershell.length, 1);
        assert.match(powershell[0], /-LiteralPath \$env:TL_ZIP/);
        assert.equal(/%/.test(powershell[0].replace(/%~dp0/g, '')), false, 'no batch expansion inside the PowerShell command');
        assert.match(powershell[0], /-NoProfile/);
    });

    it('does not use the old interpolated pattern or delayed expansion', () => {
        assert.equal(/ZIPFILE/.test(code), false);
        assert.equal(/EnableDelayedExpansion/i.test(code), false);
    });

    it('extracts into a separate folder and checks it before touching the old one', () => {
        const extract = code.indexOf('Expand-Archive');
        const check = code.indexOf('manifest.json');
        const moveAside = code.indexOf('ren "%TL_DEST%"');
        assert.ok(extract > 0 && check > extract && moveAside > check);
        assert.equal(/rmdir[^\n]*%TL_DEST%/.test(code), false, 'the installed folder is never deleted directly');
        assert.match(code, /if errorlevel 1 goto :extractfailed/);
        assert.match(code, /exit \/b 1/);
    });

    it('is the version the documentation points to', () => {
        const docs = readFileSync(new URL('../chrome-tab-limiter/packaging_instructions.md', import.meta.url), 'utf8');
        assert.ok(docs.includes('tools/install.bat') && docs.includes('tools/install.sh'));
        assert.equal(docs.includes('ZIPFILE'), false, 'the old inline snippet is gone');
    });
});
