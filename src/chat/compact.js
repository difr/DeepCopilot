// Compact utilities: token estimation, history auto-compaction, and
// tool-argument streaming parser.
//
// No VS Code dependencies. Uses global `fetch` (Node 18+) only for the
// optional LLM-backed summarisation path in autoCompactIfNeeded.
// Safe to import from any layer without circular-dep risk.
'use strict';

// ─── Token estimator ───────────────────────────────────────────────────────
// Token counting is delegated to `src/api/token-counter`, which dispatches to
// a provider-aware tokenizer:
//   - a char-based heuristic for every vendor (no local BPE tokenizer: the
//     exact counts are provider-side and arrive with `usage`)
//   - the SYNC path for Anthropic — exact Anthropic counts are network-only
//     and live on `countMessagesAsync`, which this estimator does NOT call.
// See issue #149.
//
// The legacy `estimateTokens(text)` / `estimateMessagesTokens(messages)`
// signatures are preserved for backwards compatibility; pass an optional
// `ctx = { provider, model }` to get a provider-specific estimate, otherwise
// the heuristic is used.
// Used only for autoCompact triggers, never for billing.

const tokenCounter = require('../api/token-counter');

function estimateTokens(text, ctx) {
    return tokenCounter.countText(text, ctx);
}

function estimateMessagesTokens(messages, ctx) {
    return tokenCounter.countMessages(messages, ctx);
}

// ─── Tool-result truncation ────────────────────────────────────────────────
// Truncate oversized tool results to preserve semantic content while reducing
// token count.  Non-destructive: returns new message objects; originals untouched.
//
// Strategy (Issue #142 P0-4 / P1-1): keep HEAD + TAIL with omitted-middle marker.
// Head preserves prelude (file header, command echo, first error); tail preserves
// the conclusive part (exit code, last error, summary line).

const TOOL_RESULT_LONG      = 2000; // chars — threshold for truncation
const TOOL_RESULT_KEEP_HEAD = 1200; // chars — keep from the front
const TOOL_RESULT_KEEP_TAIL = 400;  // chars — keep from the end
// nuclearCompact uses inline 800/200 head/tail values; the earlier constants
// were never read — removed to satisfy CodeQL js/useless-assignment-to-local.

