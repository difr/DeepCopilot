// Self-contained tests for the web_search tool internals (ported from
// better-deepseek src/content/files/search-reader.test.js / search-quality.test.js,
// adapted to the CommonJS + no-DOM implementation).
//
// Run with:   node scripts/test-web-search.js
//
// Exits 0 on success, non-zero on the first failure.
//
// web-search.js requires utils.js at module load, which does
// `require('vscode')` — fails outside the extension host, so we stub it
// before the require (same pattern as test-orphan-toolcalls.js).

'use strict';

const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === 'vscode') return require.resolve('./_vscode-stub.js');
    return origResolve.call(this, request, parent, ...rest);
};

const path = require('path');
const assert = require('assert');

const {
    _parseDdgResults,
    _decodeDdgRedirect,
    _isChallengePage,
    _runSearchChain,
    _formatResults,
    _parseBingRss,
} = require(path.join('..', 'src', 'tools', 'web-search.js'));
const { rankSearchResults, extractSearchSignals } =
    require(path.join('..', 'src', 'tools', 'search-quality.js'));

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
    console.log(`\nAll ${passed} web-search tests passed.`);
}

// ─── fixtures ───────────────────────────────────────────────────────────────
const ddgHref = (realUrl) => `//duckduckgo.com/l/?uddg=${encodeURIComponent(realUrl)}&rut=test`;
const ddgRelativeHref = (realUrl) => `/l/?uddg=${encodeURIComponent(realUrl)}&rut=test`;

function makeLiteHtml(results) {
    const rows = [];
    results.forEach((r, index) => {
        rows.push(`<tr>
      <td valign="top">${index + 1}.&nbsp;</td>
      <td><a class="result-link" href="${ddgHref(r.url)}">${r.title}</a></td>
    </tr>`);
        if (r.snippet) {
            rows.push(`<tr>
        <td>&nbsp;&nbsp;&nbsp;</td>
        <td class="result-snippet">${r.snippet}</td>
      </tr>`);
        }
        rows.push(`<tr>
      <td>&nbsp;&nbsp;&nbsp;</td>
      <td><span class="link-text">${r.displayUrl || r.url}</span></td>
    </tr>`);
        rows.push('<tr><td>&nbsp;</td><td>&nbsp;</td></tr>');
    });
    return `<html><body><table border="0">${rows.join('\n')}</table></body></html>`;
}

function makeHtmlResults(results) {
    const blocks = results
        .map(r => `<div class="result">
      <a class="result__a" href="${ddgRelativeHref(r.url)}">${r.title}</a>
      <a class="result__snippet">${r.snippet || ''}</a>
    </div>`)
        .join('\n');
    return `<html><body>${blocks}</body></html>`;
}

function makeChallengeHtml() {
    return `<html><body>
    <form id="challenge-form" action="/anomaly.js">
      <p>Unfortunately, bots use DuckDuckGo too. Please verify you are human.</p>
    </form>
  </body></html>`;
}

function makeBingRss(results) {
    const items = results.map(r => `<item>
      <title>${r.title}</title>
      <link>${r.url}</link>
      <description>${r.snippet || ''}</description>
    </item>`).join('\n');
    return `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`;
}

const ok = (body, status = 200) => ({ status, body });
const ddgProvider = (body, status = 200) => ({
    name: 'DuckDuckGo',
    fetch: async () => ok(body, status),
    parse: (resp) => ({ results: _parseDdgResults(resp.body) }),
});
const bingProvider = (body, status = 200) => ({
    name: 'Bing',
    fetch: async () => ok(body, status),
    parse: (resp) => ({ results: _parseBingRss(resp.body) }),
});

// ─── DDG parsing ────────────────────────────────────────────────────────────
test('parses a single DDG Lite result with title, url, snippet', () => {
    const html = makeLiteHtml([{ title: 'Example', url: 'https://example.com', snippet: 'An example site' }]);
    const results = _parseDdgResults(html);
    assert.strictEqual(results.length, 1);
    assert.deepStrictEqual(results[0], {
        title: 'Example',
        url: 'https://example.com',
        snippet: 'An example site',
    });
});

test('parses multiple DDG Lite results', () => {
    const html = makeLiteHtml([
        { title: 'First', url: 'https://a.com', snippet: 'First result' },
        { title: 'Second', url: 'https://b.com', snippet: 'Second result' },
    ]);
    const results = _parseDdgResults(html);
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].title, 'First');
    assert.strictEqual(results[1].title, 'Second');
    assert.strictEqual(results[0].snippet, 'First result');
    assert.strictEqual(results[1].snippet, 'Second result');
});

