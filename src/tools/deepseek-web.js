// DeepSeek's own web tools: Search and Fetch.
//
// Both are plain REST calls, not tool definitions inside chat/completions, so they do not
// change the shape of a model request and cannot disturb the prompt cache:
//   POST {base}/v1/tools/search  { query, count, need_content, ori_question, ... }
//   POST {base}/v1/tools/fetch   { url }
// Documented at api-docs.deepseek.com/zh-cn/guides/search. Authenticated with the same key
// the chat uses, billed per *successful* request (5 CNY per 1000, so 0.005 per call) and
// rate limited to 5 QPS per account, separately for each endpoint.
'use strict';

const https = require('https');
const http = require('http');

const DEFAULT_BASE   = 'https://api.deepseek.com';
const SEARCH_PATH    = '/v1/tools/search';
const FETCH_PATH     = '/v1/tools/fetch';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS     = 20000;

// The endpoints hang off {base}/v1/tools/..., so a base URL that already ends in /v1 must
// not produce /v1/v1/.
function apiBase(providerBaseUrl) {
    return String(providerBaseUrl || DEFAULT_BASE)
        .replace(/\/+$/, '')
        .replace(/\/v1$/, '');
}

// A custom apiBaseUrl counts only when the chat provider is DeepSeek itself; otherwise the
// registry default is the right host.
function resolveBaseUrl(cfg) {
    try {
        const provider = cfg && (cfg.get('provider') || 'deepseek');
        if (provider === 'deepseek') {
            const custom = cfg.get('apiBaseUrl');
            if (custom) return String(custom);
        }
    } catch { /* no vscode configuration available: fall through to the registry */ }
    try {
        const { getProvider } = require('../providers');
        return (getProvider('deepseek') || {}).baseUrl || DEFAULT_BASE;
    } catch { return DEFAULT_BASE; }
}

async function keyFrom(ctx) {
    const secrets = ctx && ctx.secrets;
    if (!secrets) return undefined;
    try { return await secrets.get('deepseekAgent.apiKey'); } catch { return undefined; }
}

// The API allows 5 requests per second per account, separately for Search and Fetch. A turn
// with several parallel web_search calls, or several sub-agents, would otherwise collect 429s —
// and in "auto" mode a 429 quietly moves the search onto Bing. Starts are therefore spaced:
// requests still overlap, but no more than five begin in any second.
const MIN_START_GAP_MS = 200;
let _startChain = Promise.resolve();
let _lastStart = 0;

function _throttle(task) {
    const started = _startChain.then(async () => {
        const wait = MIN_START_GAP_MS - (Date.now() - _lastStart);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        _lastStart = Date.now();
    });
    _startChain = started.then(() => {}, () => {});
    return started.then(task);
}

function postJson(endpoint, apiKey, payload, abortSignal) {
    const url  = new URL(endpoint);
    const body = JSON.stringify(payload);
    const mod  = url.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
        if (abortSignal && abortSignal.aborted) return reject(new Error('aborted'));
        const req = mod.request({
            method:   'POST',
            protocol: url.protocol,
            hostname: url.hostname,
            port:     url.port || undefined,
            path:     url.pathname + url.search,
            headers:  {
                'Authorization':  `Bearer ${apiKey}`,
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        }, (res) => {
            res.on('error', reject);
            res.setEncoding('utf8');
            let raw = '';
            let bytes = 0;
            res.on('data', (c) => {
                bytes += Buffer.byteLength(c, 'utf8');
                if (bytes > MAX_BODY_BYTES) { try { req.destroy(); } catch {} return reject(new Error('Response body too large')); }
                raw += c;
            });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    const err = new Error(`DeepSeek web API HTTP ${res.statusCode}: ${raw.slice(0, 200)}`);
                    err.status = res.statusCode;
                    return reject(err);
                }
                try { resolve(JSON.parse(raw)); }
                catch (e) { reject(new Error(`DeepSeek web API returned non-JSON: ${e.message}`)); }
            });
        });
        req.on('error', reject);
        req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('Request timeout')));
        if (abortSignal) {
            const onAbort = () => { try { req.destroy(new Error('aborted')); } catch {} reject(new Error('aborted')); };
            abortSignal.addEventListener('abort', onAbort, { once: true });
            req.once('close', () => { try { abortSignal.removeEventListener('abort', onAbort); } catch {} });
        }
        req.write(body);
        req.end();
    });
}

/**
 * @returns {Promise<{results: Array<{title,url,snippet,date,authority,score}>}>}
 * `snippet` carries the long `summary` when the API provides one: it is written for a model
 * to read, unlike the 100-200 character teaser.
 */
async function search({ query, apiKey, baseUrl, max = 5, oriQuestion, abortSignal } = {}) {
    const payload = {
        query,
        count: Math.max(1, Math.min(50, Number(max) || 5)),
        need_content: false,
    };
    if (oriQuestion) payload.ori_question = String(oriQuestion).slice(0, 128);
    const data = await _throttle(() => postJson(apiBase(baseUrl) + SEARCH_PATH, apiKey, payload, abortSignal));
    const results = (Array.isArray(data.results) ? data.results : [])
        .filter(r => r && typeof r.url === 'string' && /^https?:\/\//i.test(r.url))
        .map(r => ({
            title:     String(r.title || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
            url:       r.url,
            snippet:   String(r.summary || r.snippet || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
            date:      r.date || null,
            authority: Number.isFinite(r.authority) ? r.authority : -1,
            score:     Number.isFinite(r.rerank_score) ? r.rerank_score : 0,
        }));
    // The same page often comes back more than once with different #fragments (comment anchors,
    // for instance). Compared without the fragment, those collapse into one entry.
    const seen = new Set();
    const unique = [];
    for (const r of results) {
        const key = r.url.replace(/#.*$/, '').replace(/\/+$/, '');
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(r);
    }
    return { results: unique };
}

/**
 * Fetch one page as Markdown. The API answers 404 when it cannot extract content (site
 * policy, unsupported type, no readable body) and 403 when its safety policy refuses.
 * @returns {Promise<{title: string, content: string}>}
 */
async function fetchPage({ url, apiKey, baseUrl, abortSignal } = {}) {
    const data = await _throttle(() => postJson(apiBase(baseUrl) + FETCH_PATH, apiKey, { url }, abortSignal));
    return { title: String(data.title || ''), content: String(data.content || '') };
}

module.exports = { apiBase, resolveBaseUrl, keyFrom, search, fetchPage, DEFAULT_BASE };
