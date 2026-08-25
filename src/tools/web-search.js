// web_search: multi-backend web search.
// Backends:
//   - Tavily  (requires API key, best quality, synthesized answer)
//   - DuckDuckGo Lite / HTML (no API key; rotation chain with ranking)
//   - Bing RSS (no API key, fallback in the chain)
//
// Provider selection is driven by the 'deepseekAgent.webSearchProvider'
// setting: 'auto' | 'tavily' | 'duckduckgo' | 'bing'.
//   - 'auto' (default): Tavily when a key is configured, otherwise a
//     DuckDuckGo Lite → DuckDuckGo HTML → Bing chain. For `site:` queries the
//     chain starts with Bing (DDG handles site: poorly).
//   - 'duckduckgo' / 'bing': that provider's chain (DDG chain includes Bing
//     as the last fallback).
//
// The provider chain is adapted from better-deepseek
// src/content/files/search-reader.js:
//   Source:  https://github.com/EdgeTypE/better-deepseek
//   File:    src/content/files/search-reader.js
//   Version: commit c789a0b (2026-08-17) — the state present when this was
//            first ported (2026-08-26). Re-checked 2026-09-02 against
//            origin/main @ a2abb4d: the file changed afterwards only in
//            82428b9 / c7c4717 (2026-08-23, search overhaul #148) — not
//            ported here (see notes below).
//   License: MIT — Copyright (c) 2026 Çağrı DÜRÜ (see repo LICENSE).
//   Notes:   rewritten as {fetch, parse} provider objects, not a verbatim
//            copy. Ported from #148: the low-confidence notice emitted when
//            only weak matches are recovered (_formatResults). Not ported:
//            per-provider timeout (this file already caps each request at
//            15 s), the user-configurable provider order (this project
//            selects a chain via the webSearchProvider setting instead),
//            onStatus phase events and the settings catalog (webview UI
//            specifics). The ranking half is vendored separately in
//            search-quality.js.
//
// How the chain works: each provider's results are parsed, then ranked
// against the query (search-quality.js) — the first provider with enough
// strong matches wins; otherwise the best weak result set is used.
// Anti-bot challenge pages and network failures advance to the next provider.
'use strict';

const https  = require('https');
const http   = require('http');
const { truncate } = require('./utils');
const { rankSearchResults, extractSearchSignals } = require('./search-quality');

// Cap on a single HTTP response body to bound memory usage. Web search
// endpoints (Tavily JSON / Bing RSS / DDG HTML) normally return well under
// 100 KB; anything bigger than this is almost certainly anomalous.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const DDG_LITE_URL = 'https://lite.duckduckgo.com/lite/?q=';
const DDG_HTML_URL = 'https://html.duckduckgo.com/html/?q=';

// A browser-like UA is required — DDG and Bing otherwise serve challenge
// pages to plain Node https requests.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── Helpers ──────────────────────────────────────────────────────────────────────────

function _request(opts, body, timeoutMs = 20000, abortSignal = null) {
    return new Promise((resolve, reject) => {
        if (abortSignal && abortSignal.aborted) return reject(new Error('aborted'));
        const mod = opts.protocol === 'http:' ? http : https;
        const req = mod.request(opts, (res) => {
            // Without this, an error on the response stream (e.g. socket reset
            // mid-body) would surface as an unhandled 'error' event and could
            // crash the extension host process.
            res.on('error', reject);
            let chunks = '';
            let bytes  = 0;
            let aborted = false;
            res.setEncoding('utf8');
            res.on('data', (c) => {
                if (aborted) return;
                bytes += Buffer.byteLength(c, 'utf8');
                if (bytes > MAX_RESPONSE_BYTES) {
                    aborted = true;
                    try { req.destroy(); } catch {}
                    return reject(new Error(`Response body exceeded ${MAX_RESPONSE_BYTES} bytes`));
                }
                chunks += c;
            });
            res.on('end', () => { if (!aborted) resolve({ status: res.statusCode, body: chunks }); });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('Request timeout')); });
        if (abortSignal) {
            const onAbort = () => { try { req.destroy(new Error('aborted')); } catch {} reject(new Error('aborted')); };
            abortSignal.addEventListener('abort', onAbort, { once: true });
            req.once('close', () => { try { abortSignal.removeEventListener('abort', onAbort); } catch {} });
        }
        req.setTimeout(timeoutMs);
        if (body) req.write(body);
        req.end();
    });
}

