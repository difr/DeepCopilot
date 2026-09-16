// SessionStore: persistence layer for all chat sessions.
// Owns sessionId (current foreground session), CRUD via VS Code globalState,
// and the auto-naming heuristic.
//
// Dependencies: vscode, strings. Never imports provider or agent-loop.
'use strict';

const vscode = require('vscode');
const { randomBytes } = require('crypto');
const { str } = require('../utils/settings');
const { t, tf } = require('../utils/strings');
const { Logger } = require('../logger');
const { readCompactPolicy } = require('./compact-policy');
const { smoothScale, clampScale } = require('./token-scale');

// A compact summary is a user-role message carrying this marker (see
// `_isCompactSummary` in compact.js). The check is duplicated here on purpose:
// requiring compact.js would drag the API client into the store, and this file
// only needs the marker, not the machinery.
const COMPACT_SUMMARY_MARKER = '<compact-summary>';

function _isSummaryNode(m) {
    return m && m.role === 'user' && typeof m.content === 'string'
        && m.content.includes(COMPACT_SUMMARY_MARKER);
}

function _isInternalReminder(m) {
    return m && typeof m.content === 'string'
        && m.content.trimStart().startsWith('<system-reminder>');
}

// How many real user prompts survive in an api tail. Summaries and internal
// reminders are user-role messages too, and counting them would leave the panel
// longer than the context it is supposed to mirror.
function _countUserPrompts(msgs) {
    return msgs.filter(m => m.role === 'user' && !_isSummaryNode(m) && !_isInternalReminder(m)).length;
}

// Keep as many panel turns as the api tail still carries prompts, so what the
// user reads and what the model is sent cannot drift apart.
function _trimPanel(panel, keptPrompts) {
    if (!Array.isArray(panel)) return panel;
    if (keptPrompts <= 0) return panel.slice(-2);
    let seen = 0;
    for (let i = panel.length - 1; i >= 0; i--) {
        if (panel[i].role !== 'user') continue;
        if (++seen === keptPrompts) return panel.slice(i);
    }
    return panel; // the panel holds fewer prompts than the tail: nothing to cut
}

// Body of a compact summary: what the model reads back on the next turn.
function _summaryText(m) {
    const inner = String(m.content || '').match(/<compact-summary>([\s\S]*?)<\/compact-summary>/);
    return inner ? inner[1].trim() : '';
}

// Panel entry that stands in for a compaction: the fact (how many turns went
// into it) plus the summary body, collapsed in the webview.
function _summaryCard(text, compacted) {
    return { role: 'summary', text: text || '', compacted: Math.max(0, compacted | 0) };
}

// Auto-generated session titles are capped by characters. The model names the
// session in the language of the conversation, so the cap has to fit Cyrillic
// and Latin words too — not just the ~10 CJK glyphs the old prompt asked for.
const TITLE_MAX_CHARS = 40;

