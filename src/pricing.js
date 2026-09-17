// Pricing — all numbers live in the provider JSONs. Two layers stack on top of
// the per-model `pricing` block:
//   - `pricing.discount.until` — a one-off promo that replaces the base prices
//     until an ISO timestamp passes;
//   - provider-level `pricingPolicy.offPeakDiscount` — vendors whose price
//     depends on the hour (DeepSeek halves every price outside its peak
//     windows). Declared prices are the peak ones.
// This module is just the lookup + cost arithmetic.
'use strict';

const { listProviders, getProvider, getModel } = require('./providers');

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const _formatterCache = new Map();

/**
 * Wall-clock time at `at` inside `timeZone`: weekday (0 = Sunday) and minutes
 * since midnight. Intl is used so peak windows stay anchored to the vendor's
 * zone as written in the provider JSON, never to the user's local one.
 */
function _localTime(timeZone, at) {
    let fmt = _formatterCache.get(timeZone);
    if (!fmt) {
        fmt = new Intl.DateTimeFormat('en-US', {
            timeZone,
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        });
        _formatterCache.set(timeZone, fmt);
    }
    const parts = fmt.formatToParts(at);
    const pick = (type) => { const p = parts.find((x) => x.type === type); return p ? p.value : undefined; };
    return {
        weekday: WEEKDAYS[pick('weekday')],
        minutes: Number(pick('hour')) * 60 + Number(pick('minute')),
    };
}

function _hhmm(value) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(value == null ? '' : value));
    if (!m) return null;
    const hours = Number(m[1]);
    const mins = Number(m[2]);
    if (hours > 23 || mins > 59) return null;
    return hours * 60 + mins;
}

/** True when `at` falls inside one of the policy's peak windows. */
function _insidePeakWindows(policy, at) {
    let local;
    try {
        local = _localTime(policy.timezone || 'UTC', at);
    } catch {
        // Unknown timezone / missing ICU data: assume peak, so a broken policy
        // can only leave prices as declared and never silently halve them.
        return true;
    }
    for (const w of policy.peakWindows || []) {
        if (!Array.isArray(w.weekdays) || !w.weekdays.includes(local.weekday)) continue;
        const from = _hhmm(w.from);
        const to = _hhmm(w.to);
        if (from == null || to == null) continue;
        const hit = from <= to
            ? (local.minutes >= from && local.minutes < to)   // same-day window
            : (local.minutes >= from || local.minutes < to);  // window across midnight
        if (hit) return true;
    }
    return false;
}

/**
 * Find a model's pricing record across every registered provider, together with
 * the vendor-level policy that may modify it. Returns null for unknown models.
 */
function _findModelPricing(model) {
    if (typeof model !== 'string' || !model) return null;
    // `listProviders()` returns the trimmed outward view for the webview — it
    // carries neither `pricing` nor `pricingPolicy`, so the raw provider entry
    // is fetched per id.
    for (const { id } of listProviders()) {
        const m = getModel(id, model);
        if (!m || !m.pricing) continue;
        const provider = getProvider(id);
        return { pricing: m.pricing, policy: (provider && provider.pricingPolicy) || null };
    }
    return null;
}

/**
 * Resolve the *effective* pricing for a model at `at` (defaults to now).
 * An active `discount` is applied first, then the provider's off-peak modifier.
 * The result carries `hourly: true` for vendors with an hourly policy, plus
 * `off_peak: true` and `multiplier` while the off-peak price is in force — so
 * callers can label the number they show.
 */
function getModelPricing(model, at) {
    const when = at == null ? Date.now() : at;
    const found = _findModelPricing(model);
    if (!found) return null;

    const raw = found.pricing;
    let effective = {
        input:     raw.input,
        cache_hit: raw.cache_hit,
        output:    raw.output,
        discount:  undefined,
    };

    const d = raw.discount;
    if (d && d.until) {
        const until = Date.parse(d.until);
        if (!Number.isNaN(until) && when < until) {
            effective = {
                input:     d.input     != null ? d.input     : raw.input,
                cache_hit: d.cache_hit != null ? d.cache_hit : raw.cache_hit,
                output:    d.output    != null ? d.output    : raw.output,
                discount:  d.label || true,
            };
        }
    }

    const policy = found.policy && found.policy.offPeakDiscount;
    let offPeak = false;
    if (policy && typeof policy.multiplier === 'number' && !_insidePeakWindows(policy, when)) {
        offPeak = true;
        effective = {
            input:     effective.input     * policy.multiplier,
            cache_hit: effective.cache_hit * policy.multiplier,
            output:    effective.output    * policy.multiplier,
            discount:  effective.discount,
        };
    }

    const out = {
        input:     effective.input,
        cache_hit: effective.cache_hit,
        output:    effective.output,
    };
    if (effective.discount !== undefined) out.discount = effective.discount;
    if (policy) out.hourly = true;
    if (offPeak) {
        out.off_peak   = true;
        out.multiplier = policy.multiplier;
    }
    return out;
}