// Bodies already shrunk by an earlier pass carry a marker. The structure-aware paths below
// write their own wording, so every marker is listed here.
const _TRUNC_MARKER_RX = /\[truncated — \d+ chars omitted|\[\d+ duplicate\/extra matches dropped|\[\d+ entries omitted from middle|\[\d+ total lines — only errors/;

// What a body already carries: the original length it reported and the head width of the
// window that produced it. A marker without a window — one written before the window was
// recorded, or by a structure-aware path — counts as the widest tier, so it can still be cut
// deeper but never wider. Null means the body was never cut.
function _truncState(body) {
    const withWindow = /\[truncated — \d+ chars omitted, original (\d+) chars, window (\d+)\/\d+\]/.exec(body);
    if (withWindow) return { original: Number(withWindow[1]), depth: Number(withWindow[2]) };
    const older = /original (\d+) chars/.exec(body);
    if (older) return { original: Number(older[1]), depth: 1200 };
    return _TRUNC_MARKER_RX.test(body) ? { original: 0, depth: 1200 } : null;
}

function _truncateBody(body, headKeep, tailKeep) {
    const total = body.length;
    if (total <= headKeep + tailKeep + 80) return body;
    const state = _truncState(body);
    // A deeper window is a legitimate second cut: the ladder walks one body down tier by tier
    // until the checkpoint fits. The same window, or a wider one, is a repeat — the body and
    // its marker stay as they are.
    if (state && headKeep >= state.depth) return body;
    const original = (state && state.original) || total;
    const head = body.slice(0, headKeep);
    const tail = body.slice(total - tailKeep);
    const omitted = original - headKeep - tailKeep;
    return `${head}\n…[truncated — ${omitted} chars omitted, original ${original} chars, window ${headKeep}/${tailKeep}]…\n${tail}`;
}

// ─── Structure-aware truncation (Issue #142 P1-1) ──────────────────────────
// Inspect the tool name and apply the strategy best suited to its output:
//   - grep_search    : dedup duplicate file:line entries, cap to N hits
//   - list_dir       : keep first/last entries with omitted-middle hint
//   - find_files     : same as list_dir
//   - read_file      : preserve numbered head + tail (line-aware)
//   - run_shell      : preserve error-bearing lines + tail (exit code lives there)
//   - default        : generic head + tail body truncation
//
// Returns a (possibly identical) body string.
function _smartTruncateByTool(body, toolName, headKeep, tailKeep) {
    if (body.length <= headKeep + tailKeep + 80) return body;
    if (_TRUNC_MARKER_RX.test(body)) return body;
    const lines = body.split('\n');
    const totalLines = lines.length;

    if (toolName === 'grep_search') {
        // Dedup by (file:line) prefix, keep first occurrence.
        // Greedy match on the path so Windows drive letters (e.g.
        // `C:\foo\bar.js:12:hit`) still parse correctly — the previous
        // `^([^:]+:\d+):` regex would only match up to the first colon and
        // drop drive-letter paths from the dedup (Copilot review feedback).
        const seen = new Set();
        const deduped = [];
        for (const ln of lines) {
            const key = ln.match(/^(.+):(\d+):/);
            const k = key ? `${key[1]}:${key[2]}` : ln;
            if (seen.has(k)) continue;
            seen.add(k);
            deduped.push(ln);
            if (deduped.length >= 80) break; // hard cap
        }
        const out = deduped.join('\n');
        if (deduped.length < totalLines) {
            return `${out}\n…[${totalLines - deduped.length} duplicate/extra matches dropped — original ${totalLines} lines]`;
        }
        return _truncateBody(out, headKeep, tailKeep);
    }

    if (toolName === 'list_dir' || toolName === 'find_files') {
        // Keep first 40 + last 20 entries.
        if (totalLines <= 80) return _truncateBody(body, headKeep, tailKeep);
        const headLines = lines.slice(0, 40);
        const tailLines = lines.slice(-20);
        return [
            ...headLines,
            `… [${totalLines - 60} entries omitted from middle, original ${totalLines}]`,
            ...tailLines,
        ].join('\n');
    }

    if (toolName === 'read_file') {
        // Numbered-line aware: bias head heavier (often holds imports / class signatures).
        return _truncateBody(body, Math.floor(headKeep * 1.4), tailKeep);
    }

    if (toolName === 'run_shell' || toolName === 'run_shell_bg' || toolName === 'read_terminal') {
        // Error-aware: extract lines containing error markers; combine with tail.
        const errLines = [];
        for (const ln of lines) {
            if (/error|fail|exception|traceback|panic|fatal/i.test(ln)) {
                errLines.push(ln);
                if (errLines.length >= 30) break;
            }
        }
        const tail = lines.slice(-30).join('\n');
        const errBlock = errLines.length ? `[error lines]\n${errLines.join('\n')}\n\n` : '';
        const combined = `${errBlock}…[${totalLines} total lines — only errors + tail shown]…\n[tail]\n${tail}`;
        // If still larger than budget, fall back to generic truncation.
        return combined.length <= headKeep + tailKeep + 200
            ? combined
            : _truncateBody(combined, headKeep, tailKeep);
    }

    return _truncateBody(body, headKeep, tailKeep);
}

// Build a Map<tool_call_id, tool_name> by walking assistant{tool_calls}
// messages.  Used so tool result messages can be truncated using the
// appropriate per-tool strategy.
function _buildToolIdNameMap(messages) {
    const map = new Map();
    for (const m of messages) {
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) {
                if (tc && tc.id && tc.function && tc.function.name) {
                    map.set(tc.id, tc.function.name);
                }
            }
        }
    }
    return map;
}

function truncateLongToolResults(messages, opts = {}) {
    const headKeep = opts.headKeep || TOOL_RESULT_KEEP_HEAD;
    const tailKeep = opts.tailKeep || TOOL_RESULT_KEEP_TAIL;
    const threshold = opts.threshold || TOOL_RESULT_LONG;
    const idToName = _buildToolIdNameMap(messages);
    let truncCount = 0;
    const result = messages.map(m => {
        if (m.role !== 'tool') return m;
        // Cache-friendly: if a tool result was already truncated by a prior
        // pass, reuse it verbatim. Re-running the smart truncator on a body
        // that already contains "[truncated — …]" can still produce a byte-
        // identical result, but flagging it explicitly with `_cacheFrozen`
        // guarantees object identity (and hence byte identity) for the
        // DeepSeek prefix-cache hash.
        if (m._cacheFrozen) return m;
        const body = typeof m.content === 'string' ? m.content
            : (Array.isArray(m.content) ? m.content.map(p => (p && p.text) || '').join('') : '');
        if (body.length <= threshold) return m;
        truncCount++;
        const toolName = m.tool_call_id ? idToName.get(m.tool_call_id) : null;
        const newBody = _smartTruncateByTool(body, toolName, headKeep, tailKeep);
        return { ...m, content: newBody, _cacheFrozen: true };
    });
    return { messages: result, truncCount };
}

// Truncate ANY oversized message body (user / assistant / tool).  Used by the
// nuclear path and by autoCompactIfNeeded's last-resort branch when even the
// firstUser anchor or tail messages are individually too large to fit.
function _truncateAnyLongMessage(m, headKeep, tailKeep, threshold) {
    if (typeof m.content === 'string') {
        if (m.content.length <= threshold) return m;
        return { ...m, content: _truncateBody(m.content, headKeep, tailKeep) };
    }
    if (Array.isArray(m.content)) {
        const newContent = m.content.map(p => {
            if (p && typeof p.text === 'string' && p.text.length > threshold) {
                return { ...p, text: _truncateBody(p.text, headKeep, tailKeep) };
            }
            return p;
        });
        return { ...m, content: newContent };
    }
    return m;
}

// ─── File-read deduplication (Issue #142 P1-3) ─────────────────────────────
// When the same file path is read multiple times in a session, all but the
// LAST occurrence are replaced with a tiny placeholder.  The latest read is
// always the most up-to-date snapshot, so older copies waste tokens.
//
// Detection: walks assistant{tool_calls} entries where function.name is
// `read_file` (or list_dir / web_fetch) with a `path` (or `url`) argument.
// The matching tool result message (by tool_call_id) gets its content
// replaced.  Returns { messages, replaced }.
function dedupRepeatedReads(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return { messages, replaced: 0 };
    }
    // Build (tool_call_id → {key, name}) for repeatable read tools.
    const idMeta = new Map();
    for (const m of messages) {
        if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
        for (const tc of m.tool_calls) {
            const name = tc?.function?.name;
            if (!name || !tc.id) continue;
            if (name !== 'read_file' && name !== 'web_fetch' && name !== 'list_dir') continue;
            let args = {};
            try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
            const target = args.path || args.url || args.file || args.file_path;
            if (!target) continue;
            // Range-aware key for read_file: same path + range is the "same read".
            const range = (args.start_line || args.end_line)
                ? `:${args.start_line || ''}-${args.end_line || ''}`
                : '';
            idMeta.set(tc.id, { key: `${name}::${target}${range}`, name });
        }
    }
    // Find the LAST tool_call_id for each key.
    const lastIdForKey = new Map();
    for (const m of messages) {
        if (m.role !== 'tool' || !m.tool_call_id) continue;
        const meta = idMeta.get(m.tool_call_id);
        if (!meta) continue;
        lastIdForKey.set(meta.key, m.tool_call_id);
    }
    // Replace any non-last tool message body with a placeholder.
    let replaced = 0;
    const out = messages.map(m => {
        if (m.role !== 'tool' || !m.tool_call_id) return m;
        const meta = idMeta.get(m.tool_call_id);
        if (!meta) return m;
        const lastId = lastIdForKey.get(meta.key);
        if (!lastId || lastId === m.tool_call_id) return m;
        const body = typeof m.content === 'string' ? m.content : '';
        if (body.length < 400) return m; // not worth replacing small ones
        replaced++;
        // Use a structured placeholder tag so the LLM (and any downstream
        // post-processing) can reliably detect collapsed reads — matches the
        // shape documented in the PR description (Copilot review feedback).
        const path = meta.key.split('::')[1] || '';
        return {
            ...m,
            content: `<${meta.name} path="${path}" read-collapsed="true" reason="re-read later in conversation; see the later tool result for current contents"/>`,
        };
    });
    return { messages: out, replaced };
}

// ─── Head-facts extractor ──────────────────────────────────────────────────
// Pulls key structured events from messages about to be dropped: tool calls
// with their primary argument (file path, command, URL) and short snippets
// of assistant prose.  Used to build the compact-summary placeholder.

function extractHeadFacts(messages) {
    const lines = [];
    for (const m of messages) {
        if (m.role === 'assistant' && m.tool_calls) {
            for (const tc of m.tool_calls) {
                const name = tc.function?.name || '?';
                let detail = '';
                try {
                    const args = JSON.parse(tc.function?.arguments || '{}');
                    const target = args.path || args.file || args.file_path || args.filename
                        || args.command || args.url || '';
                    if (target) detail = ` → ${String(target).slice(0, 100)}`;
                } catch {}
                lines.push(`tool:${name}${detail}`);
            }
        }
        if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
            const snip = m.content.trim().slice(0, 200).replace(/\n+/g, ' ');
            lines.push(`asst:${snip}${m.content.trim().length > 200 ? '…' : ''}`);
        }
    }
    return lines;
}

