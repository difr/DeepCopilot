// Tests for hourly pricing (provider-level `pricingPolicy.offPeakDiscount`):
//   - the declared DeepSeek prices are the peak ones, and peak windows are
//     09:00-12:00 / 14:00-18:00 Beijing time, Mon-Fri;
//   - everything outside those windows is half price, on both models;
//   - windows are wall-clock in the vendor's timezone, not the machine's;
//   - window edges: `from` is inclusive, `to` is exclusive;
//   - providers without a policy keep flat prices (null pricing stays null);
//   - computeCost() accepts the request timestamp and halves the total.
//
// Run with:   node scripts/test-pricing-offpeak.js
// Exits 0 on success, non-zero on the first failure.

'use strict';

// src/providers/index.js → logger.js does `require('vscode')`; stub it before
// the require, like the other scripts/test-*.js do.
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === 'vscode') return require.resolve('./_vscode-stub.js');
    return origResolve.call(this, request, parent, ...rest);
};

const path = require('path');
const assert = require('assert');

const PROVIDER_DIR = path.join(__dirname, '..', 'src', 'providers');
const { initRegistry } = require(path.join('..', 'src', 'providers'));

// The module's eager init resolves `__dirname/providers`, which only matches the
// bundle layout (out/providers). Point the registry at the source dir instead.
initRegistry([PROVIDER_DIR]);

const { getModelPricing, getPricingMode, computeCost } = require(path.join('..', 'src', 'pricing'));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// Calendar anchors (UTC): 2026-09-11 Fri, 09-12 Sat, 09-14 Mon.
// Beijing is UTC+8 and has no DST, so 02:00Z == 10:00 CST.
const MON_0900 = Date.parse('2026-09-14T01:00:00Z');  // Mon 09:00 CST — window opens
const MON_1000 = Date.parse('2026-09-14T02:00:00Z');  // Mon 10:00 CST — peak
const MON_1200 = Date.parse('2026-09-14T04:00:00Z');  // Mon 12:00 CST — window closes
const MON_1300 = Date.parse('2026-09-14T05:00:00Z');  // Mon 13:00 CST — between windows
const MON_1500 = Date.parse('2026-09-14T07:00:00Z');  // Mon 15:00 CST — second window
const MON_1800 = Date.parse('2026-09-14T10:00:00Z');  // Mon 18:00 CST — second window closes
const MON_2200 = Date.parse('2026-09-14T14:00:00Z');  // Mon 22:00 CST — evening
const SAT_1000 = Date.parse('2026-09-12T02:00:00Z');  // Sat 10:00 CST — weekend

const NEAR = (a, b) => Math.abs(a - b) < 1e-12;

test('peak windows keep the declared prices (Mon 10:00 and 15:00 CST)', () => {
    for (const at of [MON_1000, MON_1500]) {
        const p = getModelPricing('deepseek-v4-pro', at);
        assert.ok(NEAR(p.input, 9.0), `input ${p.input} at ${new Date(at).toISOString()}`);
        assert.ok(NEAR(p.cache_hit, 0.3), `cache_hit ${p.cache_hit}`);
        assert.ok(NEAR(p.output, 27.0), `output ${p.output}`);
        assert.ok(!p.off_peak, 'peak price must not be flagged off_peak');
        assert.strictEqual(p.multiplier, undefined);
    }
});

test('window edges: `from` inclusive, `to` exclusive', () => {
    assert.ok(!getModelPricing('deepseek-v4-pro', MON_0900).off_peak, '09:00 CST is still peak');
    assert.ok(getModelPricing('deepseek-v4-pro', MON_1200).off_peak, '12:00 CST is already off-peak');
    assert.ok(getModelPricing('deepseek-v4-pro', MON_1800).off_peak, '18:00 CST is already off-peak');
});