test('parses DDG HTML result blocks with relative redirect URLs', () => {
    const html = makeHtmlResults([
        { title: 'DuckDuckGo HTML Result', url: 'https://example.com/ddg-html', snippet: 'A result from the HTML endpoint.' },
    ]);
    const results = _parseDdgResults(html);
    assert.deepStrictEqual(results, [
        { title: 'DuckDuckGo HTML Result', url: 'https://example.com/ddg-html', snippet: 'A result from the HTML endpoint.' },
    ]);
});

test('parses real-world DDG Lite markup (single quotes, href before class)', () => {
    const html = `<html><body><table>
      <tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fapi-docs.deepseek.com%2F&amp;rut=abc" class='result-link'>Your First <b>API</b> Call</a></td></tr>
      <tr><td class='result-snippet'>The <b>DeepSeek</b> API uses an OpenAI-compatible format.</td></tr>
    </table></body></html>`;
    const results = _parseDdgResults(html);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].title, 'Your First API Call');
    assert.strictEqual(results[0].url, 'https://api-docs.deepseek.com/');
    assert.strictEqual(results[0].snippet, 'The DeepSeek API uses an OpenAI-compatible format.');
});

test('parses real-world DDG HTML markup with single-quoted class', () => {
    const html = `<div class="result">
      <a rel="nofollow" class='result__a' href='/l/?uddg=https%3A%2F%2Fexample.com%2Fhtml'>Title Here</a>
      <a class='result__snippet'>Snippet text here.</a>
    </div>`;
    const results = _parseDdgResults(html);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].url, 'https://example.com/html');
    assert.strictEqual(results[0].snippet, 'Snippet text here.');
});

test('returns empty array when no supported result elements exist', () => {
    assert.deepStrictEqual(_parseDdgResults('<html><body>no results here</body></html>'), []);
    assert.deepStrictEqual(_parseDdgResults(''), []);
    assert.deepStrictEqual(_parseDdgResults('not even html'), []);
});

test('handles missing snippet gracefully', () => {
    const html = makeLiteHtml([{ title: 'No Snippet', url: 'https://example.com', snippet: '' }]);
    const results = _parseDdgResults(html);
    assert.strictEqual(results[0].snippet, '');
});

test('strips HTML tags from titles', () => {
    const html = makeLiteHtml([{ title: 'Example <b>Bold</b> Title', url: 'https://example.com', snippet: '' }]);
    const results = _parseDdgResults(html);
    assert.strictEqual(results[0].title, 'Example Bold Title');
});

test('skips rows with no decodable http URL', () => {
    const html = makeLiteHtml([{ title: 'Bad', url: 'javascript:alert(1)' }]);
    assert.deepStrictEqual(_parseDdgResults(html), []);
});

// ─── DDG redirect decoding ──────────────────────────────────────────────────
test('extracts URL from standard DDG redirect', () => {
    assert.strictEqual(_decodeDdgRedirect('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&rut=abc'), 'https://example.com');
});

test('extracts URL with path and query params', () => {
    assert.strictEqual(_decodeDdgRedirect('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage%3Fx%3D1&rut=abc'), 'https://example.com/page?x=1');
});

test('handles absolute and relative DDG URLs', () => {
    assert.strictEqual(_decodeDdgRedirect('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&rut=abc'), 'https://example.com');
    assert.strictEqual(_decodeDdgRedirect('/l/?uddg=https%3A%2F%2Fexample.com%2Fhtml&rut=abc'), 'https://example.com/html');
});

test('decodes percent-encoded URL paths', () => {
    const href = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F%25C3%25A9co&rut=abc';
    assert.strictEqual(_decodeDdgRedirect(href), 'https://example.com/' + decodeURIComponent('%C3%A9') + 'co');
});

test('returns href as-is when no uddg parameter', () => {
    const href = '//duckduckgo.com/l/?other=val';
    assert.strictEqual(_decodeDdgRedirect(href), href);
});

test('handles malformed input without crashing', () => {
    assert.strictEqual(_decodeDdgRedirect(''), '');
    assert.strictEqual(_decodeDdgRedirect(null), '');
    assert.strictEqual(_decodeDdgRedirect('not-a-url'), 'not-a-url');
});

// ─── challenge detection ────────────────────────────────────────────────────
test('detects anti-bot challenge pages', () => {
    assert.strictEqual(_isChallengePage(makeChallengeHtml(), 200), true);
    assert.strictEqual(_isChallengePage('<html></html>', 202), true);
    assert.strictEqual(_isChallengePage('<html><body>anomaly detected</body></html>', 200), true);
});