// ─── LLM-backed summarisation ─────────────────────────────────────────────
// Calls the configured API to produce a concise semantic summary of the
// messages about to be dropped.  Silent failure: returns null on any error
// so the caller can fall back to the structured fact-extraction path.

// The API-facing fields of a message, in the payload's own order. Used to tell whether a
// snapshot still describes the live history: `_`-prefixed internals never reach the wire, and
// the reasoning placeholder the client backfills is derived from position, so neither can say
// anything about whether the conversation has moved on.
function _apiFields(m) {
    if (!m) return null;
    const out = { role: m.role };
    if (m.content !== undefined) out.content = m.content;
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (m.name) out.name = m.name;
    return out;
}

// True while the snapshot is still a prefix of the current history — the system prompt it
// carries included, since that half of the cache key is exactly why a snapshot is kept at all.
// An empty history means there is nothing to compare against, so the snapshot is trusted.
function _snapshotIsCurrent(snapshot, fullHistory) {
    if (!Array.isArray(snapshot) || !snapshot.length) return false;
    if (!snapshot[0] || snapshot[0].role !== 'system') return false;
    const history = Array.isArray(fullHistory) ? fullHistory : [];
    // A snapshot is taken before its own turn is answered, so the live history can only have
    // grown since. A longer one means messages were deleted, and the overlap alone still
    // compares equal — the stale tail has to be caught here, not by the field-by-field pass.
    if (snapshot.length - 1 > history.length) return false;
    const n = Math.min(snapshot.length - 1, history.length);
    for (let i = 0; i < n; i++) {
        if (JSON.stringify(_apiFields(snapshot[i + 1])) !== JSON.stringify(_apiFields(history[i]))) return false;
    }
    return true;
}