test('gaps and evenings are off-peak, at half price', () => {
    for (const at of [MON_1300, MON_2200]) {
        const p = getModelPricing('deepseek-v4-pro', at);
        assert.strictEqual(p.off_peak, true);
        assert.strictEqual(p.multiplier, 0.5);
        assert.ok(NEAR(p.input, 4.5), `input ${p.input}`);
        assert.ok(NEAR(p.cache_hit, 0.15), `cache_hit ${p.cache_hit}`);
        assert.ok(NEAR(p.output, 13.5), `output ${p.output}`);
    }
});

test('weekends are off-peak for the whole day', () => {
    const p = getModelPricing('deepseek-flash', SAT_1000);
    assert.strictEqual(p.off_peak, true);
    assert.ok(NEAR(p.input, 1.0), `input ${p.input}`);
    assert.ok(NEAR(p.cache_hit, 0.02), `cache_hit ${p.cache_hit}`);
    assert.ok(NEAR(p.output, 4.0), `output ${p.output}`);
});

test('windows follow the vendor timezone, not the machine one', () => {
    // 02:00 UTC is 10:00 in Beijing (peak) but 05:00 in Moscow (would be idle).
    // If the window were evaluated in local time, this would come back halved.
    assert.ok(!getModelPricing('deepseek-v4-pro', MON_1000).off_peak);
});

test('models without a pricing block stay unknown', () => {
    assert.strictEqual(getModelPricing('claude-opus-4-7', MON_1000), null);
    assert.strictEqual(computeCost('claude-opus-4-7', { prompt_tokens: 10, completion_tokens: 5 }).cost_cny, 0);
});

test('computeCost halves the turn total off-peak', () => {
    const usage = {
        prompt_tokens: 1_000_000,
        prompt_cache_hit_tokens: 500_000,
        completion_tokens: 100_000,
    };
    const peak = computeCost('deepseek-v4-pro', usage, MON_1000);
    const idle = computeCost('deepseek-v4-pro', usage, MON_2200);
    // 0.5*0.3 + 0.5*9 + 0.1*27 = 7.35 CNY peak, 3.675 off-peak.
    assert.ok(NEAR(peak.cost_cny, 7.35), `peak ${peak.cost_cny}`);
    assert.ok(NEAR(idle.cost_cny, 3.675), `idle ${idle.cost_cny}`);
    assert.strictEqual(peak.breakdown.pricing.off_peak, undefined);
    assert.strictEqual(idle.breakdown.pricing.off_peak, true);
});

test('cache-miss tokens fall back to prompt minus cache hit', () => {
    const r = computeCost('deepseek-flash', {
        prompt_tokens: 1000,
        prompt_cache_hit_tokens: 400,
        completion_tokens: 100,
    }, MON_1000);
    assert.strictEqual(r.breakdown.cache_miss_tokens, 600);
});

test('timestamp defaults to now and never throws', () => {
    const p = getModelPricing('deepseek-v4-pro');
    assert.strictEqual(typeof p.input, 'number');
    assert.strictEqual(typeof p.cache_hit, 'number');
    assert.strictEqual(typeof p.output, 'number');
});

test('getPricingMode reports hourly vendors and the live window', () => {
    assert.deepStrictEqual(getPricingMode('claude-opus-4-7', MON_1000), { hourly: false });
    const peak = getPricingMode('deepseek-v4-pro', MON_1000);
    assert.strictEqual(peak.hourly, true);
    assert.strictEqual(peak.off_peak, false);
    assert.strictEqual(peak.multiplier, 0.5);
    assert.strictEqual(getPricingMode('deepseek-v4-pro', MON_2200).off_peak, true);
});

test('pricing records are flagged hourly for vendors with a policy', () => {
    assert.strictEqual(getModelPricing('deepseek-v4-pro', MON_1000).hourly, true);
    assert.strictEqual(getModelPricing('deepseek-flash', SAT_1000).hourly, true);
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
        ? `\n${failed} of ${tests.length} pricing tests failed.`
        : `\nAll ${tests.length} pricing tests passed.`);
    process.exit(failed ? 1 : 0);
})();
