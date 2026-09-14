// Aggregating token usage across a turn.
//
// One agentic turn makes one API call per iteration (every tool round-trip is
// another call), and each call reports its own `usage`. What the session totals
// need — and what the footer should show after a reload — is the sum across the
// whole turn, not whatever the last iteration happened to report.
'use strict';

/** Numeric usage fields that add up across iterations. */
const FIELDS = [
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'prompt_cache_hit_tokens',
    'prompt_cache_miss_tokens',
];

/**
 * Fold one iteration's `usage` into an accumulator. `total_tokens` is derived
 * per iteration when the API omits it, so the summed total stays consistent
 * with the prompt + completion columns. Returns a new object and never mutates
 * either argument; a null `usage` leaves the accumulator as it was.
 */
function sumUsage(acc, usage) {
    if (!usage) return acc || null;
    const out = {};
    for (const f of FIELDS) out[f] = acc ? Number(acc[f] || 0) : 0;
    for (const f of FIELDS) {
        if (f !== 'total_tokens') out[f] += Number(usage[f] || 0);
    }
    out.total_tokens += Number(
        usage.total_tokens != null
            ? usage.total_tokens
            : Number(usage.prompt_tokens || 0) + Number(usage.completion_tokens || 0),
    );
    return out;
}

module.exports = { sumUsage, FIELDS };