async function summariseHead(headMessages, apiConfig, fullHistory) {
    const { apiKey, baseUrl: rawBaseUrl, model, provider = 'deepseek', focus, prefixMessages, tools, lastRequestMessages, reasoningEffort } = apiConfig || {};
    if (!model) return null;

    // Resolve effective base URL from the provider registry (single source of truth).
    const { getProvider } = require('../providers');
    const { Logger } = require('../logger');
    const presetUrl = getProvider(provider)?.baseUrl || 'https://api.deepseek.com';
    const effectiveBaseUrl = (rawBaseUrl || presetUrl).replace(/\/$/, '');

    // Modelled on the DeepSeek Harness compaction instruction: one fixed section list keeps
    // the checkpoint resumable, and "(none)" prevents sections from being silently dropped.
    const instruction = [
        'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
        '',
        'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
        '',
        '## Primary Request and Intent',
        "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
        '',
        '## Key Technical Concepts',
        '- [technologies, frameworks, patterns, and conventions in play]',
        '',
        '## Files and Code',
        '- [exact path: why it matters, key changes or snippets]',
        '',
        '## Errors and Fixes',
        '- [error: how it was resolved, plus any related user feedback]',
        '',
        '## Pending Jobs',
        '- [explicitly requested work not yet completed]',
        '',
        '## Current Work',
        '- [precisely what was in progress at this checkpoint]',
        '',
        '## Next Step',
        '- [the single next action, in line with the most recent request, or "(none)"]',
        '',
        '## Critical Context',
        '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
        '',
        'Scope:',
        `- The conversation above is the full live context. Condense ONLY its earlier span — the first ${headMessages.length} messages after the system prompt — because your checkpoint replaces exactly that span.`,
        '- Everything after that span is the live tail: it stays in the conversation, so never summarize, restate or drop it.',
        '',
        'Rules:',
        '- Write concise engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
        '- Capture user feedback and explicit instructions faithfully, especially corrections.',
        '- Do NOT mention this summarization request or that the context was compacted.',
        '- Output only the checkpoint text: do not call any tool or take any other action.',
        '- If the conversation already contains a <compact-summary> block, it is a PRIOR checkpoint: keep still-true facts, drop stale ones, and merge newer information into one consolidated summary under the same structure.',
        (focus ? `- Bias the checkpoint toward: ${focus}` : ''),
    ].filter(Boolean).join('\n');

    // Three sources, in order of preference.
    // 1. `lastRequestMessages` — the exact array the previous turn sent. Replaying a prefix of
    //    it byte-for-byte (system prompt, then the head being replaced) makes this auxiliary
    //    call a genuine prefix of the conversation, so the provider's warm prefix cache covers
    //    everything except the trailing instruction and the summary itself. Nothing is
    //    sanitised here on purpose: byte identity is the whole point.
    // 2. A rebuilt equivalent: system prompt + full history, last user replaced by the
    //    instruction.
    // 3. Compact text: the fallback for callers with neither.
    const snapshot = Array.isArray(lastRequestMessages) ? lastRequestMessages : null;
    // A snapshot is only worth replaying while it still describes this conversation: /compact
    // can fire after the user deleted or edited a message, and replaying a stale array would
    // summarise history that no longer exists. A mismatch falls through to the rebuild below.
    const snapshotCurrent = !!snapshot && _snapshotIsCurrent(snapshot, fullHistory);
    const snapshotFits = !!(snapshot && snapshot.length >= headMessages.length + 1 && snapshotCurrent);
    // Why a replay was or was not used: 'none' (nothing to replay), 'stale' (the history moved
    // on since the snapshot was taken), 'short' (still current, but it covers less than the head
    // it would replace, so a rebuild carries more of the conversation).
    const snapshotState = !snapshot ? 'none' : (!snapshotCurrent ? 'stale' : (snapshotFits ? 'used' : 'short'));
    let requestMessages;
    let prefixSource = 'text';
    if (snapshotFits) {
        prefixSource = 'snapshot';
        // Send the WHOLE snapshot, not just the head. DeepSeek only serves a cache entry that
        // *fully matches* a persisted prefix unit, and the complete request the turn sent is
        // precisely such a unit (it is persisted at the end position of the user input).
        // Sending a shorter head matched no unit beyond the shared system prompt and tool set —
        // which is what the cache-hit numbers showed: a flat 12.5k hit at any history size.
        // The instruction's Scope section tells the model which stretch to condense, since the
        // snapshot carries the live tail as well.
        requestMessages = [
            ...snapshot,
            { role: 'user', content: instruction },
        ];
    } else if (Array.isArray(prefixMessages) && prefixMessages.length && Array.isArray(fullHistory) && fullHistory.length) {
        prefixSource = 'rebuilt';
        const hist = fullHistory.map((m) => {
            // Keep only API-facing fields: internal bookkeeping properties would either be
            // rejected or break the byte-identical prefix the cache keys on.
            const out = { role: m.role };
            if (m.content !== undefined) out.content = m.content;
            if (m.tool_calls) out.tool_calls = m.tool_calls;
            if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
            if (m.name) out.name = m.name;
            if (m.reasoning_content) out.reasoning_content = m.reasoning_content;
            return out;
        });
        let lastUser = -1;
        for (let i = hist.length - 1; i >= 0; i--) {
            if (hist[i].role === 'user') { lastUser = i; break; }
        }
        if (lastUser >= 0) hist[lastUser] = { role: 'user', content: instruction };
        else hist.push({ role: 'user', content: instruction });
        requestMessages = [...prefixMessages, ...hist];
    } else {
        const lines = [];
        for (const m of headMessages) {
            if (m.role === 'assistant' && m.tool_calls) {
                const names = m.tool_calls.map(tc => tc.function?.name || '?').join(', ');
                lines.push(`[assistant called: ${names}]`);
            }
            if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
                lines.push(`[assistant]: ${m.content.trim().slice(0, 400)}`);
            }
            if (m.role === 'tool') {
                const body = typeof m.content === 'string' ? m.content : '';
                lines.push(`[tool result]: ${body.slice(0, 300)}`);
            }
            if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
                lines.push(`[user]: ${m.content.trim().slice(0, 400)}`);
            }
        }

        // Budget the input: without it a large history means minutes of prefill (and a
        // bigger bill) for a 300-word answer. Keep the most recent entries, since they
        // carry the current state, and say how many were left out.
        const MAX_INPUT_CHARS = 60_000;
        const NOTICE_RESERVE = 48; // room for the "[N earlier entries omitted]" line
        let historyText = lines.join('\n');
        if (historyText.length > MAX_INPUT_CHARS) {
            const kept = [];
            let used = 0;
            let omitted = 0;
            for (let i = lines.length - 1; i >= 0; i--) {
                const cost = lines[i].length + 1;
                if (used + cost > MAX_INPUT_CHARS - NOTICE_RESERVE) { omitted = i + 1; break; }
                kept.push(lines[i]);
                used += cost;
            }
            historyText = (omitted ? `[${omitted} earlier entries omitted]\n` : '') + kept.reverse().join('\n');
        }
        if (!historyText.trim()) return null;
        requestMessages = [
            { role: 'system', content: 'You are a conversation summarizer. Be concise, but keep the result readable: short paragraphs or a bullet list, never a single run-on line.' },
            { role: 'user', content: instruction + '\n\n' + historyText },
        ];
    }

    try {
        const url = new URL(effectiveBaseUrl + '/chat/completions');
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        // One summarisation request. `extra` is appended to the trailing instruction, which a
        // retry uses to ask more firmly: the agent framing in the replayed history sometimes wins
        // over the instruction, and the model answers with a tool call and a sentence instead of
        // a checkpoint (measured: 75 chars, 0 sections, 1 tool call, accepted as the summary).
        const ask = async (extra, seq) => {
            const msgs = extra
                ? requestMessages.map((m, i) => (i === requestMessages.length - 1 && m.role === 'user'
                    ? { role: 'user', content: `${m.content}\n${extra}` }
                    : m))
                : requestMessages;

            // The effort level is taken from the caller and applied verbatim, so the request keeps
            // matching the turn's own fields — anything else costs the prefix and with it the
            // cache. Forcing `reasoning_effort: 'none'` was tried and cost exactly that: with
            // thinking off the API drops `reasoning_content` from the replayed history, so the
            // request stopped being a prefix of the turn's own (64 353 prompt tokens against its
            // 188 796 for the very same array) and the whole prefill was paid at full price.
            // Lowering it was measured on an identical snapshot and does not pay: `'low'` returned
            // 12 544 cached tokens where the default took 90 752 of 90 925 on the same array.
            const effort = reasoningEffort || null;
            const startedAt = Date.now();
            const resp = await fetch(url.toString(), {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model,
                    messages: msgs,
                    // Tools go out exactly as the turn sends them. The summariser should not call
                    // one, but every way of stopping it also changes the prompt and costs the
                    // cache — dropping the tools cut the cached prefix in half (127301 against
                    // 253470) and `tool_choice: 'none'` did the same (64115 against 115552). The
                    // request therefore goes out as the turn sends it, and the reply is checked.
                    ...(Array.isArray(tools) && tools.length
                        ? { tools, tool_choice: 'auto' }
                        : {}),
                    ...(effort ? { reasoning_effort: effort } : {}),
                    max_tokens: 32768,
                    stream: false,
                }),
                // Prefill on a cached prefix is fast, but a cold one on a large history is
                // not — 8s used to give up long before the answer.
                signal: AbortSignal.timeout(90_000),
            });
            if (!resp.ok) {
                // A silent null here cost a debugging round: surface what the API said.
                const body = await resp.text().catch(() => '');
                Logger.info('COMPACT_SUMMARY_FAIL', {
                    seq, status: resp.status, effort: effort || 'default', body: String(body).slice(0, 300),
                });
                return { text: '', sections: 0, toolCalls: 0, apiError: true };
            }
            const data = await resp.json();
            const msg = data?.choices?.[0]?.message;
            const usage = data?.usage || {};
            const text = (msg && msg.content && String(msg.content).trim()) || '';
            // Measurement for the cache experiment: cache_hit_tokens >> 0 means the prefix matched
            // the turn's request; near zero means it did not. The answer's shape is measured too,
            // because a summary that lost its sections is worthless however cheap it was.
            const sections = (text.match(/^## /gm) || []).length;
            const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls.length : 0;
            Logger.info('COMPACT_SUMMARY', {
                model,
                effort: effort || 'default',
                seq,
                prefix_source: prefixSource,
                snapshot_len: snapshot ? snapshot.length : 0,
                snapshot_state: snapshotState,
                head_len: headMessages.length,
                sent_msgs: requestMessages.length,
                prompt_tokens: usage.prompt_tokens,
                cache_hit_tokens: usage.prompt_cache_hit_tokens,
                completion_tokens: usage.completion_tokens,
                reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens,
                elapsed_ms: Date.now() - startedAt,
                chars: text.length,
                sections,
                has_text: !!text,
                tool_calls: toolCalls,
            });
            return { text, sections, toolCalls };
        };

        // A reply counts as a checkpoint only if it looks like one. The agent framing in the
        // replayed history can win over the instruction, and then the model answers with a tool
        // call and a sentence of work instead of the sections. Accepting that as the summary
        // replaces the history with a fragment, so it is retried once with a firmer instruction
        // and otherwise reported as no summary at all, which sends the caller to the fact list.
        const isCheckpoint = (r) => r.toolCalls === 0 && r.sections >= 4 && r.text.length >= 400;
        const seq1 = await ask('', 1);
        if (isCheckpoint(seq1)) return seq1.text;
        // An HTTP failure is not a bad answer: asking again only repeats the failed call.
        if (seq1.apiError) return null;
        Logger.info('COMPACT_SUMMARY_REJECTED', {
            seq: 1, chars: seq1.text.length, sections: seq1.sections, tool_calls: seq1.toolCalls,
            preview: seq1.text.slice(0, 200),
        });
        const seq2 = await ask('Answer with the checkpoint sections only. Do not call any tool.', 2);
        if (isCheckpoint(seq2)) return seq2.text;
        Logger.info('COMPACT_SUMMARY_REJECTED', {
            seq: 2, chars: seq2.text.length, sections: seq2.sections, tool_calls: seq2.toolCalls,
            preview: seq2.text.slice(0, 200),
        });
        return null;
    } catch (e) {
        Logger.info('COMPACT_SUMMARY_FAIL', { error: String((e && e.message) || e) });
        return null;
    }
}