// ─── Orphan tool_calls sanitizer ───────────────────────────────────────────
// Removes ANY incomplete assistant{tool_calls} group from a message array,
// regardless of position (head / middle / tail).
//
// DeepSeek/OpenAI Chat Completions require every `assistant` message that
// declares `tool_calls` to be IMMEDIATELY followed by a contiguous block of
// `tool` messages — one per declared `tool_call_id`. If any id is missing
// (or the block is interrupted by a non-tool message), the API returns
// HTTP 400 "insufficient tool messages following tool_calls message".
//
// Earlier versions only fixed orphan groups at the very tail (issue #70).
// Issue #145 showed that history compaction, truncation, or a mid-turn crash
// can also produce orphans in the MIDDLE of the array — those slipped past
// the old tail-only check and corrupted every subsequent turn.
//
// Algorithm (single forward pass):
//   - Skip any leading orphan `tool` messages.
//   - On each `assistant` with non-empty `tool_calls`:
//       1. Collect the expected `tool_call_id` set.
//       2. Walk forward consuming the contiguous `tool` block, recording the
//          ids actually present.
//       3. If every expected id is present → keep the whole group.
//          Otherwise → drop the assistant message AND the (partial) tool
//          block that followed it. The next iteration resumes at the first
//          non-tool message after the dropped block.
//   - All other messages pass through unchanged.
//
// Returns a NEW array. Original input is never mutated.
function _dropOrphanToolCallGroups(msgs) {
    if (!Array.isArray(msgs) || msgs.length === 0) return msgs;
    const out = [];
    let i = 0;
    // Skip leading orphan tool messages.
    while (i < msgs.length && msgs[i].role === 'tool') i++;
    while (i < msgs.length) {
        const m = msgs[i];
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
            const expectedIds = m.tool_calls.map(tc => tc && tc.id).filter(Boolean);
            const expectedSet = new Set(expectedIds);
            // Walk forward through the contiguous tool block.  We accept ONLY
            // tool messages whose tool_call_id belongs to expectedIds; extras
            // (unknown id, duplicate id, missing id) are dropped even when the
            // group is otherwise complete — leaving them would re-introduce
            // the exact HTTP 400 this sanitizer is meant to prevent.
            let j = i + 1;
            const seenIds = new Set();
            const acceptedToolBlock = [];
            while (j < msgs.length && msgs[j].role === 'tool') {
                const tid = msgs[j].tool_call_id;
                if (tid && expectedSet.has(tid) && !seenIds.has(tid)) {
                    seenIds.add(tid);
                    acceptedToolBlock.push(msgs[j]);
                }
                // tool messages with missing / unknown / duplicate ids are
                // silently dropped from the block.
                j++;
            }
            const complete = expectedIds.length > 0 && expectedIds.every(id => seenIds.has(id));
            if (complete) {
                out.push(m);
                for (const t of acceptedToolBlock) out.push(t);
            }
            // If incomplete, drop both the assistant and its partial tool block.
            i = j;
            continue;
        }
        // Orphan `tool` message mid-stream (assistant{tool_calls} above was
        // already dropped, or it never existed). Skip it — keeping it would
        // re-introduce the same HTTP 400.
        if (m.role === 'tool') { i++; continue; }
        out.push(m);
        i++;
    }
    return out;
}

class SessionStore {
    /**
     * @param {vscode.Memento}  globalState
     * @param {{
     *   getCurrentWs : () => string,
     *   post         : (msg: object) => void,
     *   getBusy      : (id: string) => boolean,
     *   onDeleteRun  : (id: string) => void,
     * }} opts
     */
    constructor(globalState, { getCurrentWs, post, getBusy, onDeleteRun }) {
        this._gs         = globalState;
        this._getCurrentWs = getCurrentWs;  // () => workspace root path
        this._post       = post;            // (msg) => void  (direct webview send)
        this._getBusy    = getBusy;         // (id) => bool   (is that session's run busy?)
        this._onDeleteRun = onDeleteRun;    // (id) => void   (abort + remove from _runs)
        this.sessionId   = null;            // currently displayed session id (null = empty view)

        // Issue #169: archive semantics changed from "soft-hide + export" to
        // "pure export". Sessions that were previously hidden by the old
        // archive action are stuck invisible in globalState. Run a one-shot
        // idempotent migration that flips every `archived: true` back to
        // `false` so those records reappear in the sidebar after upgrade.
        // Guarded by a globalState boolean so we only do this once per user.
        // Fire-and-forget: the migration runs asynchronously and triggers
        // postList() itself once it finishes, so the sidebar refreshes as
        // soon as the migrated data is persisted (not necessarily on the
        // very next tick).
        this._migrateArchivedFlagIfNeeded();
    }

