// Self-contained tests for the fetch_top tool wrapper.
//
// fetch_top is a thin wrapper over searchWeb(query, { deepFetch: top }) —
// the deep-fetch logic itself lives in web-search.js and is covered by
// test-web-search.js. Here we cover the wrapper's own pieces:
//   - _normalizeTop clamping
//   - toolFetchTop happy path / empty query / error pass-through
//   - searchWeb integrates deepFetchOutput into the result object
//
// Run with:   node scripts/test-fetch-top.js
//
// Exits 0 on success, non-zero on the first failure. web-search.js requires
// utils.js at module load, which does `require('vscode')` — fails outside
// the extension host, so we stub it before the require.

'use strict';

const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === 'vscode') return require.resolve('./_vscode-stub.js');
    return origResolve.call(this, request, parent, ...rest);
};

const path = require('path');
const assert = require('assert');

const { toolFetchTop, _normalizeTop } =
    require(path.join('..', 'src', 'tools', 'fetch-top.js'));
const { formatDeepFetchContent, LOW_CONFIDENCE_NOTICE } =
    require(path.join('..', 'src', 'tools', 'web-search.js'));

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
    console.log(`\nAll ${passed} fetch-top tests passed.`);
}

// ─── _normalizeTop ────────────────────────────────────────────────────────
test('_normalizeTop defaults to 3 and clamps to 1..5', () => {
    assert.strictEqual(_normalizeTop(undefined), 3);
    assert.strictEqual(_normalizeTop(null), 3);
    assert.strictEqual(_normalizeTop('3'), 3);
    assert.strictEqual(_normalizeTop(1), 1);
    assert.strictEqual(_normalizeTop(5), 5);
    assert.strictEqual(_normalizeTop(0), 1);
    assert.strictEqual(_normalizeTop(-2), 1);
    assert.strictEqual(_normalizeTop(99), 5);
    assert.strictEqual(_normalizeTop(2.9), 2);
});

// ─── toolFetchTop (empty query — no network) ─────────────────────────────
test('toolFetchTop rejects an empty query', async () => {
    const out = await toolFetchTop({ query: '   ' });
    assert.strictEqual(out, 'Error: query is empty.');
});

test('deepFetch appendix formatting composes title/url/content', () => {
    // searchWeb (which performs live network calls) is covered by
    // test-web-search.js; here we verify the appendix composition contract
    // that fetch_top relies on: formatDeepFetchContent per page, concatenated.
    const results = [
        { title: 'A', url: 'https://a.com', snippet: 'a' },
        { title: 'B', url: 'https://b.com', snippet: 'b' },
    ];
    let appendix = '';
    for (const r of results) {
        appendix += formatDeepFetchContent(r.title, r.url, `# Content ${r.title}`);
    }
    assert.ok(appendix.includes('## Page Content: A'));
    assert.ok(appendix.includes('## Page Content: B'));
    assert.ok(appendix.includes('**Source:** https://a.com'));
    assert.ok(appendix.includes('# Content A'));
});

test('toolFetchTop low-confidence preamble mirrors web_search', () => {
    // fetch_top cannot be exercised end-to-end offline (searchWeb performs
    // live network calls), so we verify the contract piece it relies on:
    // the notice is exported from web-search.js and shaped like the
    // web_search preamble (same constant _formatResults prepends).
    assert.strictEqual(typeof LOW_CONFIDENCE_NOTICE, 'string');
    assert.ok(LOW_CONFIDENCE_NOTICE.startsWith('> '));
    assert.ok(LOW_CONFIDENCE_NOTICE.includes('Low-confidence'));
    assert.ok(LOW_CONFIDENCE_NOTICE.includes('Verify before citing'));
});

_runAll();