// ─── Compact-summary helpers ───────────────────────────────────────────────

function _isCompactSummary(m) {
    return m.role === 'user' && typeof m.content === 'string' && m.content.includes('<compact-summary>');
}

// The body of a checkpoint with the <system-reminder> framing stripped, or null when the
// message is not one. Both the normal path and the emergency one read old checkpoints, and
// they have to agree on what counts as the body.
function _checkpointInner(content) {
    const raw = String(content || '');
    if (!raw.includes('<compact-summary>')) return null;
    const inner = raw.replace(
        /[\s\S]*?<compact-summary>([\s\S]*?)<\/compact-summary>[\s\S]*/,
        '$1',
    ).trim();
    return inner || null;
}

// A checkpoint is assembled by this same code, so an older one may already carry the
// "Prior compactions: ... This compaction:" wrapper plus the sections of every round before it.
// Unwrap it into the epochs it holds, oldest first, so nesting never survives a round.
function _priorEpochs(text) {
    const body = String(text || '').trim();
    if (!body) return [];
    const tailIdx = body.lastIndexOf('This compaction:');
    if (tailIdx < 0) return [body];
    const headPart = body.slice(0, tailIdx);
    const listIdx = headPart.indexOf('Prior compactions:');
    const older = listIdx >= 0
        ? headPart.slice(listIdx + 'Prior compactions:'.length).split(/\n+---\n+/).flatMap(_priorEpochs)
        : [];
    return older.concat([body.slice(tailIdx + 'This compaction:'.length).trim()]).filter(Boolean);
}

// Only a checkpoint this code wrote itself opens with the wrapper marker. A model that merely
// happens to use the phrase inside its own answer keeps its head: unwrapping that text would
// cut everything before the phrase, which is the whole checkpoint.
function _isLegacyWrapper(text) {
    const t = String(text || '').trim();
    return t.startsWith('Prior compactions:') || t.startsWith('This compaction:');
}