/**
 * Bounds of the window `at` falls into: peak windows come from the provider JSON,
 * everything outside them is off-peak. Minutes are counted from Sunday 00:00 and
 * windows are weekly, so "the next peak starts" can be days away — this is what
 * lets the UI show how much of the current window is left.
 */
function _pricingWindow(policy, at) {
    let local;
    try {
        local = _localTime(policy.timezone || 'UTC', at);
    } catch {
        return null; // unknown timezone: no window to draw
    }
    const nowAbs = local.weekday * 1440 + local.minutes;

    // Peak spans as [start, end) in weekly minutes. A window crossing midnight is
    // kept as one span longer than a day, which compares correctly against nowAbs.
    const spans = [];
    for (const w of policy.peakWindows || []) {
        if (!Array.isArray(w.weekdays)) continue;
        const from = _hhmm(w.from);
        const to = _hhmm(w.to);
        if (from == null || to == null) continue;
        for (const day of w.weekdays) {
            const start = day * 1440 + from;
            spans.push([start, start + (to > from ? to - from : 1440 - from + to)]);
        }
    }
    if (!spans.length) return null;

    const toMs = (minute) => at + (minute - nowAbs) * 60000;
    const peak = spans.find(([s, e]) => nowAbs >= s && nowAbs < e);
    if (peak) return { offPeak: false, startsAt: toMs(peak[0]), endsAt: toMs(peak[1]) };

    // Off-peak: it began when the previous peak ended and runs until the next
    // peak starts. Peak spans repeat weekly, so this week's copy plus the two
    // neighbours cover the nearest boundary on either side of now.
    let started = -Infinity;
    let ends = Infinity;
    for (const [s, e] of spans) {
        for (const shift of [-10080, 0, 10080]) {
            const e2 = e + shift;
            const s2 = s + shift;
            if (e2 <= nowAbs && e2 > started) started = e2;
            if (s2 > nowAbs && s2 < ends) ends = s2;
        }
    }
    return { offPeak: true, startsAt: toMs(started), endsAt: toMs(ends) };
}

/**
 * Hourly-price mode for a model at `at`: whether the vendor has an off-peak
 * policy at all (`hourly`) and, when it does, whether that price is in force
 * right now plus the bounds of the current window, so the UI can label the mode
 * and draw how much of it is left without re-deriving any of this. The `when`
 * field is the instant all of that describes: callers should measure against it
 * rather than against their own clock, so both sides agree on "now".
 */
function getPricingMode(model, at) {
    const when = at == null ? Date.now() : at;
    const found = _findModelPricing(model);
    const policy = found && found.policy && found.policy.offPeakDiscount;
    if (!policy) return { hourly: false };
    const win = _pricingWindow(policy, when);
    // The window in whole minutes: how much of it is left right now, and how long
    // it lasts in total. Nothing else is needed to draw the share.
    return { hourly: true, when,
        off_peak:   !_insidePeakWindows(policy, when),
        multiplier: policy.multiplier,
        window:     win ? Math.round((win.endsAt - win.startsAt) / 60000) : 0,
        windowLeft: win ? Math.round(Math.max(0, win.endsAt - when) / 60000) : 0,
    };
}

function computeCost(model, usage, at) {
    if (!usage) return { cost_cny: 0 };
    const p          = getModelPricing(model, at);
    const prompt     = usage.prompt_tokens || 0;
    const completion = usage.completion_tokens || 0;
    const cacheHit   = usage.prompt_cache_hit_tokens || 0;
    const cacheMiss  = (usage.prompt_cache_miss_tokens != null)
        ? usage.prompt_cache_miss_tokens
        : Math.max(prompt - cacheHit, 0);
    if (!p) {
        return {
            cost_cny: 0,
            breakdown: {
                cache_hit_tokens:  cacheHit,
                cache_miss_tokens: cacheMiss,
                completion_tokens: completion,
                prompt_tokens:     prompt,
                total_tokens:      usage.total_tokens || (prompt + completion),
                pricing:           null,
            },
        };
    }
    const cost =
        (cacheHit   / 1e6) * p.cache_hit +
        (cacheMiss  / 1e6) * p.input +
        (completion / 1e6) * p.output;
    return {
        cost_cny: cost,
        breakdown: {
            cache_hit_tokens:  cacheHit,
            cache_miss_tokens: cacheMiss,
            completion_tokens: completion,
            prompt_tokens:     prompt,
            total_tokens:      usage.total_tokens || (prompt + completion),
            pricing:           p,
        },
    };
}

module.exports = { getModelPricing, getPricingMode, computeCost };
