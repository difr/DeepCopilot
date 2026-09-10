// Tests for the provider defaults / settings-overrides model (P1):
//   - src/providers/deepseek.json declares the "strong + fast" pair
//     (deepseek-v4-pro / deepseek-flash) and none of the retired ids;
//   - resolveModel() turns an empty / foreign / retired override into the
//     provider default — which is what makes the settings pure overrides;
//   - every model entry uses only keys declared in _schema.json.
//
// Run with:   node scripts/test-provider-defaults.js
// Exits 0 on success, non-zero on the first failure.

'use strict';

// providers/index.js → logger.js does `require('vscode')`; stub it before the
// require, like the other scripts/test-*.js do.
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === 'vscode') return require.resolve('./_vscode-stub.js');
    return origResolve.call(this, request, parent, ...rest);
};

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PROVIDER_DIR = path.join(__dirname, '..', 'src', 'providers');
const { initRegistry, getProvider, resolveModel } = require(path.join('..', 'src', 'providers'));

// The module's eager init resolves `__dirname/providers`, which only matches the
// bundle layout (out/providers). Point the registry at the source dir instead.
initRegistry([PROVIDER_DIR]);

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const RETIRED = [
    'deepseek-v4-flash',
    'deepseek-v4-flash-vision-exp',
    'deepseek-chat',
    'deepseek-reasoner',
];

test('deepseek declares the strong + fast pair and no retired ids', () => {
    const p = getProvider('deepseek');
    assert.ok(p, 'deepseek provider should be registered');
    assert.deepStrictEqual(
        p.models.map(m => m.id),
        ['deepseek-v4-pro', 'deepseek-flash'],
        'pro must stay first — the webview defaults to the first model of the list'
    );
    assert.strictEqual(p.defaultModel, 'deepseek-v4-pro');
    assert.strictEqual(p.subAgentModel, 'deepseek-flash');
    for (const id of RETIRED) {
        assert.ok(!p.models.some(m => m.id === id), `${id} should no longer be declared`);
    }
});

test('resolveModel maps empty / foreign / retired overrides to the provider default', () => {
    assert.strictEqual(resolveModel('deepseek', ''), 'deepseek-v4-pro');
    assert.strictEqual(resolveModel('deepseek', undefined), 'deepseek-v4-pro');
    assert.strictEqual(resolveModel('deepseek', 'deepseek-v4-flash'), 'deepseek-v4-pro');
    assert.strictEqual(resolveModel('deepseek', 'gpt-5.5'), 'deepseek-v4-pro');
    assert.strictEqual(resolveModel('deepseek', 'deepseek-flash'), 'deepseek-flash');
});

test('flash carries 1M/384K/vision, pro stays non-vision', () => {
    const p = getProvider('deepseek');
    const flash = p.models.find(m => m.id === 'deepseek-flash');
    const pro = p.models.find(m => m.id === 'deepseek-v4-pro');
    assert.strictEqual(flash.contextWindow, 1000000);
    assert.strictEqual(flash.maxOutputTokens, 384000);
    assert.strictEqual(flash.capabilities.vision, true);
    assert.strictEqual(pro.capabilities.vision, false);
    assert.strictEqual(pro.contextWindow, 1000000);
});

test('pricing stays in CNY for every deepseek model', () => {
    for (const m of getProvider('deepseek').models) {
        assert.strictEqual(m.pricing && m.pricing.currency, 'CNY', `${m.id}: pricing.currency`);
        for (const k of ['input', 'cache_hit', 'output']) {
            assert.strictEqual(typeof m.pricing[k], 'number', `${m.id}: pricing.${k}`);
        }
    }
});

test('every provider model uses only keys declared in _schema.json', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(PROVIDER_DIR, '_schema.json'), 'utf8'));
    const modelSchema = schema.properties.models.items;
    const modelKeys = new Set(Object.keys(modelSchema.properties));
    const pricingKeys = new Set(Object.keys(modelSchema.properties.pricing.properties));

    const files = fs.readdirSync(PROVIDER_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
    for (const f of files) {
        const p = JSON.parse(fs.readFileSync(path.join(PROVIDER_DIR, f), 'utf8'));
        for (const key of Object.keys(p)) {
            assert.ok(schema.properties[key], `${f}: undeclared top-level key "${key}"`);
        }
        for (const m of p.models || []) {
            for (const key of Object.keys(m)) {
                assert.ok(modelKeys.has(key), `${f}: model ${m.id} has undeclared key "${key}"`);
            }
            for (const req of modelSchema.required) {
                assert.ok(m[req] !== undefined, `${f}: model ${m.id} is missing required "${req}"`);
            }
            for (const key of Object.keys(m.pricing || {})) {
                assert.ok(pricingKeys.has(key), `${f}: model ${m.id} pricing has undeclared key "${key}"`);
            }
        }
    }
});

test('every import from the provider registry exists in its exports', () => {
    // Regression guard: provider.js once imported a non-existent
    // `resolveProvider`; the call sites swallowed the TypeError in try/catch,
    // so the UI silently fell back to a 64K context window for every model.
    const exported = new Set(Object.keys(require(path.join('..', 'src', 'providers'))));
    const SRC = path.join(__dirname, '..', 'src');

    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return walk(p);
        return e.isFile() && e.name.endsWith('.js') ? [p] : [];
    });

    const problems = [];
    for (const file of walk(SRC)) {
        const src = fs.readFileSync(file, 'utf8');
        const rel = path.relative(SRC, file);

        // const { a, b } = require('.../providers')
        for (const m of src.matchAll(/const\s*\{([^}]+)\}\s*=\s*require\(\s*['"][^'"]*providers['"]\s*\)/g)) {
            for (const raw of m[1].split(',')) {
                const name = raw.trim().split(':')[0].trim();
                if (name && !exported.has(name)) problems.push(`${rel}: "${name}" is not exported`);
            }
        }
        // require('.../providers').someFn
        for (const m of src.matchAll(/require\(\s*['"][^'"]*providers['"]\s*\)\.([A-Za-z_$][\w$]*)/g)) {
            if (!exported.has(m[1])) problems.push(`${rel}: "${m[1]}" is not exported`);
        }
    }

    assert.deepStrictEqual(problems, [], `unresolved provider imports:\n  ${problems.join('\n  ')}`);
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
        ? `\n${failed} of ${tests.length} provider tests failed.`
        : `\nAll ${tests.length} provider tests passed.`);
    process.exit(failed ? 1 : 0);
})();