// One copy of each section across all epochs. They carry the same headings every round, so
// repeating them turned the checkpoint into a wall of identical headings whose bodies did
// differ; the bodies are kept under a single heading, oldest first. Headings the newest epoch
// introduced come first, then any the earlier rounds alone had. Epochs without headings at all
// (the fact fallback) are concatenated, deduplicated, as they are.
function _mergeEpochs(epochs) {
    const list = (Array.isArray(epochs) ? epochs : []).filter(e => String(e || '').trim());
    if (list.length === 0) return '';
    if (list.length === 1) return String(list[0]).trim();
    const headingsOf = (text) => {
        const found = [];
        for (const part of String(text).split(/^(?=## )/m)) {
            const m = /^## (.+)$/m.exec(part);
            if (m) found.push(m[1].trim());
        }
        return found;
    };
    // The newest epoch decides the order: it describes where the task stands now. Headings only
    // the earlier rounds had are appended after it, so nothing documented before is lost.
    const order = headingsOf(list[list.length - 1]);
    const bodies = new Map(order.map(h => [h, []]));
    const loose = [];
    // Bodies run oldest first: under one heading the reader sees how that subject evolved.
    for (const epoch of list) {
        for (const part of String(epoch).split(/^(?=## )/m)) {
            const headingMatch = /^## (.+)$/m.exec(part);
            if (!headingMatch) {
                const text = part.trim();
                if (text) loose.push(text);
                continue;
            }
            const heading = headingMatch[1].trim();
            const bodyText = part.slice(headingMatch[0].length).trim();
            if (!bodies.has(heading)) {
                bodies.set(heading, []);
                order.push(heading);
            }
            if (bodyText) bodies.get(heading).push(bodyText);
        }
    }
    const out = [];
    if (loose.length > 0) out.push([...new Set(loose)].join('\n\n'));
    for (const heading of order) {
        out.push(`## ${heading}\n${bodies.get(heading).join('\n\n')}`.trim());
    }
    return out.join('\n\n');
}

function _hasAttachment(m) {
    if (Array.isArray(m.content)) {
        return m.content.some(p => p && (p.type === 'file' || p.type === 'image_url'));
    }
    // Heuristic: long user messages likely contain attached file content.
    return typeof m.content === 'string' && m.content.length > 3000;
}

// ─── Auto-compaction ────────────────────────────────────────────────────────
// Strategy:
//   1. Try truncating oversized tool results first (non-destructive, no messages dropped).
//   2. If still over budget, drop the head portion of messages:
//      - Keep the most recent keepTail messages verbatim.
//      - Always keep the first user message (task anchor).
//      - Keep the most recent user message with file attachments (if any, and different).
//      - Accumulate prior compact-summaries rather than overwriting them.
//   3. Inject a structured <compact-summary> placeholder.
//   4. If apiConfig provided, attempt LLM summarisation; fall back to structured facts.
//
// Returns { messages, compacted, dropped, truncated }

/**
 * Auto-compact a message history when it approaches the budget.
 *
 * Pipeline (each step is conditional on the previous one still being over budget):
 *   0. dedup repeated file reads (lossless — collapses earlier copies)
 *   1. truncate long tool-result bodies
 *   2. head-drop with summary (optional LLM-backed via apiConfig)
 *   3. body-truncate fallback for single oversized messages
 *
 * @returns {{
 *   messages: Array,
 *   compacted: boolean,
 *   dropped: number,    // # of head messages dropped in step 2
 *   truncated: number,  // # of tool results whose bodies were shortened
 *   deduped: number,    // # of earlier duplicate read tool results collapsed
 * }}
 */
// keepTail deliberately has no default: it used to be 12, new call sites
// silently inherited it, and a 12-message tail once cut a live turn from 322
// messages down to 15 mid-task. Each caller now states how much recent history
// is expected to survive, next to its own budget.
//
// `actualTokens` is the prompt size the provider reported for `messages` (0 when
// no such fact exists yet). It calibrates the internal measurement against the
// real count: pass it whenever `budgetTokens` is expressed in provider units,
// and pass 0 whenever the budget itself came from the heuristic — scaling only
// one side would make budget and measurement disagree by the scale factor.
async function autoCompactIfNeeded(messages, budgetTokens, keepTail, apiConfig = null, actualTokens) {
    let working = messages;
    // PR #155 review: track dedup and truncation separately so the returned
    // `truncated` field keeps its original semantic ("tool results actually
    // shortened") and dedup numbers don't pollute it.
    let dedupCount = 0;
    let truncCount = 0;
    // Provider/model context for the modular token counter — issue #149.
    // apiConfig carries either { provider, model, apiKey, baseUrl } for the
    // full path (token counting + LLM summarisation), or { provider, model,
    // noSummary: true } for emergency paths that want provider-aware token
    // counting without firing a network summary request.
    const tokCtx = apiConfig
        ? { provider: apiConfig.provider, model: apiConfig.model }
        : undefined;
    // Memoise per `working` reference: every mutation re-assigns `working`,
    // which invalidates the cache automatically.
    let _measureRef = null;
    let _measureVal = 0;
    let _measureScale = 1;
    const measure = (msgs) => {
        if (msgs === _measureRef) return _measureVal;
        _measureVal = Math.round(estimateMessagesTokens(msgs, tokCtx) * _measureScale);
        _measureRef = msgs;
        return _measureVal;
    };
    // When the caller knows the real prompt size (the usage reported by the
    // last API call), scale the heuristic by that ratio. The estimator is
    // char-based and undercounts dense code by roughly 3x, which would
    // otherwise keep every threshold below the actual size.
    measure(working);
    _measureScale = (actualTokens > 0 && _measureVal > 0) ? actualTokens / _measureVal : 1;
    _measureVal = Math.round(_measureVal * _measureScale);

    // Step 0 (Issue #142 P1-3 / DeepSeek prefix-cache tuning):
    // dedup repeated file reads rewrites middle-of-history tool messages,
    // which fully invalidates the DeepSeek server-side KV prefix cache from
    // the first rewritten byte onward. Defer it to a near-overflow trigger
    // (95% of budget) so we only pay the cache-bust cost when truly
    // necessary — the cheaper head-drop and tail truncation usually free
    // enough tokens first without disturbing the byte-stable prefix.
    if (measure(working) > budgetTokens * 0.95) {
        const ded = dedupRepeatedReads(working);
        if (ded.replaced > 0) {
            working = ded.messages;
            dedupCount += ded.replaced;
        }
    }

    // Step 1: truncate long tool results to recover tokens without dropping messages.
    if (measure(working) > budgetTokens) {
        const res = truncateLongToolResults(working);
        if (res.truncCount > 0) {
            working = res.messages;
            truncCount += res.truncCount;
        }
    }

    if (measure(working) <= budgetTokens) {
        const anyChange = (dedupCount + truncCount) > 0;
        return anyChange
            ? { messages: working, compacted: true,  dropped: 0, truncated: truncCount, deduped: dedupCount }
            : { messages: working, compacted: false, dropped: 0, truncated: 0,          deduped: 0 };
    }

    // Step 2: head-drop.
    // (Issue #142 P0-1) When the message array is too short to head-drop but we
    // are still over budget, fall through to a body-truncation pass below so a
    // single oversized message (e.g. a 100KB read_file or huge first user prompt)
    // can still be brought back under budget.
    if (working.length <= keepTail + 2) {
        const fitted = _bodyTruncateUntilFits(working, budgetTokens, tokCtx, _measureScale);
        if (fitted.changed) {
            return { messages: fitted.messages, compacted: true, dropped: 0, truncated: truncCount + fitted.touched, bodiesTruncated: fitted.touched, deduped: dedupCount };
        }
        return { messages: working, compacted: (dedupCount + truncCount) > 0, dropped: 0, truncated: truncCount, deduped: dedupCount };
    }

    // Walk the split point backwards past any leading tool messages so the tail
    // never starts in the middle of a tool_calls group.  The API requires that
    // all tool result messages immediately follow their assistant{tool_calls}
    // message with no other roles interleaved between them.
    let splitIdx = working.length - keepTail;
    while (splitIdx > 0 && working[splitIdx].role === 'tool') splitIdx--;
    if (splitIdx <= 0) {
        return { messages: working, compacted: (dedupCount + truncCount) > 0, dropped: 0, truncated: truncCount, deduped: dedupCount };
    }

    const tail = working.slice(splitIdx);
    const head = working.slice(0, splitIdx);

    // (a) First non-summary user message — anchors the original task.
    const firstUserIdx = head.findIndex(m => m.role === 'user' && !_isCompactSummary(m));
    const firstUser = firstUserIdx >= 0 ? head[firstUserIdx] : null;

    // (b) Most recent user message with file attachments, if different from firstUser.
    let lastAttachUser = null;
    for (let i = head.length - 1; i >= 0; i--) {
        const m = head[i];
        if (m === firstUser) break;
        if (m.role === 'user' && !_isCompactSummary(m) && _hasAttachment(m)) {
            lastAttachUser = m;
            break;
        }
    }

    // (c) Most recent real user message — the current intent. Without it a
    // compaction that fires mid-turn can drop the very message the model is
    // answering; with keepTail 12 that is exactly what happened.
    let lastUser = null;
    for (let i = head.length - 1; i >= 0; i--) {
        const m = head[i];
        if (m === firstUser || m === lastAttachUser) continue;
        if (m.role !== 'user' || _isCompactSummary(m)) continue;
        // Plan / verify nudges and the like are internal reminders, not intent.
        if (String(m.content || '').trimStart().startsWith('<system-reminder>')) continue;
        lastUser = m;
        break;
    }

    // (d) Accumulate text from any prior compact-summaries so history is never lost.
    const priorSummaryParts = [];
    for (const m of head) {
        if (!_isCompactSummary(m)) continue;
        const inner = _checkpointInner(m.content);
        if (inner) priorSummaryParts.push(inner);
    }

    const kept = new Set([firstUser, lastAttachUser, lastUser].filter(Boolean));
    const toDropMsgs = head.filter(m => !kept.has(m) && !_isCompactSummary(m));
    const dropped = head.length - kept.size - head.filter(_isCompactSummary).length;

    // Step 3: produce summary content — LLM first, structured fallback.
    let summaryBody = '';
    let summarySource = 'none';
    // Ask the model only when something is actually being dropped: the summary is about the
    // discarded messages. What is handed to it, however, is the whole head — anchors and all —
    // because only that sequence matches the request the turn made, and the prompt cache keys
    // on exactly that prefix.
    if (apiConfig && !apiConfig.noSummary && toDropMsgs.length > 0) {
        const llmText = await summariseHead(head, apiConfig, messages);
        if (llmText) { summaryBody = llmText; summarySource = 'llm'; }
    }
    if (!summaryBody) {
        summarySource = 'facts';
        const factLines = extractHeadFacts(toDropMsgs);
        summaryBody = `${dropped} messages dropped`;
        if (dedupCount > 0) summaryBody += `, ${dedupCount} repeated reads collapsed`;
        if (truncCount > 0) summaryBody += `, ${truncCount} tool results truncated`;
        // The panel renders this as Markdown, where a single newline collapses into a
        // space. Hence the blank line and the "- " markers: without them the fact list
        // arrives as one unreadable run-on line.
        if (factLines.length > 0) summaryBody += `.\n\nKey events:\n\n${factLines.map((l) => `- ${l}`).join('\n')}`;
    }

    // Fold the earlier checkpoints in, one flat epoch each. They used to be prepended whole --
    // every round appending a full copy of the previous checkpoint, wrapper and all -- so the
    // third round carried three copies of each section. The model gets the history without the
    // nesting, and since it may imitate that wrapper, its own answer is unwrapped the same way.
    const ownEpoch = summaryBody
        ? ((_isLegacyWrapper(summaryBody) ? _priorEpochs(summaryBody).pop() : summaryBody) || summaryBody)
        : '';
    const epochs = priorSummaryParts.flatMap(_priorEpochs);
    if (ownEpoch) epochs.push(ownEpoch);
    summaryBody = _mergeEpochs(epochs);

    const summary = {
        role: 'user',
        content:
            `<system-reminder>\n` +
            `This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. ` +
            `Treat the captured context as established background and build on it without restating it. ` +
            `Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n` +
            `<compact-summary>\n${summaryBody}\n</compact-summary>\n` +
            `Refer to the user's most recent messages for current intent.\n</system-reminder>`,
    };

    let out = [];
    if (firstUser) out.push(firstUser);
    if (lastAttachUser) out.push(lastAttachUser);
    if (lastUser) out.push(lastUser);
    out.push(summary);
    out.push(...tail);

    // Issue #142 P0-1: if STILL over budget after head-drop (typical when
    // firstUser or the tail contains a huge attachment / read_file payload),
    // perform body-truncation on the kept messages so we never return with
    // tokens > budget when there is content we could shrink.
    // Counted separately from `truncated` (which also covers tool results): this is how many
    // kept messages had their body rewritten, the number that explains a mangled history.
    let bodiesTruncated = 0;
    if (measure(out) > budgetTokens) {
        const fitted = _bodyTruncateUntilFits(out, budgetTokens, tokCtx, _measureScale);
        if (fitted.changed) {
            out = fitted.messages;
            truncCount += fitted.touched;
            bodiesTruncated = fitted.touched;
        }
    }
    return { messages: out, compacted: true, dropped, truncated: truncCount, bodiesTruncated, deduped: dedupCount, summarySource };
}

// ─── Body-truncate fallback ────────────────────────────────────────────────
// Tighten head/tail keep limits in fixed tiers until the total fits under
// `budgetTokens`, or the last tier is reached. Used by autoCompactIfNeeded when
// head-dropping cannot reduce the working set further (a single oversized
// message, or a first-user anchor that exceeds the budget on its own).
function _bodyTruncateUntilFits(messages, budgetTokens, ctx, scale = 1) {
    // The ladder stops at 300/120 on purpose. Its first tier cuts a long body, and every tier
    // after that cuts the same body deeper; past the third step a tool result is a couple of
    // lines of its own header and closing brace, and the model can no longer tell what the
    // command printed. The emergency path keeps its own last resort (nuclearCompact, 800/200).
    const tiers = [
        { head: 1200, tail: 400, threshold: 2000 },
        { head: 600,  tail: 200, threshold: 1200 },
        { head: 300,  tail: 120, threshold: 600  },
    ];
    let cur = messages;
    let changed = false;
    let count = 0;
    const touched = new Set();
    for (const tier of tiers) {
        // Same units as the caller's budget: when it was taken from the provider's own count,
        // the raw heuristic reads 2-3x low and would declare the history small enough to keep.
        if (estimateMessagesTokens(cur, ctx) * scale <= budgetTokens) break;
        const next = cur.map((m, i) => {
            if (!m || typeof m.role !== 'string') return m;
            // The model's own turns and the running checkpoint are never rewritten: a truncated
            // assistant message reads as garbled text in the next request's context (and the
            // model then imitates those fragments), while a truncated summary loses the very
            // context it exists to carry.
            if (m.role === 'assistant' || _isCompactSummary(m)) return m;
            // User turns are the dialogue itself — only oversized payloads pasted into them are
            // worth shrinking, and never down to a couple of lines, so the 300/120 tier skips
            // them. Oversized anchors stay reachable through the two wider tiers.
            if (m.role === 'user' && tier.head < 600) return m;
            const truncated = _truncateAnyLongMessage(m, tier.head, tier.tail, tier.threshold);
            // One body can be cut on several tiers, so the useful number is how many messages
            // were touched at all: `count` sums the operations and used to read 3x the history.
            if (truncated !== m) { count++; touched.add(i); }
            return truncated;
        });
        if (next.some((m, i) => m !== cur[i])) {
            cur = next;
            changed = true;
        }
    }
    return { messages: cur, changed, count, touched: touched.size };
}

// ─── Nuclear compaction ────────────────────────────────────────────────────
// Last-resort path used when the emergency keepTail ladder still leaves us
// over the model's hard context limit.  Drops EVERYTHING except:
//   - The first user message (heavily truncated to 800 chars)
//   - An aggregated <compact-summary> stub
//   - The most recent user message (the current intent)
// Any in-flight assistant{tool_calls} / tool result groups are discarded —
// the cost of nuclear is losing the current turn's tool history, but the
// session is preserved and the user can continue talking.
//
// Returns the rebuilt messages array (sync, no API call).
function nuclearCompact(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;

    // Find first non-summary user message — task anchor.
    let firstUser = null;
    for (const m of messages) {
        if (m.role === 'user' && !_isCompactSummary(m)) { firstUser = m; break; }
    }

    // Find most recent non-summary user message — current intent.
    let lastUser = null;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'user' && !_isCompactSummary(m)) { lastUser = m; break; }
    }

    // Aggregate any existing compact-summary text so prior compactions are not
    // silently erased.
    const priorSummaryParts = [];
    for (const m of messages) {
        if (!_isCompactSummary(m)) continue;
        const inner = _checkpointInner(m.content);
        if (inner) priorSummaryParts.push(inner);
    }

    // Truncate firstUser content aggressively (head 800 / tail 200) so that
    // even a 100KB first attachment cannot lock the session.
    let truncatedFirstUser = firstUser;
    if (firstUser) {
        truncatedFirstUser = _truncateAnyLongMessage(firstUser, 800, 200, 1200);
    }

    // Same folding rule as autoCompactIfNeeded: prior checkpoints become flat epochs merged
    // into one set of sections, so an emergency compaction cannot reintroduce the nesting the
    // normal path no longer produces.
    const priorEpochs = _mergeEpochs(priorSummaryParts.flatMap(_priorEpochs));
    const summaryBody = (priorEpochs ? `${priorEpochs}\n\n` : '')
        + `Emergency nuclear compaction applied — interim history discarded to fit the context window. `
        + `Only the original task and the user's most recent message are retained.`;

    const summary = {
        role: 'user',
        content:
            `<system-reminder>\n<compact-summary>\n${summaryBody}\n</compact-summary>\n` +
            `Refer to the user's most recent message for current intent.\n</system-reminder>`,
    };

    const out = [];
    if (truncatedFirstUser) out.push(truncatedFirstUser);
    out.push(summary);
    if (lastUser && lastUser !== firstUser) {
        // Also truncate lastUser body if it is itself huge.
        out.push(_truncateAnyLongMessage(lastUser, 1200, 400, 2000));
    }
    return out;
}

// ─── ToolArgsStreamer ───────────────────────────────────────────────────────
// Incrementally extracts `path` and the body of `content` (or `new_string` /
// `new_content` / `text`) fields from a tool-call arguments JSON string that
// arrives in chunks. Lets us surface "Editing foo.py" the instant the path
// field is finished streaming and forward the file body as it streams —
// mirroring GitHub Copilot's live-edit preview.

class ToolArgsStreamer {
    constructor() {
        this.acc = '';
        this.pathEmitted = false;
        this.path = '';
        this.inContent = false;
        this.contentEnded = false;
        this.contentReadPos = 0;
        this.escapePending = false;
    }

    feed(chunk) {
        this.acc += chunk;
        const out = { newPath: null, contentDelta: '' };

        if (!this.pathEmitted) {
            const m = this.acc.match(/"(?:path|file|file_path|filename)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
            if (m) {
                let p;
                try { p = JSON.parse('"' + m[1] + '"'); } catch { p = m[1]; }
                this.pathEmitted = true;
                this.path = p;
                out.newPath = p;
            }
        }

        if (!this.inContent && !this.contentEnded) {
            const sm = this.acc.match(/"(?:content|new_string|new_content|text)"\s*:\s*"/);
            if (sm) {
                this.inContent = true;
                this.contentReadPos = sm.index + sm[0].length;
            }
        }

        if (this.inContent && !this.contentEnded) {
            let i = this.contentReadPos;
            let buf = '';
            const len = this.acc.length;
            while (i < len) {
                if (this.escapePending) {
                    const c = this.acc[i];
                    let resolved = c;
                    if      (c === 'n') resolved = '\n';
                    else if (c === 't') resolved = '\t';
                    else if (c === 'r') resolved = '\r';
                    else if (c === '"') resolved = '"';
                    else if (c === '\\') resolved = '\\';
                    else if (c === '/') resolved = '/';
                    else if (c === 'b') resolved = '\b';
                    else if (c === 'f') resolved = '\f';
                    else if (c === 'u') {
                        if (i + 4 >= len) break;
                        const hex = this.acc.slice(i + 1, i + 5);
                        const code = parseInt(hex, 16);
                        resolved = Number.isNaN(code) ? '' : String.fromCharCode(code);
                        i += 4;
                    }
                    buf += resolved;
                    this.escapePending = false;
                    i++;
                    continue;
                }
                const c = this.acc[i];
                if (c === '\\') {
                    if (i + 1 >= len) break;
                    this.escapePending = true;
                    i++;
                    continue;
                }
                if (c === '"') { this.contentEnded = true; i++; break; }
                buf += c;
                i++;
            }
            this.contentReadPos = i;
            out.contentDelta = buf;
        }

        return out;
    }
}

module.exports = {
    estimateTokens, estimateMessagesTokens,
    autoCompactIfNeeded, summariseHead, nuclearCompact, dedupRepeatedReads,
    ToolArgsStreamer,
};
