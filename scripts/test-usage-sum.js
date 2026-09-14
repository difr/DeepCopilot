// Tests for sumUsage(): a single turn spans several iterations, and the record
// persisted for it (plus the session totals derived from it) must be the sum of
// all of them — not just the last one.
//
// Run with:   node scripts/test-usage-sum.js
// Exits 0 on success, non-zero on the first failure.

'use strict';

const path = require('path');
const assert = require('assert');

const { sumUsage } = require(path.join('..', 'src', 'chat', 'usage-sum'));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('first iteration seeds the accumulator', () => {
    const s = sumUsage(null, {
        prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
        prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20,
    });
    assert.deepStrictEqual(s, {
        prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
        prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20,
    });
});

test('later iterations add up', () => {
    let s = sumUsage(null, {
        prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050,
        prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100,
    });
    s = sumUsage(s, {
        prompt_tokens: 2000, completion_tokens: 70, total_tokens: 2070,
        prompt_cache_hit_tokens: 1900, prompt_cache_miss_tokens: 100,
    });
    assert.strictEqual(s.prompt_tokens, 3000);
    assert.strictEqual(s.completion_tokens, 120);
    assert.strictEqual(s.total_tokens, 3120);
    assert.strictEqual(s.prompt_cache_hit_tokens, 2800);
    assert.strictEqual(s.prompt_cache_miss_tokens, 200);
});

test('missing total_tokens is derived per iteration', () => {
    const s = sumUsage(null, { prompt_tokens: 500, completion_tokens: 25 });
    assert.strictEqual(s.total_tokens, 525);
    const t = sumUsage(s, { prompt_tokens: 1000, completion_tokens: 50 });
    assert.strictEqual(t.total_tokens, 1575);
});

test('missing cache fields count as zero', () => {
    const s = sumUsage(
        { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
    );
    assert.strictEqual(s.prompt_cache_hit_tokens, 0);
    assert.strictEqual(s.prompt_cache_miss_tokens, 0);
});

test('null usage returns the accumulator unchanged', () => {
    const acc = { prompt_tokens: 7 };
    assert.strictEqual(sumUsage(acc, null), acc);
    assert.strictEqual(sumUsage(null, null), null);
});

test('neither argument is mutated', () => {
    const acc = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 };
    const u = { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 };
    const accBefore = JSON.stringify(acc);
    const uBefore = JSON.stringify(u);
    sumUsage(acc, u);
    assert.strictEqual(JSON.stringify(acc), accBefore);
    assert.strictEqual(JSON.stringify(u), uBefore);
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log(`✔ ${t.name}`);
        } catch (e) {
            failed++;
            console.log(`✘ ${t.name}\n  ${e.message}`);
        }
    }
    console.log(failed
        ? `\n${failed} of ${tests.length} usage-sum tests failed.`
        : `\nAll ${tests.length} usage-sum tests passed.`);
    process.exit(failed ? 1 : 0);
})();
