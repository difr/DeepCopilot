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
const { toolGrepSearch } = require(path.join('..', 'src', 'tools', 'file-read.js'));

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

test('grep by FILE path finds matches (Windows mask regression)', async () => {
    const out = await toolGrepSearch({ path: 'src/tools/utils.js', pattern: 'function truncate' });
    assert.ok(!out.startsWith('(no matches)'), `expected matches, got: ${out}`);
    assert.ok(out.includes('function truncate'), `missing match line: ${out}`);
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

_runAll();
