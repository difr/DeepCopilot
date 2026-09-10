// Tests for toolGrepSearch (file-read.js), especially the Windows findstr
// branch. Regression: passing a FILE as `path` used to return "(no matches)"
// because findstr got a mask "file.js\*" it cannot open; only directories
// worked. See src/tools/file-read.js.
//
// Run with:   node scripts/test-grep-search.js
// Exits 0 on success, non-zero on the first failure.

'use strict';

// Stub vscode BEFORE requiring anything from src/. The default stub has no
// workspaceFolders, so ensurePathAllowed() would reject every path — provide
// one rooted at the repo (cwd), which is what wsRoot()/isInsideWorkspace use.
const Module = require('module');
const origResolve = Module._resolveFilename;
const fs = require('fs');
const path = require('path');

const repoRoot = process.cwd();
const stubPath = path.join(__dirname, '_vscode-stub.js');
const stubSource = fs.readFileSync(stubPath, 'utf8');
const patchedStub = stubSource.replace(
    "workspace: {",
    `workspace: {
        workspaceFolders: [{ uri: { fsPath: ${JSON.stringify(repoRoot)} } }],`
);
// Write the patched stub outside the repo so it never shows up in git status.
const os = require('os');
const patchedStubFile = path.join(os.tmpdir(), `_vscode-grep-stub-${process.pid}.js`);
fs.writeFileSync(patchedStubFile, patchedStub);
process.on('exit', () => { try { fs.unlinkSync(patchedStubFile); } catch {} });

Module._resolveFilename = function (request, parent, ...rest) {
    if (request === 'vscode') return patchedStubFile;
    return origResolve.call(this, request, parent, ...rest);
};

const assert = require('assert');
const { toolGrepSearch, _gitGrepUsable, _isIgnoredPath, rgPath } = require(path.join('..', 'src', 'tools', 'file-read.js'));

let passed = 0;
const _tests = [];
function test(name, fn) { _tests.push([name, fn]); }

async function _runAll() {
    for (const [name, fn] of _tests) {
        try {
            await fn();
            console.log(`\u2713 ${name}`);
            passed++;
        } catch (e) {
            console.error(`\u2717 ${name}\n   ${e.stack || e.message}`);
            process.exit(1);
        }
    }
    console.log(`\nAll ${passed} grep-search tests passed.`);
}

// ─── engine selection ────────────────────────────────────────────────────
test('git grep is usable for a tracked file', () => {
    assert.ok(_gitGrepUsable(path.join(repoRoot, 'src', 'tools', 'utils.js')));
});

test('git grep is NOT usable for an untracked file', () => {
    const probe = path.join(repoRoot, '_grep_probe_untracked.js');
    fs.writeFileSync(probe, '// probe\n');
    try {
        assert.ok(!_gitGrepUsable(probe));
    } finally { fs.unlinkSync(probe); }
});

test('git grep is NOT usable for a dir with untracked files', () => {
    const dir = path.join(repoRoot, 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '_grep_probe_untracked.js');
    fs.writeFileSync(probe, '// probe\n');
    try {
        assert.ok(!_gitGrepUsable(dir));
    } finally { fs.unlinkSync(probe); }
});

test('git grep is usable for a dir with only tracked files', () => {
    assert.ok(_gitGrepUsable(path.join(repoRoot, 'src')));
});

// ─── end-to-end through the engine chain ────────────────────────────────
test('grep by FILE path finds matches (tracked → git grep)', async () => {
    const out = await toolGrepSearch({ path: 'src/tools/utils.js', pattern: 'function truncate' });
    assert.ok(!out.startsWith('(no matches)'), `expected matches, got: ${out}`);
    assert.ok(out.includes('function truncate'), `missing match line: ${out}`);
});

test('grep by untracked FILE falls back to findstr (Windows mask regression)', async () => {
    const probe = path.join(repoRoot, '_grep_probe_findstr.js');
    fs.writeFileSync(probe, '// probe token_alpha_1\n');
    try {
        const out = await toolGrepSearch({ path: '_grep_probe_findstr.js', pattern: 'token_alpha_1' });
        assert.ok(!out.startsWith('(no matches)'), `expected findstr match, got: ${out}`);
        assert.ok(out.includes('token_alpha_1'), `missing match line: ${out}`);
    } finally { fs.unlinkSync(probe); }
});

test('grep by DIRECTORY path still works', async () => {
    const out = await toolGrepSearch({ path: 'src/tools', pattern: 'function truncate' });
    assert.ok(out.includes('utils.js'), `expected utils.js hit, got: ${out}`);
});