function _get(url, opts = {}) {
    const { timeoutMs = 15000, abortSignal = null, headers = {} } = opts;
    const parsed = new URL(url);
    return _request({
        method:   'GET',
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port:     parsed.port || undefined,
        path:     parsed.pathname + parsed.search,
        headers:  {
            'User-Agent':      BROWSER_UA,
            'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'identity',
            ...headers,
        },
    }, null, timeoutMs, abortSignal);
}

function cleanSearchText(value) {
    return String(value || '')
        .replace(/<[^>]+>/g, ' ') // strip tags (titles can contain <b> etc.)
        .replace(/\s+/g, ' ')
        .trim();
}

function isHttpUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

// ─── DuckDuckGo backend ──────────────────────────────────────────────────────
// DDG wraps real URLs in //duckduckgo.com/l/?uddg=<encoded_url>&rut=...
// (Lite) or /l/?uddg=... (HTML) — must be unwrapped before use.

function _decodeDdgRedirect(href) {
    if (!href) return '';
    try {
        const normalizedHref = href.startsWith('//')
            ? 'https:' + href
            : href.startsWith('/')
                ? 'https://duckduckgo.com' + href
                : href;
        const url = new URL(normalizedHref);
        const uddg = url.searchParams.get('uddg');
        return uddg ? decodeURIComponent(uddg) : href;
    } catch {
        return href;
    }
}