    /**
     * One-time migration for issue #169. Idempotent: subsequent runs no-op
     * because the `archiveSemanticsV2Migrated` flag is set on first success.
     * Errors are swallowed (logged via Logger) — failure here must not
     * block extension activation; the next launch will retry automatically
     * because the flag was never written.
     */
    async _migrateArchivedFlagIfNeeded() {
        try {
            if (this._gs.get('deepseekAgent.archiveSemanticsV2Migrated', false)) return;
            const list = this.all();
            let touched = false;
            for (const s of list) {
                if (s.archived) { s.archived = false; touched = true; }
            }
            if (touched) await this.set(list);
            await this._gs.update('deepseekAgent.archiveSemanticsV2Migrated', true);
            if (touched) this.postList();
        } catch (err) {
            // Non-fatal: next launch will retry. Route through Logger so the
            // diagnostic respects deepseekAgent.enableDebugLog and lands in
            // the "Deep Copilot Debug" output channel/log file.
            Logger.info('ARCHIVE_V2_MIGRATION_FAILED', {
                message: (err && err.message) || String(err),
                stack:   (err && err.stack)   || undefined,
            });
        }
    }

    // ─── Raw storage ────────────────────────────────────────────────────────

    all() {
        return this._gs.get('deepseekAgent.sessions', []);
    }

    async set(list) {
        list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        if (list.length > 100) list = list.slice(0, 100);
        await this._gs.update('deepseekAgent.sessions', list);
    }

    // ─── Session list broadcast ─────────────────────────────────────────────

    postList() {
        this._post({
            type: 'sessions',
            currentWs: this._getCurrentWs(),
            items: this.all().filter(s => !s.archived).map(s => ({
                id: s.id, title: s.title, preview: s.preview, msgCount: s.msgCount,
                model: s.model, mode: s.mode, ws: s.ws || '',
                createdAt: s.createdAt, updatedAt: s.updatedAt,
                busy: this._getBusy(s.id),
                pinned: !!s.pinned, unread: !!s.unread,
            })),
            activeId: this.sessionId,
        });
    }

    // ─── Session lifecycle ──────────────────────────────────────────────────

    /** Ensure a session exists and return its id. Creates one if needed. */
    async ensure(initialUserText) {
        if (this.sessionId) return this.sessionId;
        const id = 's_' + Date.now().toString(36) + '_' + randomBytes(2).toString('hex');
        const list = this.all();
        list.unshift({
            id,
            title: (initialUserText || t('sessionUntitled')).slice(0, 15),
            createdAt: Date.now(), updatedAt: Date.now(),
            ws: this._getCurrentWs(),
            messages: [], preview: '', msgCount: 0,
        });
        this.sessionId = id;
        await this.set(list);
        this.postList();
        return id;
    }

    /** Return persisted API-format messages for cross-turn context restore. */
    loadApiMessages(sid) {
        const s = this.all().find(x => x.id === sid);
        if (!s || !Array.isArray(s.apiMessages)) return [];
        // Self-heal legacy sessions: drop ANY orphan `assistant{tool_calls}`
        // group (head, middle, or tail) plus any orphan `tool` messages.
        // See issues #70 and #145 — a mid-array orphan was the missing case
        // that the old tail-only sanitizer could not repair, causing every
        // subsequent API call on that session to fail with HTTP 400.
        return _dropOrphanToolCallGroups(s.apiMessages);
    }

    /** Latest real prompt size the provider reported for this session. */
    notePromptTokens(sid, n, estTokens) {
        const s = this.all().find(x => x.id === sid);
        if (!s) return;
        // 0 clears both: after a compaction the recorded sizes describe a prompt
        // that no longer exists, and /context must not quote them.
        s.lastPromptTokens = Math.max(0, Number(n) || 0);
        // The heuristic of the same array. Kept so a reloaded window can still
        // price the next turn's growth in provider units instead of rescaling
        // from 1 — which is what put a tilde and a ~2x-low number in the ring
        // on the first iteration after a restart.
        s.lastEstTokens = Math.max(0, Number(estTokens) || 0);
        // Smoothed provider/heuristic ratio, so the ring, the popup and /context
        // all price their estimates in provider units instead of each deriving
        // its own factor. Deliberately survives the 0/0 reset above: the
        // calibration belongs to the content, not to the current history.
        const raw = (s.lastPromptTokens > 0 && s.lastEstTokens > 0)
            ? s.lastPromptTokens / s.lastEstTokens
            : 0;
        if (raw > 0) s.ctxEstScale = smoothScale(s.ctxEstScale, raw);
    }