test('does not flag real result pages', () => {
    assert.strictEqual(_isChallengePage(makeLiteHtml([{ title: 'X', url: 'https://x.com' }]), 200), false);
    assert.strictEqual(_isChallengePage(makeBingRss([{ title: 'X', url: 'https://x.com' }]), 200), false);
});

// ─── ranking ────────────────────────────────────────────────────────────────
test('ranking accepts a strong top result', () => {
    const ranked = rankSearchResults('DeepSeek API docs', [
        { title: 'DeepSeek API documentation', url: 'https://platform.deepseek.com/api-docs', snippet: 'Official API docs and reference for DeepSeek.' },
    ]);
    assert.strictEqual(ranked.results.length, 1);
    assert.strictEqual(ranked.isStrongTopResult, true);
    assert.ok(ranked.passingCount >= 1);
});

test('ranking filters results outside site: constraint', () => {
    const ranked = rankSearchResults('site:api-docs.deepseek.com chat completions', [
        { title: 'Chat Completions API', url: 'https://api-docs.deepseek.com/api/chat-completions', snippet: 'DeepSeek API chat completions reference' },
        { title: 'Unrelated page', url: 'https://example.com/other', snippet: 'not on the site' },
    ]);
    assert.strictEqual(ranked.results.length, 1);
    assert.ok(ranked.results[0].url.includes('api-docs.deepseek.com'));
});

test('ranking drops results from search-provider domains', () => {
    const ranked = rankSearchResults('test query', [
        { title: 'Real page', url: 'https://example.com/page', snippet: 'content' },
        { title: 'Bing search page', url: 'https://www.bing.com/search?q=test', snippet: 'results' },
    ]);
    assert.strictEqual(ranked.results.length, 1);
    assert.strictEqual(ranked.results[0].url, 'https://example.com/page');
});

test('ranking dedups identical URLs', () => {
    const ranked = rankSearchResults('test query', [
        { title: 'One', url: 'https://example.com/page', snippet: 'a' },
        { title: 'Two', url: 'https://example.com/page', snippet: 'b' },
    ]);
    assert.strictEqual(ranked.results.length, 1);
});

test('ranking applies negative terms', () => {
    const ranked = rankSearchResults('laptop -gaming', [
        { title: 'Best laptops', url: 'https://a.com/laptops', snippet: 'business laptops review' },
        { title: 'Gaming laptops', url: 'https://b.com/gaming', snippet: 'gaming laptops' },
    ]);
    assert.strictEqual(ranked.results.length, 1);
    assert.strictEqual(ranked.results[0].url, 'https://a.com/laptops');
});

test('extractSearchSignals finds site: constraints', () => {
    const signals = extractSearchSignals('site:github.com better-deepseek issue 81');
    assert.deepStrictEqual(signals.includeSites, ['github.com']);
});

// ─── rotation chain ─────────────────────────────────────────────────────────
test('chain accepts strong DDG Lite results without hitting fallbacks', async () => {
    const html = makeLiteHtml([
        { title: 'Test query one', url: 'https://one.com', snippet: 'First test query snippet' },
        { title: 'Test query two', url: 'https://two.com', snippet: 'Second test query snippet' },
        { title: 'Test query three', url: 'https://three.com', snippet: 'Third test query snippet' },
    ]);
    const out = await _runSearchChain('test query', {
        max: 5,
        providers: [ddgProvider(html), bingProvider(makeBingRss([]))],
    });
    assert.strictEqual(out.providerName, 'DuckDuckGo');
    assert.strictEqual(out.lowConfidence, false);
    assert.strictEqual(out.results.length, 3);
    assert.deepStrictEqual(out.results[0], { title: 'Test query one', url: 'https://one.com', snippet: 'First test query snippet' });
});

test('chain falls back to DDG HTML when Lite returns a challenge', async () => {
    const out = await _runSearchChain('test', {
        max: 5,
        providers: [
            ddgProvider(makeChallengeHtml()),
            ddgProvider(makeHtmlResults([
                { title: 'test result one', url: 'https://html-result.com/one', snippet: 'test content about tests' },
                { title: 'test result two', url: 'https://html-result.com/two', snippet: 'more test content' },
                { title: 'test result three', url: 'https://html-result.com/three', snippet: 'third test result' },
            ])),
        ],
    });
    assert.strictEqual(out.providerName, 'DuckDuckGo');
    assert.strictEqual(out.results[0].url, 'https://html-result.com/one');
});