const _ANCHOR_TAG_RE = /<a\b[^>]*>/gi;
const _TD_TAG_RE = /<td\b[^>]*>/gi;
const _CLASS_RE = /class=(["'])([^"']*)\1/i;
const _HREF_RE = /href=(["'])([^"']*)\1/i;

// Extract the inner text of the tag that started at `openIndex` (its content
// runs until the first matching closing tag). Returns { text, endIndex }.
function _innerTextUntil(src, openIndex, openTag, closeTag) {
    const rest = src.slice(openIndex + openTag.length);
    const close = new RegExp(closeTag, 'i').exec(rest);
    if (!close) return null;
    return { text: rest.slice(0, close.index), endIndex: openIndex + openTag.length + close.index + closeTag.length };
}

// Parse both DDG result layouts (no DOM in the extension host):
//   Lite:  <tr><td><a class='result-link' href='//duckduckgo.com/l/?uddg=...'>Title</a></td></tr>
//          <tr><td class='result-snippet'>Snippet</td></tr>
//   HTML:  <div class="result"><a class="result__a" href="/l/?uddg=...">Title</a>
//          <a class="result__snippet">Snippet</a></div>
// Real-world DDG markup uses single OR double quotes for attributes and puts
// href before class, so tags are scanned and attributes extracted individually.
// A snippet is paired with the closest preceding title anchor.
function _parseDdgResults(html) {
    const src = String(html || '');
    const anchors = [];
    const snippets = [];

    const anchorRe = new RegExp(_ANCHOR_TAG_RE.source, _ANCHOR_TAG_RE.flags);
    let m;
    while ((m = anchorRe.exec(src)) !== null) {
        const tag = m[0];
        const cls = _CLASS_RE.exec(tag);
        if (!cls) continue;
        if (/\bresult__snippet\b/.test(cls[2])) {
            const inner = _innerTextUntil(src, m.index, tag, '</a>');
            if (!inner) continue;
            snippets.push({ text: inner.text, index: m.index });
            anchorRe.lastIndex = inner.endIndex;
            continue;
        }
        if (/\bresult-link\b/.test(cls[2]) || /\bresult__a\b/.test(cls[2])) {
            const hrefM = _HREF_RE.exec(tag);
            if (!hrefM) continue;
            const inner = _innerTextUntil(src, m.index, tag, '</a>');
            if (!inner) continue;
            anchors.push({ href: hrefM[2], text: inner.text, index: m.index });
            anchorRe.lastIndex = inner.endIndex;
        }
    }

    const tdRe = new RegExp(_TD_TAG_RE.source, _TD_TAG_RE.flags);
    while ((m = tdRe.exec(src)) !== null) {
        const tag = m[0];
        const cls = _CLASS_RE.exec(tag);
        if (!cls || !/\bresult-snippet\b/.test(cls[2])) continue;
        const inner = _innerTextUntil(src, m.index, tag, '</td>');
        if (!inner) continue;
        snippets.push({ text: inner.text, index: m.index });
        tdRe.lastIndex = inner.endIndex;
    }

    const results = anchors.map(a => ({ ...a, snippet: '' }));
    for (const s of snippets) {
        let best = -1;
        for (let i = 0; i < anchors.length; i++) {
            if (anchors[i].index < s.index) best = i;
        }
        if (best >= 0) results[best].snippet = s.text;
    }

    return results
        .map(r => ({
            title:   cleanSearchText(r.text),
            url:     _decodeDdgRedirect(r.href),
            snippet: cleanSearchText(r.snippet),
        }))
        .filter(r => r.title && isHttpUrl(r.url));
}

function _isChallengePage(html, status) {
    if (Number(status) === 202) return true;
    const content = String(html || '');
    if (/result-link|result__a|b_algo/.test(content)) return false;
    return /anomaly|captcha|unusual traffic|verify you are human|robot|bot detection/i.test(content);
}

// ─── Bing RSS backend (no API key) ────────────────────────────────────────────
// Uses Bing's ?format=rss endpoint which returns stable XML — no bot detection,
// no HTML scraping fragility.

function _decodeXmlEntities(s) {
    let out = String(s || '');
    // Strip tags first so we don't accidentally feed HTML into the entity pass.
    out = out.replace(/<[^>]+>/g, ' ');
    // Decode &amp; first (and iterate to a fixed point) so double-escaped entities
    // like &amp;lt; resolve correctly.
    for (let i = 0; i < 3; i++) {
        const next = out.replace(/&amp;/g, '&');
        if (next === out) break;
        out = next;
    }
    // Safely convert a numeric code point to a string. String.fromCodePoint throws
    // RangeError for NaN, surrogate halves, or values > 0x10FFFF — guard against
    // malformed entities in remote RSS so a single bad entity can't kill the
    // whole Bing search. On failure, drop the entity (return '').
    const fromCp = (cp) => {
        if (!Number.isFinite(cp) || cp < 0 || cp > 0x10FFFF) return '';
        if (cp >= 0xD800 && cp <= 0xDFFF) return ''; // surrogate halves
        try { return String.fromCodePoint(cp); } catch { return ''; }
    };
    out = out
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '\'').replace(/&#39;/g, '\'').replace(/&apos;/g, '\'')
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => fromCp(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, n) => fromCp(Number(n)));
    return out.replace(/\s{2,}/g, ' ').trim();
}

function _parseBingRss(xml) {
    const results = [];
    const items = String(xml || '').split('<item>').slice(1);
    for (const item of items) {
        const titleM = item.match(/<title>([\s\S]*?)<\/title>/i);
        const linkM  = item.match(/<link>([\s\S]*?)<\/link>/i)
                    || item.match(/<link\s+[^>]*href="([^"]+)"/i);
        const descM  = item.match(/<description>([\s\S]*?)<\/description>/i);
        if (titleM && linkM) {
            results.push({
                title:   _decodeXmlEntities(titleM[1]).slice(0, 120),
                url:     _decodeXmlEntities(linkM[1]).trim(),
                snippet: descM ? _decodeXmlEntities(descM[1]).slice(0, 300) : '',
            });
        }
    }
    return results;
}

function _bingRssProvider(query, { max, abortSignal }) {
    return {
        name: 'Bing',
        fetch: async () => {
            const q = encodeURIComponent(query);
            return _get(`https://www.bing.com/search?q=${q}&format=rss&count=${max}`, {
                abortSignal,
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DeepCopilot/1.0)' },
            });
        },
        parse: (resp) => ({ results: _parseBingRss(resp.body) }),
    };
}

function _ddgProvider(name, url, abortSignal) {
    return {
        name,
        fetch: () => _get(url, { abortSignal }),
        parse: (resp) => ({ results: _parseDdgResults(resp.body) }),
    };
}

function _ddgProviders(query, { abortSignal }) {
    const q = encodeURIComponent(query);
    return [
        _ddgProvider('DuckDuckGo', DDG_LITE_URL + q, abortSignal),
        _ddgProvider('DuckDuckGo', DDG_HTML_URL + q, abortSignal),
    ];
}

// ─── Tavily backend ────────────────────────────────────────────────────────────

function _tavilySearch(query, { apiKey, max = 5, depth = 'basic', includeAnswer = true, abortSignal } = {}) {
    const body = JSON.stringify({
        api_key: apiKey, query, max_results: max,
        search_depth: depth, include_answer: includeAnswer,
        include_raw_content: false, include_images: false,
    });
    return _request({
        method: 'POST', protocol: 'https:', hostname: 'api.tavily.com', path: '/search',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, body, 20000, abortSignal).then((res) => {
        if (res.status < 200 || res.status >= 300)
            throw new Error(`Tavily HTTP ${res.status}: ${res.body.slice(0, 200)}`);
        let data;
        try { data = JSON.parse(res.body); }
        catch (e) { throw new Error(`Tavily returned non-JSON response: ${e.message} (body preview: ${res.body.slice(0, 200)})`); }
        const results = (Array.isArray(data.results) ? data.results : []).map(r => ({
            title:   cleanSearchText(r.title),
            url:     r.url,
            snippet: cleanSearchText(r.content),
        }));
        return { results, answer: (includeAnswer && data.answer) ? data.answer : undefined };
    });
}

// ─── Provider rotation chain ──────────────────────────────────────────────────
// Each provider: { name, fetch: () => Promise<{status, body}>, parse: (resp) => {results, answer?} }.
// Accepts the first provider whose ranked results are strong (≥3 passing or a
// strong top hit); otherwise falls back to the best weak result set seen.

function _searchFailureMessage(errors) {
    const messages = errors.map(error => error.replace(/^[^:]+:\s*/, ''));
    const uniqueMessages = [...new Set(messages)];
    return uniqueMessages.length === 1
        ? `Search failed: ${uniqueMessages[0]}`
        : `Search failed: ${errors.join('; ')}`;
}

async function _runSearchChain(query, { max, providers }) {
    const signals = extractSearchSignals(query);
    const hasSiteConstraint = signals.includeSites.length > 0;
    let bestWeak = null;
    const errors = [];

    for (const provider of providers) {
        let resp;
        try {
            resp = await provider.fetch();
        } catch (e) {
            errors.push(`${provider.name}: ${e.message || String(e)}`);
            continue;
        }

        let parsed;
        try {
            parsed = provider.parse(resp);
        } catch (e) {
            errors.push(`${provider.name}: ${e.message || String(e)}`);
            continue;
        }

        const results = (parsed && Array.isArray(parsed.results)) ? parsed.results : [];
        if (results.length > 0) {
            const ranked = rankSearchResults(query, results);
            if (!bestWeak || ranked.topScore > bestWeak.topScore ||
                (ranked.topScore === bestWeak.topScore && ranked.results.length > bestWeak.results.length)) {
                bestWeak = {
                    providerName: provider.name,
                    results: ranked.results,
                    rawResultCount: ranked.rawResultCount,
                    topScore: ranked.topScore,
                    answer: parsed.answer,
                };
            }
            if (ranked.results.length === 0) {
                errors.push(`${provider.name}: no qualifying results`);
                continue;
            }
            if (ranked.passingCount >= 3 || ranked.isStrongTopResult) {
                return {
                    providerName: provider.name,
                    results: ranked.results.slice(0, max),
                    rawResultCount: ranked.rawResultCount,
                    answer: parsed.answer,
                    lowConfidence: false,
                };
            }
            errors.push(`${provider.name}: weak relevance`);
            continue;
        }

        errors.push(`${provider.name}: ${
            _isChallengePage(resp.body, resp.status)
                ? 'search provider returned an anti-bot challenge'
                : 'no results'
        }`);
    }

    if (bestWeak && bestWeak.results.length > 0) {
        return {
            providerName: bestWeak.providerName,
            results: bestWeak.results.slice(0, max),
            rawResultCount: bestWeak.rawResultCount,
            answer: bestWeak.answer,
            lowConfidence: true,
        };
    }

    const onlyNoResults = errors.length > 0 &&
        errors.every(error => /: no (results|qualifying results)$/.test(error));
    if (onlyNoResults) {
        if (hasSiteConstraint) {
            throw new Error(`No search results found for site: ${signals.includeSites.join(', ')}.`);
        }
        throw new Error(`No search results found for query: ${query}.`);
    }
    throw new Error(_searchFailureMessage(errors));
}

// ─── Output formatting ─────────────────────────────────────────────────────────

// Prepended when the chain could only recover weak-relevance results, so the
// model treats them as leads instead of citable facts (ported from
// better-deepseek #148).
const LOW_CONFIDENCE_NOTICE =
    '> ⚠️ Low-confidence results: no search provider returned strongly relevant matches. Verify before citing.';

function _formatResults(query, results, providerName, answer, lowConfidence) {
    const lines = [];
    if (lowConfidence) lines.push(LOW_CONFIDENCE_NOTICE, '');
    lines.push(`Query: ${query}`);
    if (answer) lines.push('', '## Synthesized answer', answer);
    if (!results.length) {
        lines.push('', '(No results.)');
    } else {
        lines.push('', `## Top ${results.length} result(s)`);
        results.forEach((r, i) => {
            let title = cleanSearchText(r.title);
            if (!title) {
                try { title = r.url ? new URL(r.url).hostname : '(no title)'; }
                catch { title = '(no title)'; }
            }
            lines.push('', `### ${i + 1}. ${title}`);
            if (r.url) lines.push(r.url);
            const snippet = cleanSearchText(r.snippet);
            if (snippet) lines.push(snippet);
        });
    }
    return truncate(lines.join('\n'));
}

// ─── Deep fetch (adapted from better-deepseek search-reader.js @ c789a0b,
// the same source version pinned in the header — formatDeepFetchContent +
// the deepFetch loop of searchWeb) ───────────────────────────────────────
// After a ranked search, fetch full content of the top N result pages and
// append it as a markdown appendix. One call instead of web_search + N ×
// web_fetch. A failing page degrades to an inline note — it must not fail
// the whole search (per bds behaviour, ported as-is).

function formatDeepFetchContent(title, url, markdown) {
    const lines = [];
    lines.push('');
    lines.push('='.repeat(64));
    lines.push(`## Page Content: ${title}`);
    lines.push(`**Source:** ${url}`);
    lines.push('='.repeat(64));
    lines.push('');
    lines.push(markdown);
    lines.push('');
    lines.push('---');
    lines.push('');
    return lines.join('\n');
}

/**
 * Fetch the top `top` ranked results' pages and return the deep-fetch
 * appendix. `fetchPage(url)` must resolve to the page text or reject.
 */
async function _deepFetchPages(results, top, fetchPage, abortSignal = null) {
    const urlsToFetch = (results || []).slice(0, top);
    let output = '';
    for (let i = 0; i < urlsToFetch.length; i++) {
        if (abortSignal && abortSignal.aborted) throw new Error('aborted');
        const result = urlsToFetch[i];
        try {
            const text = await fetchPage(result.url);
            output += formatDeepFetchContent(result.title, result.url, text);
        } catch (err) {
            output += formatDeepFetchContent(
                result.title,
                result.url,
                `*(Failed to fetch page content: ${err.message || String(err)})*`
            );
        }
    }
    return output;
}

// ─── Main dispatch ─────────────────────────────────────────────────────────────

/**
 * Run a web search and return structured results.
 *
 * Shared by toolWebSearch (web_search) and toolFetchTop (fetch_top) so the
 * deep-fetch tool can consume raw results instead of re-parsing markdown.
 * `deepFetch > 0` additionally fetches the top N ranked pages and returns
 * the content appendix in `deepFetchOutput` (port of bds searchWeb deepFetch).
 *
 * @param {string} query
 * @param {{ max?: number, deepFetch?: number, searchDepth?: string, includeAnswer?: boolean, ctx?: object }} opts
 * @returns {Promise<{ results: Array<{title,url,snippet}>, providerName: string, answer?: string, lowConfidence?: boolean, deepFetchOutput?: string }>}
 * @throws {Error} when no results / all providers fail / key missing.
 */
async function searchWeb(query, { max = 5, deepFetch = 0, searchDepth = 'basic', includeAnswer = true, ctx = {} } = {}) {
    const abortSignal = ctx.abortSignal;

    const vscode  = require('vscode');
    const cfg     = vscode.workspace.getConfiguration('deepseekAgent');
    const setting = cfg.get('webSearchProvider') || 'auto';

    if (setting === 'tavily' || setting === 'auto') {
        const secrets = ctx.secrets;
        const apiKey  = secrets ? await secrets.get('deepseekAgent.tavilyKey') : undefined;
        if (setting === 'tavily' && !apiKey) {
            throw new Error('Tavily API key not configured. Run command "Deep Copilot: Set Tavily API Key" or switch webSearchProvider to "auto"/"duckduckgo"/"bing" in settings (no key required).');
        }
        if (apiKey) {
            const depth = searchDepth === 'advanced' ? 'advanced' : 'basic';
            const { results, answer } = await _tavilySearch(query, { apiKey, max, depth, includeAnswer, abortSignal });
            const deepFetchOutput = deepFetch > 0
                ? await _deepFetchPages(results, deepFetch, (url) => _fetchPageText(url, ctx), abortSignal)
                : '';
            return { results, providerName: 'Tavily', answer, lowConfidence: false, deepFetchOutput };
        }
        // 'auto' without a key — fall through to the DDG chain.
    }

    if (setting === 'bing') {
        const { results, providerName, answer, lowConfidence } = await _runSearchChain(query, {
            max,
            providers: [_bingRssProvider(query, { max, abortSignal })],
        });
        const deepFetchOutput = deepFetch > 0
            ? await _deepFetchPages(results, deepFetch, (url) => _fetchPageText(url, ctx), abortSignal)
            : '';
        return { results, providerName, answer, lowConfidence, deepFetchOutput };
    }

    // 'auto' (no key) / 'duckduckgo' — DDG chain with Bing as last fallback.
    // site: queries start with Bing (DDG ranks site: poorly).
    const ddg = _ddgProviders(query, { abortSignal });
    const bing = _bingRssProvider(query, { max, abortSignal });
    const providers = extractSearchSignals(query).includeSites.length > 0
        ? [bing, ...ddg]
        : [...ddg, bing];

    const chainResult = await _runSearchChain(query, { max, providers });
    const deepFetchOutput = deepFetch > 0
        ? await _deepFetchPages(chainResult.results, deepFetch, (url) => _fetchPageText(url, ctx), abortSignal)
        : '';
    return { ...chainResult, deepFetchOutput };
}

/** Fetch one page's text via web-fetch (SSRF-blocked). */
async function _fetchPageText(url, ctx) {
    const { fetchAndExtractText } = require('./web-fetch');
    const res = await fetchAndExtractText({ url }, ctx);
    if (!res.ok) throw new Error(res.error || `failed to fetch ${url}`);
    return res.body;
}

async function toolWebSearch(args, ctx = {}) {
    try {
        const query = String(args.query || '').trim();
        if (!query) return 'Error: query is empty.';

        const max      = Math.max(1, Math.min(10, Number.isFinite(args.max_results) ? args.max_results : 5));
        const deepFetch = Math.max(0, Math.min(5, Number.isFinite(args.deep_fetch) ? args.deep_fetch : 0));
        const { results, providerName, answer, lowConfidence, deepFetchOutput } = await searchWeb(query, {
            max,
            deepFetch,
            searchDepth: args.search_depth,
            includeAnswer: args.include_answer !== false,
            ctx,
        });
        const base = _formatResults(query, results, providerName, answer, lowConfidence);
        return deepFetchOutput ? truncate(base + '\n' + deepFetchOutput) : base;
    } catch (e) { return `Error: ${e.message || String(e)}`; }
}

module.exports = {
    toolWebSearch,
    searchWeb,
    // Shared internals (also used by fetch-top.js); no vscode dependency.
    LOW_CONFIDENCE_NOTICE,
    _parseDdgResults,
    _decodeDdgRedirect,
    _isChallengePage,
    _runSearchChain,
    _formatResults,
    formatDeepFetchContent,
    _deepFetchPages,
    _parseBingRss,
};