    /**
     * Smoothed provider/heuristic factor for a session: the last reported prompt
     * over the heuristic of the same array. Falls back to the raw ratio, then to
     * 1. Callers that price estimates in provider units (the footer ring, the
     * popup, /context, the agent loop's expectations) all read it from here.
     */
    estScale(sid) {
        const s = this.all().find(x => x.id === sid);
        if (!s) return 1;
        const smoothed = clampScale(s.ctxEstScale);
        if (smoothed > 0) return smoothed;
        const fact = Number(s.lastPromptTokens) || 0;
        const est  = Number(s.lastEstTokens) || 0;
        return (fact > 0 && est > 0) ? (clampScale(fact / est) || 1) : 1;
    }

    /**
     * Append one completed turn to a session record.
     * @param {string}   sid
     * @param {string}   userText
     * @param {string}   asstText
     * @param {string}   thoughts
     * @param {object}   usage        — { prompt_tokens, completion_tokens, cost_cny, … }
     * @param {object[]} apiMessages  — full API-format history to persist
     */
    async append(sid, userText, asstText, thoughts, usage, apiMessages) {
        if (!sid) return;
        // Issue #142 P3-1: allow apiMessages-only updates (used by the
        // /compact command which persists a compacted history without
        // adding a new user/assistant turn).
        if (!userText && !asstText && apiMessages === undefined) return;
        const list = this.all();
        let s = list.find(x => x.id === sid);
        if (!s) {
            s = {
                id: sid,
                title: (userText || t('sessionUntitled')).slice(0, 15),
                createdAt: Date.now(), updatedAt: Date.now(),
                ws: this._getCurrentWs(), messages: [],
            };
            list.unshift(s);
        } else if (!s.ws) {
            s.ws = this._getCurrentWs();
        }

        const cfg = vscode.workspace.getConfiguration('deepseekAgent');
        const providers = require('../providers');
        s.model = providers.resolveModel(str(cfg.get('provider')) || 'deepseek', str(cfg.get('defaultModel')));
        s.mode  = str(cfg.get('approvalMode')) || 'manual';

        // Same policy the agent loop runs on: the persisted history has to be cut
        // at the same two points, otherwise a reload hands the loop a history
        // that immediately compacts again.
        const policy = readCompactPolicy(
            cfg,
            providers.getModel(str(cfg.get('provider')) || 'deepseek', s.model) || {},
            Logger,
        );
        const MAX_HISTORY  = policy.maxMessages; // was a hardcoded 400
        const KEEP_HISTORY = policy.keepTail;    // was a hardcoded 200

        if (userText) s.messages.push({ role: 'user', text: userText });
        if (asstText || thoughts) s.messages.push({ role: 'assistant', text: asstText || '', thoughts: thoughts || '' });

        if (apiMessages !== undefined) {
            // reasoning_content is intentionally kept here.  Stripping it at
            // persist time caused HTTP 400 ("reasoning_content must be passed
            // back") when a session was reloaded after a VS Code restart —
            // the in-memory run was gone, messages came back from storage
            // without the field, and DeepSeek rejected the next turn.
            // sanitizeMessages() in adapter.js already handles per-model
            // stripping at API-call time, so we don't need to do it here.
            const messagesToPersist = Array.isArray(apiMessages) ? [...apiMessages] : [];
            // Drop in steps instead of sliding every turn: cutting 400 back to
            // 200 leaves the head of the history byte-stable between drops,
            // which is what the server-side prefix cache matches on. A sliding
            // window rewrote the first message on every turn, so each new turn
            // paid a full miss. Never start with an orphan `tool` message —
            // DeepSeek requires every tool message to follow its
            // assistant{tool_calls}. See issue #70.
            let sanitized = messagesToPersist;
            if (messagesToPersist.length > MAX_HISTORY) {
                let startIdx = messagesToPersist.length - KEEP_HISTORY;
                while (startIdx < messagesToPersist.length && messagesToPersist[startIdx].role === 'tool') {
                    startIdx++;
                }
                sanitized = messagesToPersist.slice(startIdx);
            }
            // The panel is rebuilt from the api tail whenever that tail carries a
            // summary: a compaction drops the history far below MAX_HISTORY, so
            // waiting for the count limit would leave the card out until some
            // later overflow.
            //
            // A turn costs ~2 panel entries against ~10 api messages, so one
            // shared limit let the visible history run an order of magnitude
            // longer than the context the model gets. A summary is what the model
            // carries forward, so it becomes a panel entry of its own and every
            // turn older than it goes: those messages are already folded in.
            // A summary node is what the model carries forward, so the panel is
            // cut from it whether or not its body survived. The marker alone is
            // the signal; a card without text still beats dropping turns with no
            // trace at all.
            const lastSummaryIdx = sanitized.findLastIndex(_isSummaryNode);
            const hasSummary = lastSummaryIdx >= 0;
            const summaryText = hasSummary ? _summaryText(sanitized[lastSummaryIdx]) : '';
            const overflow = messagesToPersist.length > MAX_HISTORY;
            if (hasSummary || overflow) {
                const keptPrompts = hasSummary
                    ? _countUserPrompts(sanitized.slice(lastSummaryIdx + 1))
                    : _countUserPrompts(sanitized);
                const panelBefore = s.messages.length;
                // With a summary in play, nothing above it survives in the api
                // tail either. Keeping the slice(-2) safety net here would put
                // turns back in the panel that the model no longer has.
                const panelTail = (hasSummary && keptPrompts === 0)
                    ? []
                    : _trimPanel(s.messages, keptPrompts).filter(m => m.role !== 'summary');
                s.messages = [
                    ...(hasSummary ? [_summaryCard(summaryText, panelBefore - panelTail.length)] : []),
                    ...panelTail,
                ];
                // A session with no run in flight can be redrawn right away.
                // During a turn the webview owns the transcript and rebuilding it
                // would kill the live stream, so the card waits for the next
                // session load there.
                const redrawn = typeof this._getBusy === 'function' && !this._getBusy(sid);
                if (redrawn) {
                    this._post({ type: 'sessionLoaded', id: sid, messages: s.messages, busy: false, totals: s.totals || null });
                }
                // Names say which array each number belongs to: the api history is
                // cut by the count limit, while the panel follows the summary. A
                // line reading "dropped: 0" used to look like a failed trim when it
                // was in fact a panel rebuild.
                Logger.info('PERSIST_TRIM', {
                    sid,
                    reason: hasSummary ? (overflow ? 'summary+overflow' : 'summary') : 'overflow',
                    api_before : messagesToPersist.length,
                    api_after  : sanitized.length,
                    api_dropped: messagesToPersist.length - sanitized.length,
                    panel_before : panelBefore,
                    panel_after  : s.messages.length,
                    panel_dropped: panelBefore - s.messages.length,
                    kept_prompts: keptPrompts,
                    keep_tail   : KEEP_HISTORY,
                    summary: hasSummary,
                    redrawn,
                });
            }
            // Drop ANY orphan assistant{tool_calls} group (head/middle/tail)
            // so a mid-turn interruption or a slice-induced split never
            // persists a broken sequence. See issue #145.
            sanitized = _dropOrphanToolCallGroups(sanitized);

            // DeepSeek prefix-cache tuning: removed the eager
            // pre-compaction-on-persist branch (formerly compressed the
            // history to 40% of the model's context window every time the
            // turn was saved). That pass rewrote the head of the history on
            // session save and reload, which broke the byte-stable prefix
            // the server-side KV cache depends on — every "reopen the same
            // session" then paid a full prefix-cache miss on the next turn.
            //
            // Compaction now fires lazily inside the agent loop, either when the
            // expected prompt size (reported fact plus growth, in provider
            // units) exceeds the configured budget, or when the history passes
            // the message cap. On reload, agent-loop.js still defends against
            // an oversized history via the same path, so we don't need to do
            // anything proactively here.

            s.apiMessages = sanitized;
        }

        const last = s.messages[s.messages.length - 1];
        s.preview   = (last && last.text || '').replace(/\s+/g, ' ').slice(0, 80);
        s.msgCount  = s.messages.length;
        s.updatedAt = Date.now();

        if (usage && (usage.prompt_tokens || usage.completion_tokens)) {
            s.totals = s.totals || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_cny: 0, cache_hit_tokens: 0, turns: 0 };
            s.totals.prompt_tokens     += Number(usage.prompt_tokens     || 0);
            s.totals.completion_tokens += Number(usage.completion_tokens || 0);
            s.totals.total_tokens      += Number(usage.total_tokens      || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0));
            s.totals.cost_cny          += Number(usage.cost_cny          || 0);
            s.totals.cache_hit_tokens  += Number(usage.prompt_cache_hit_tokens || 0);
            s.totals.turns             += 1;
            // The footer shows the turn count, and the webview cannot count
            // turns itself: one turn emits several usage events, and only the
            // last one looks like a turn boundary. Stream the running totals,
            // for the active session only.
            if (sid === this.sessionId) this._post({ type: 'totals', totals: s.totals });
        }

        await this.set(list);
        this.postList();
    }

    // ─── Session commands (webview → extension) ─────────────────────────────

    async load(id, opts = {}) {
        const s = this.all().find(x => x.id === id);
        if (!s) return;
        this.sessionId = s.id;
        // Include busy flag so the webview only restores the spinner for
        // sessions that are genuinely still running (not stale timer entries).
        this._post({ type: 'sessionLoaded', id: s.id, messages: s.messages || [], busy: !!opts.busy, totals: s.totals || null });
        this.postList();
        // Return buffered run events so the caller can replay them.
        return id;
    }

    async newSession() {
        this.sessionId = null;
        this._post({ type: 'sessionLoaded', id: null, messages: [] });
        this.postList();
    }

    async delete(id) {
        this._onDeleteRun(id); // let provider abort + remove run
        let list = this.all().filter(x => x.id !== id);
        if (this.sessionId === id) this.sessionId = null;
        await this.set(list);
        this.postList();
        if (!this.sessionId) this._post({ type: 'sessionLoaded', id: null, messages: [] });
    }

    async rename(id, title) {
        const list = this.all();
        const s = list.find(x => x.id === id);
        if (!s) return;
        s.title = String(title || '').slice(0, 80) || s.title;
        s.updatedAt = Date.now();
        await this.set(list);
        this.postList();
    }

    // Issue #142 P3-5: deep-clone an existing session under a new id.  The
    // resulting session has its own message history; subsequent edits do not
    // affect the original.  Caller may pass a custom title.
    async fork(id, title) {
        const list = this.all();
        const src = list.find(x => x.id === id);
        if (!src) return null;
        const clone = JSON.parse(JSON.stringify(src));
        // Use crypto.randomBytes for fork id rather than Math.random to satisfy
        // CodeQL js/insecure-randomness, though session ids are not security-critical.
        let _rand4 = '0000';
        try {
            const _crypto = require('crypto');
            _rand4 = _crypto.randomBytes(2).toString('hex');
        } catch { /* fallback only if node:crypto unavailable */ }
        // Keep id shape consistent with ensure(): `s_<ts>_<rand>` (Copilot
        // review feedback on PR #144).
        clone.id = `s_${Date.now().toString(36)}_${_rand4}`;
        clone.title = String(title || `${src.title || 'Fork'} (fork)`).slice(0, 80);
        clone.createdAt = Date.now();
        clone.ws = this._getCurrentWs();
        clone.updatedAt = Date.now();
        clone.pinned = false;
        delete clone.busy;
        list.unshift(clone);
        await this.set(list);
        this.sessionId = clone.id;
        this._post({ type: 'sessionLoaded', id: clone.id, messages: clone.messages || [] });
        this.postList();
        return clone.id;
    }

    async pin(id) {
        const list = this.all();
        const s = list.find(x => x.id === id);
        if (!s) return;
        s.pinned = !s.pinned;
        await this.set(list);
        this.postList();
    }

    async unread(id) {
        const list = this.all();
        const s = list.find(x => x.id === id);
        if (!s) return;
        s.unread = !s.unread;
        await this.set(list);
        this.postList();
    }

    /**
     * "Archive" a session — issues #165, #169.
     *
     * Behaviour evolution:
     *   pre-#165 : soft-hide toggle (flip `archived`, disappear from list).
     *   #165/#166: render to Markdown + soft-hide (export AND hide).
     *   #169     : pure export. Render to Markdown, leave session state
     *              completely untouched — it stays in the sidebar, stays
     *              the active session, can be archived again to produce
     *              another snapshot.
     *
     * Contract:
     *   - exportSessionToMarkdown returns absolute path → toast + done.
     *   - returns null (user cancelled folder picker / save dialog) → silent.
     *   - throws → toast error; no state change.
     *
     * Session state (`archived` flag, current sessionId, list ordering) is
     * never mutated by this method.
     */
    async archive(id) {
        const s = this.all().find(x => x.id === id);
        if (!s) return;

        let savedPath = null;
        try {
            const { exportSessionToMarkdown } = require('./archive-export');
            savedPath = await exportSessionToMarkdown(s);
        } catch (err) {
            const msg = (err && err.message) || String(err);
            vscode.window.showErrorMessage(tf('archiveFailed', { msg }));
            return;
        }
        if (!savedPath) return; // user cancelled

        this._notifyArchived(savedPath);
    }

    /**
     * Show the bottom-right toast with "Open" / "Reveal in Explorer" buttons.
     * Path display is workspace-relative when possible so users see
     *   ".deep-copilot/archives/20260526-….md"
     * instead of a long absolute path. Delegates the relativisation to
     * `findContainingFolder` so multi-root + nested-root cases stay correct.
     */
    _notifyArchived(absPath) {
        const { findContainingFolder } = require('../utils/paths');
        const hit = findContainingFolder(absPath);
        const display = hit ? hit.rel : absPath;

        const openLabel   = t('archiveOpenFile');
        const revealLabel = t('archiveRevealInOS');
        // `showInformationMessage` already returns a thenable, so we can
        // chain `.then()` directly. We still attach `.catch()` defensively
        // because the action handler itself is async and may reject if a
        // command call throws synchronously before reaching our try/catch.
        vscode.window.showInformationMessage(
            tf('archiveSaved', { path: display }), openLabel, revealLabel,
        ).then(async (choice) => {
            if (!choice) return;
            const uri = vscode.Uri.file(absPath);
            try {
                if (choice === openLabel) {
                    await vscode.window.showTextDocument(uri);
                } else if (choice === revealLabel) {
                    await vscode.commands.executeCommand('revealFileInOS', uri);
                }
            } catch (err) {
                const msg = (err && err.message) || String(err);
                vscode.window.showWarningMessage(tf('archiveOpenFailed', { msg }));
            }
        }, () => { /* swallow toast-promise rejection, if any */ });
    }

    // ─── Auto-naming ────────────────────────────────────────────────────────

    /**
     * Attempt to name a session from its first turn.
     * @param {() => Promise<string>} getApiKey
     * @param {() => string}          getApiBase
     */
    async maybeAutoName(sid, userText, asstText, getApiKey, getApiBase) {
        const list = this.all();
        const s = list.find(x => x.id === sid);
        if (!s) return;
        if (s.msgCount > 2) return; // only name on first turn
        const originalPrefix = (userText || '').slice(0, 40);
        if (s.title && s.title !== originalPrefix && s.title !== t('sessionUntitled')) return;

        let title = null;

        // LLM-powered title (tiny non-streaming call).
        try {
            const apiKey = await getApiKey();
            if (apiKey) title = await this._llmTitle(apiKey, getApiBase(), userText, asstText);
        } catch (_) { /* fall through */ }

        // Heuristic fallback.
        if (!title) {
            const stripCode = (txt) => String(txt || '')
                .replace(/```[\s\S]*?```/g, ' ')
                .replace(/`[^`]*`/g, ' ');
            const firstSentence = (txt) => {
                const cleaned = stripCode(txt).replace(/\s+/g, ' ').trim();
                if (!cleaned) return '';
                const m = cleaned.match(/^(.{8,80}?)([。.!?！？\n]|$)/);
                return m ? m[1].trim() : cleaned.slice(0, 60);
            };
            title = firstSentence(asstText);
            if (title.length < 8) title = firstSentence(userText);
            title = title.slice(0, TITLE_MAX_CHARS).trim();
        }

        if (!title) return;
        s.title = title;
        s.updatedAt = Date.now();
        await this.set(list);
        this.postList();
    }

    /** Fire a tiny non-streaming API call to get a short (≤ TITLE_MAX_CHARS) session title. */
    async _llmTitle(apiKey, baseUrl, userText, asstText) {
        const https = require('https');
        const http  = require('http');
        const base  = (baseUrl || 'https://api.deepseek.com').replace(/\/$/, '');
        const urlObj = new URL('/chat/completions', base);
        const isHttps = urlObj.protocol === 'https:';

        const strip = (t) => String(t || '')
            .replace(/```[\s\S]*?```/g, '')
            .replace(/`[^`]*`/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 300);

        const prompt =
            'Summarize the topic of the conversation below as a short title of at most 6 words. ' +
            'Write the title in the same language as the conversation. ' +
            'Output only the title, with no punctuation, no quotes and no explanation:\n' +
            `User: ${strip(userText)}\nAssistant: ${strip(asstText)}`;

        const body = JSON.stringify({
            model: 'deepseek-flash',
            messages: [{ role: 'user', content: prompt }],
            stream: false, max_tokens: 20, temperature: 0.3,
        });

        return new Promise((resolve) => {
            const mod = isHttps ? https : http;
            const req = mod.request({
                hostname: urlObj.hostname,
                port:     urlObj.port || (isHttps ? 443 : 80),
                path:     urlObj.pathname + (urlObj.search || ''),
                method:   'POST',
                headers: {
                    'Authorization':  `Bearer ${apiKey}`,
                    'Content-Type':   'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
                timeout: 8000,
            }, (res) => {
                let raw = '';
                res.on('data', (d) => { raw += d; });
                res.on('end', () => {
                    try {
                        const data = JSON.parse(raw);
                        const text = (data?.choices?.[0]?.message?.content || '').trim();
                        const clean = text
                            .replace(/["""''「」『』【】《》<>（）()\[\]{}\.\!\?。！？，,、；;：:\-—]/g, '')
                            .split('\n')[0]
                            .replace(/\s+/g, ' ')
                            .trim()
                            .slice(0, TITLE_MAX_CHARS);
                        resolve(clean || null);
                    } catch (_) { resolve(null); }
                });
            });
            req.on('error',   () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.write(body);
            req.end();
        });
    }
}

module.exports = { SessionStore, _dropOrphanToolCallGroups };
