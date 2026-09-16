// Compaction policy — the single source of truth for the numbers that decide
// when history is summarised, how much of it survives, and where the emergency
// ceiling sits.
//
// Deliberately free of `vscode`: the caller passes the workspace configuration
// and (optionally) a logger, so this stays loadable from plain node scripts.
'use strict';

// Fallbacks for a missing or nonsensical setting. They mirror the manifest
// defaults, so a hand-edited settings.json cannot silently disable compaction
// or make it fire on every iteration.
const DEFAULTS = Object.freeze({
    budgetShare:    0.75,  // share of the model window used as the token budget
    maxBudgetShare: 0.95,
    minBudget:      8000,  // floor, so a small window still gets a workable budget
    minMessages:    20,
    maxMessages:    1200,  // hard cap on the message count, independent of tokens
    keepTail:       300,   // messages kept verbatim when the head is summarised
    minKeepTail:    2,
    hardLimitShare: 0.9,   // preflight ceiling; above it the emergency ladder runs
    fallbackWindow: 65536, // used when the model entry has no contextWindow
});

function _positive(raw, fallback) {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolve the effective compaction numbers for one turn.
 *
 * `compactBudgetTokens` keeps its documented meaning — an explicit token
 * budget. 0 (or unset) means "derive it from the active model's window" via
 * `compactBudgetShare`; a fixed default cannot work across providers, since
 * 700000 on a 200K-window model would never fire while 96000 on a 1M window
 * fires at 10% of capacity.
 *
 * @param {object} cfg      workspace configuration for the `deepseekAgent` section
 * @param {object} modelCfg resolved model entry (needs `contextWindow`)
 * @param {{info: Function}} [logger] optional logger, used only when a value had to be adjusted
 * @returns {{budget:number,maxMessages:number,keepTail:number,hardLimit:number,window:number,share:number,hardLimitShare:number,warnings:string[]}}
 */
function readCompactPolicy(cfg, modelCfg, logger) {
    const warnings = [];
    const window   = _positive(modelCfg && modelCfg.contextWindow, DEFAULTS.fallbackWindow);

    const share      = Math.min(DEFAULTS.maxBudgetShare, _positive(cfg.get('compactBudgetShare'), DEFAULTS.budgetShare));
    const configured = Number(cfg.get('compactBudgetTokens'));

    let budget;
    if (Number.isFinite(configured) && configured > 0) {
        budget = Math.max(DEFAULTS.minBudget, Math.floor(configured));
        if (configured < DEFAULTS.minBudget) {
            warnings.push(`compactBudgetTokens ${configured} is below the floor, using ${budget}`);
        }
    } else {
        budget = Math.max(DEFAULTS.minBudget, Math.floor(window * share));
    }

    const maxMessages = Math.max(
        DEFAULTS.minMessages,
        Math.floor(_positive(cfg.get('compactMaxMessages'), DEFAULTS.maxMessages)),
    );

    let keepTail = Math.max(
        DEFAULTS.minKeepTail,
        Math.floor(_positive(cfg.get('compactKeepTail'), DEFAULTS.keepTail)),
    );
    if (keepTail >= maxMessages) {
        const clamped = Math.max(DEFAULTS.minKeepTail, Math.floor(maxMessages / 2));
        warnings.push(`compactKeepTail ${keepTail} reaches compactMaxMessages ${maxMessages} and would leave nothing to summarise, using ${clamped}`);
        keepTail = clamped;
    }

    const hardLimitShare = Math.min(0.98, _positive(cfg.get('compactHardLimitShare'), DEFAULTS.hardLimitShare));
    const hardLimit      = Math.floor(window * hardLimitShare);
    if (hardLimit <= budget) {
        warnings.push(`compactHardLimitShare ${hardLimitShare} puts the hard limit (${hardLimit}) at or below the compact budget (${budget})`);
    }

    const policy = { budget, maxMessages, keepTail, hardLimit, window, share, hardLimitShare, warnings };
    if (warnings.length && logger && typeof logger.info === 'function') {
        try { logger.info('COMPACT_POLICY_ADJUSTED', { ...policy }); } catch { /* logging must never throw */ }
    }
    return policy;
}

module.exports = { readCompactPolicy, COMPACT_DEFAULTS: DEFAULTS };