test('chain falls back Lite → HTML → Bing', async () => {
    const out = await _runSearchChain('test', {
        max: 5,
        providers: [
            ddgProvider(makeChallengeHtml()),
            ddgProvider(makeChallengeHtml()),
            bingProvider(makeBingRss([{ title: 'Bing Result', url: 'https://bing-result.com', snippet: 'fallback worked' }])),
        ],
    });
    assert.strictEqual(out.providerName, 'Bing');
    assert.strictEqual(out.results[0].url, 'https://bing-result.com');
});

test('chain moves to the next provider on weak relevance', async () => {
    const out = await _runSearchChain('DeepSeek API docs', {
        max: 5,
        providers: [
            ddgProvider(makeLiteHtml([
                { title: 'Developer tools overview', url: 'https://example.com/dev-tools', snippet: 'A general overview of developer tools.' },
            ])),
            bingProvider(makeBingRss([
                { title: 'DeepSeek API documentation', url: 'https://platform.deepseek.com/api-docs', snippet: 'Official API docs and reference for DeepSeek.' },
            ])),
        ],
    });
    assert.strictEqual(out.providerName, 'Bing');
    assert.strictEqual(out.results[0].url, 'https://platform.deepseek.com/api-docs');
});

test('chain returns the best weak result when all providers are weak', async () => {
    const out = await _runSearchChain('laptop reviews 2025', {
        max: 5,
        providers: [
            ddgProvider(makeLiteHtml([
                { title: 'Laptop reviews shortlist', url: 'https://example.com/laptop-shortlist', snippet: 'Shortlist of laptop reviews for buyers.' },
                { title: 'Generic buyer guide', url: 'https://example.com/buyer-guide', snippet: 'General shopping guide.' },
            ])),
            bingProvider(makeBingRss([
                { title: 'Buying a laptop', url: 'https://bing-example.com/laptop-buying', snippet: 'High-level laptop buying advice.' },
            ])),
        ],
    });
    assert.strictEqual(out.providerName, 'DuckDuckGo');
    assert.strictEqual(out.lowConfidence, true);
    assert.strictEqual(out.results[0].title, 'Laptop reviews shortlist');
});

test('chain throws on fetch failure', async () => {
    const broken = {
        name: 'DuckDuckGo',
        fetch: async () => { throw new Error('connection failed'); },
        parse: () => ({ results: [] }),
    };
    await assert.rejects(
        _runSearchChain('test', { max: 5, providers: [broken] }),
        /Search failed: connection failed/
    );
});

test('chain throws on no results', async () => {
    await assert.rejects(
        _runSearchChain('test', { max: 5, providers: [ddgProvider('<html><body>no results</body></html>')] }),
        /No search results found for query: test/
    );
});

test('chain throws site-scoped error when all providers fail for site: query', async () => {
    await assert.rejects(
        _runSearchChain('site:docs.example.com unknown topic', {
            max: 5,
            providers: [ddgProvider('<html><body><p>no results</p></body></html>')],
        }),
        /No search results found for site: docs\.example\.com/
    );
});

test('chain returns answer from a provider when present', async () => {
    const withAnswer = {
        name: 'Tavily',
        fetch: async () => ok('{}'),
        parse: () => ({ results: [{ title: 'X', url: 'https://x.com', snippet: 's' }], answer: 'synthesized text' }),
    };
    const out = await _runSearchChain('test query', { max: 5, providers: [withAnswer] });
    assert.strictEqual(out.answer, 'synthesized text');
});

// ─── formatting ─────────────────────────────────────────────────────────────
test('formatSearchResults produces the expected markdown shape', () => {
    const md = _formatResults('test query', [
        { title: 'A', url: 'https://a.com', snippet: 'Snippet A' },
        { title: 'B', url: 'https://b.com', snippet: 'Snippet B' },
    ], 'DuckDuckGo');
    assert.ok(md.includes('Query: test query'));
    assert.ok(md.includes('## Top 2 result(s)'));
    assert.ok(md.includes('### 1. A'));
    assert.ok(md.includes('https://a.com'));
    assert.ok(md.includes('Snippet A'));
    assert.ok(md.includes('### 2. B'));
    assert.ok(md.includes('Snippet B'));
});

test('format includes synthesized answer when provided', () => {
    const md = _formatResults('q', [{ title: 'A', url: 'https://a.com', snippet: 's' }], 'Tavily', 'an answer');
    assert.ok(md.includes('## Synthesized answer'));
    assert.ok(md.includes('an answer'));
});

_runAll();