test('grep by file path with regex works', async () => {
    const out = await toolGrepSearch({ path: 'src/tools/utils.js', pattern: 'truncate\\(' , is_regex: true });
    assert.ok(!out.startsWith('(no matches)'), `expected regex matches, got: ${out}`);
});

test('grep by file path with no matches returns (no matches)', async () => {
    const out = await toolGrepSearch({ path: 'src/tools/utils.js', pattern: 'zzz_no_such_string_zzz' });
    assert.ok(out.startsWith('(no matches)'), `expected (no matches), got: ${out}`);
});

test('grep is case-sensitive (no /i in findstr branch)', async () => {
    const upper = await toolGrepSearch({ path: 'src/tools/utils.js', pattern: 'MAX_OUTPUT' });
    assert.ok(upper.includes('MAX_OUTPUT'), `expected MAX_OUTPUT hit, got: ${upper}`);
    const lower = await toolGrepSearch({ path: 'src/tools/utils.js', pattern: 'max_output' });
    assert.ok(lower.startsWith('(no matches)'), `expected (no matches) for lowercase, got: ${lower}`);
});

test('grep by directory with include mask filters results', async () => {
    const js = await toolGrepSearch({ path: 'src/tools', pattern: 'function truncate', include: '*.js' });
    assert.ok(!js.startsWith('(no matches)'), `expected .js hits, got: ${js}`);
    const md = await toolGrepSearch({ path: 'src/tools', pattern: 'function truncate', include: '*.md' });
    assert.ok(md.startsWith('(no matches)'), `expected (no matches) for *.md, got: ${md}`);
});

test('grep by missing path returns error, not crash', async () => {
    const out = await toolGrepSearch({ path: 'src/tools/does-not-exist.js', pattern: 'x' });
    assert.ok(typeof out === 'string' && out.length > 0, `expected non-empty result, got: ${out}`);
});

// ─── include_ignored / explicitly targeted ignored paths ────────────────────
// `out/` is .gitignore'd, so ignore-aware engines (ripgrep, git grep) skip it.
const IGNORED_PROBE_DIR = path.join(repoRoot, 'out', '_grep_probe_ignored');

async function withIgnoredProbe(token, fn) {
    fs.mkdirSync(IGNORED_PROBE_DIR, { recursive: true });
    fs.writeFileSync(path.join(IGNORED_PROBE_DIR, 'probe.js'), `// ${token}\n`);
    try {
        await fn();
    } finally {
        try { fs.rmSync(IGNORED_PROBE_DIR, { recursive: true, force: true }); } catch {}
    }
}

test('include_ignored finds matches inside a .gitignore\'d directory', async () => {
    await withIgnoredProbe('token_ignored_alpha', async () => {
        const out = await toolGrepSearch({
            path: 'out/_grep_probe_ignored', pattern: 'token_ignored_alpha', include_ignored: true,
        });
        assert.ok(out.includes('token_ignored_alpha'), `expected hit, got: ${out}`);
    });
});

test('an explicit non-root path also searches ignored locations', async () => {
    await withIgnoredProbe('token_ignored_beta', async () => {
        const out = await toolGrepSearch({ path: 'out/_grep_probe_ignored', pattern: 'token_ignored_beta' });
        assert.ok(out.includes('token_ignored_beta'), `expected hit via explicit path, got: ${out}`);
    });
});

test('include_ignored does not break ordinary searches', async () => {
    const out = await toolGrepSearch({
        path: 'src/tools/utils.js', pattern: 'function truncate', include_ignored: true,
    });
    assert.ok(out.includes('function truncate'), `expected hit, got: ${out}`);
});

test('root scan skips ignored files and hints about include_ignored', async () => {
    // findstr / grep have no .gitignore support, so the skip only applies to
    // ignore-aware engines — this assertion is meaningful with ripgrep only.
    if (!rgPath()) return;
    await withIgnoredProbe('token_ignored_gamma', async () => {
        const out = await toolGrepSearch({ pattern: 'token_ignored_gamma' });
        assert.ok(out.startsWith('(no matches)'), `expected skip of ignored dir, got: ${out}`);
        assert.ok(out.includes('include_ignored'), `expected include_ignored hint, got: ${out}`);
    });
});

test('_isIgnoredPath distinguishes ignored from tracked locations', () => {
    assert.ok(_isIgnoredPath(path.join(repoRoot, 'out', 'anything.js')), 'expected out/ to be ignored');
    assert.ok(_isIgnoredPath(path.join(repoRoot, '.deep-copilot', 'logs')), 'expected .deep-copilot/ to be ignored');
    assert.ok(!_isIgnoredPath(path.join(repoRoot, 'src', 'tools', 'utils.js')), 'expected src/ not to be ignored');
});

_runAll();
