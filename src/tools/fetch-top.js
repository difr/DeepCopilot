// fetch_top: deep fetch — run a web search and fetch the top N result pages'
// content in one tool call.
//
// Deep fetch itself lives in web-search.js (searchWeb with the `deepFetch`
// option, ported from better-deepseek search-reader.js); this tool is a thin
// wrapper that forwards `deepFetch = top` so the model gets the page content
// appendix without a second round of web_fetch calls.
// Weak-relevance results are flagged exactly like web_search: the same
// low-confidence notice is prepended when the chain only recovered weak hits.
//
// Safety: page fetching reuses web-fetch.js (fetchAndExtractText), which
// blocks private/internal IPs (SSRF) and caps response size.
'use strict';

const { searchWeb, LOW_CONFIDENCE_NOTICE } = require('./web-search');
const { truncate }  = require('./utils');

// bds clamps deepFetch to [0, MAX_DEEP_FETCH=5] — keep the same cap.
const MAX_DEEP_FETCH = 5;

function _normalizeTop(raw) {
    const n = Number.isFinite(raw) ? Math.floor(raw) : 3;
    return Math.max(1, Math.min(MAX_DEEP_FETCH, n));
}

async function toolFetchTop(args, ctx = {}) {
    try {
        const query = String((args && args.query) || '').trim();
        if (!query) return 'Error: query is empty.';

        const top = _normalizeTop(args.top);
        const { results, providerName, answer, lowConfidence, deepFetchOutput } = await searchWeb(query, {
            max: top,
            deepFetch: top,
            ctx,
        });

        // Same preamble as web_search's _formatResults: flag weak matches
        // before the results block.
        const preamble = lowConfidence ? LOW_CONFIDENCE_NOTICE + '\n\n' : '';

        // searchWeb currently always resolves to an array (or throws), but
        // guard anyway so a malformed provider result can never crash the
        // formatter with `results.map is not a function`.
        const list = Array.isArray(results) ? results : [];

        // searchWeb already truncated the appendix; only guard the whole
        // output so a huge page set cannot blow the context budget.
        return truncate(preamble + `Query: ${query}\nProvider: ${providerName}` +
            (answer ? `\n\n## Synthesized answer\n${answer}` : '') +
            `\n\n## Top ${list.length} result(s)` +
            list.map((r, i) => `\n\n### ${i + 1}. ${r.title || r.url}\n${r.url}${r.snippet ? '\n' + r.snippet : ''}`).join('') +
            (deepFetchOutput ? '\n' + deepFetchOutput : ''));
    } catch (e) {
        return `Error: ${e.message || String(e)}`;
    }
}

module.exports = {
    toolFetchTop,
    // Exported for scripts/test-fetch-top.js (pure internals).
    _normalizeTop,
};
