// Provider-units conversion for the char heuristic.
//
// estimateTokens / estimateMessagesTokens count characters, so they run low on
// dense code by roughly 2-3x, and the factor drifts with the mix of code and
// prose in a history. The only honest calibration is the ratio between the
// prompt size the provider reports and the heuristic for the same array — and it
// has to be persisted, or every window reload starts from 1 and every readout is
// off by that factor again.
'use strict';

const SCALE_MIN = 0.25; // a heuristic that runs high is possible, but not by much
const SCALE_MAX = 8;    // a heuristic that runs 8x low is already a bug, not a ratio

function clampScale(v) {
    const n = Number(v);
    if (!(n > 0)) return 0;
    return Math.min(SCALE_MAX, Math.max(SCALE_MIN, n));
}

/**
 * Exponential moving average of successive ratios. One report is noisy — a turn
 * that is all tool output moves the ratio differently than one that is all
 * prose — so the persisted value is smoothed. The first report is taken as is.
 *
 * @param {number} prev previous smoothed ratio (0 when there is none)
 * @param {number} next freshly measured ratio (0 when there is no fact yet)
 * @param {number} [alpha] weight of the new measurement
 * @returns {number} smoothed ratio, or 0 when nothing can be computed
 */
function smoothScale(prev, next, alpha = 0.3) {
    const value = clampScale(next);
    const before = clampScale(prev);
    if (value <= 0) return before;
    return before > 0 ? (1 - alpha) * before + alpha * value : value;
}

module.exports = { SCALE_MIN, SCALE_MAX, clampScale, smoothScale };
