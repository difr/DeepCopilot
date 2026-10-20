// ToolExecutor: runs tool calls with caching, approval, snapshots, and
// post-edit diagnostics.
//
// HOT-PLUGGABLE DESIGN: built-in tools are stored in a Map registry.
// Call registerTool(name, fn) to add or override any tool at runtime —
// useful for extensions, testing, or custom workspace tooling.
//
// Tool function signature: async (args, ctx) => string
//   ctx = { abortSignal, secrets }  (pass only what you need)
'use strict';

const vscode = require('vscode');
const fs     = require('fs');
const path   = require('path');

const { Logger }       = require('../logger');
const { t }            = require('../utils/strings');
const { wsRoot, resolvePath } = require('../utils/paths');
const { str, arr } = require('../utils/settings');
const { runHooks }     = require('../hooks');
const { resolveInteractionMode } = require('./compact-request');
const { mcpManager }   = require('../mcp');
const { lineDiffStats } = require('./diff-utils');

const {
    toolReadFile, toolListDir, toolGrepSearch, toolFindFiles,
    toolWriteFile, toolStrReplaceInFile, toolApplyPatch, toolRunShell, toolRunShellBg, toolReadTerminal, toolWebSearch, toolWebFetch, toolFetchTop,
    toolSavePlan,
    toolGetDiagnostics, toolGetEditorContext,
    toolGitStatus, toolGitDiff, toolGitLog,
    toolDiffFiles,
    toolFindReferences, toolGoToDefinition,
    toolMemoryRead, toolMemoryWrite,
} = require('../tools/exec');
const { skillInvoke, skillCreate } = require('../tools/skill-tools');

class ToolExecutor {
    // Read-only tools whose results can be cached until workspace changes.
    static CACHEABLE = new Set(['read_file', 'grep_search', 'find_files', 'list_dir', 'web_search', 'web_fetch', 'fetch_top', 'diff_files']);
    // Mutating tools that invalidate the file cache after execution.
    static MUTATING  = new Set(['write_file', 'str_replace_in_file', 'apply_patch', 'run_shell', 'run_shell_bg', 'skill_create', 'memory_write']);
    // Maximum cached entries per run; oldest entry is evicted on overflow (insertion-order LRU).
    static CACHE_MAX_ENTRIES = 200;

    /**
     * @param {vscode.ExtensionContext} context
     * @param {{
     *   postToRun : (run, msg) => void,
     *   post      : (msg)      => void,
     * }} opts
     */
    constructor(context, { postToRun, post }) {
        this._context   = context;
        this._postToRun = postToRun || (() => {});
        this._post      = post      || (() => {});

        /* Confirmations live in the chat instead of a modal: a destructive command can be long
           enough that the modal truncated it. The executor posts a card and parks the turn on a
           promise until the webview answers or the turn is aborted. */
        this._approvals   = new Map();
        this._approvalSeq = 0;

        // Lazy-init SubAgentRunner to avoid circular require at module load time.
        // Assigned on first use inside _handleSpawnAgent().
        this._subAgentRunner = null;

        // ── Built-in tool registry ────────────────────────────────────────
        // Keys are exact tool names. Values: async (args, ctx) => string.
        // Hot-pluggable: swap any entry with registerTool().
        this._registry = new Map([
            ['read_file',           (args)      => toolReadFile(args)],
            ['list_dir',            (args)      => toolListDir(args)],
            ['grep_search',         (args)      => toolGrepSearch(args)],
            ['find_files',          (args)      => toolFindFiles(args)],
            ['write_file',          (args)      => toolWriteFile(args)],
            ['str_replace_in_file', (args)      => toolStrReplaceInFile(args)],
            ['apply_patch',         (args)      => toolApplyPatch(args)],
            ['run_shell',           (args, ctx) => toolRunShell(args, ctx)],
            ['run_shell_bg',         (args, ctx) => toolRunShellBg(args, ctx)],
            ['read_terminal',       (args, ctx) => toolReadTerminal(args, ctx)],
            ['web_search',          (args, ctx) => toolWebSearch(args, ctx)],
            ['web_fetch',           (args, ctx) => toolWebFetch(args, ctx)],
            ['fetch_top',           (args, ctx) => toolFetchTop(args, ctx)],
            ['save_plan',           (args)      => toolSavePlan(args)],
            ['get_diagnostics',     (args)      => toolGetDiagnostics(args)],
            ['get_editor_context',  ()          => toolGetEditorContext()],
            ['git_status',          ()          => toolGitStatus()],
            ['git_diff',            (args)      => toolGitDiff(args)],
            ['git_log',             (args)      => toolGitLog(args)],
            ['diff_files',          (args)      => toolDiffFiles(args)],
            ['find_references',     (args)      => toolFindReferences(args)],
            ['go_to_definition',    (args)      => toolGoToDefinition(args)],
            ['memory_read',         ()          => toolMemoryRead()],
            ['memory_write',        (args)      => toolMemoryWrite(args)],
        ]);
    }

    // ─── Hot-plug API ────────────────────────────────────────────────────────

    /** Register (or replace) a tool implementation. Returns this for chaining. */
    registerTool(name, fn) {
        this._registry.set(name, fn);
        return this;
    }

    /** Remove a tool from the registry. Returns this for chaining. */
    unregisterTool(name) {
        this._registry.delete(name);
        return this;
    }

    /** List all registered tool names. */
    registeredTools() {
        return [...this._registry.keys()];
    }

    // ─── Cache helpers ───────────────────────────────────────────────────────

    argsHash(name, args) {
        try { return `${name}::${JSON.stringify(args, Object.keys(args || {}).sort())}`; }
        catch { return `${name}::${String(args)}`; }
    }

    invalidateCacheForMutation(run, name, args) {
        if (!run || !run.toolCache) return;
        const paths = new Set();
        if (args && args.path) paths.add(String(args.path));
        if (name === 'apply_patch' && args && args.patch) {
            const matches = String(args.patch).matchAll(/^\+\+\+ (?:b\/)?(.+)/gm);
            for (const m of matches) paths.add(m[1].trim());
        }
        if (name === 'run_shell' || paths.size === 0) {
            for (const key of run.toolCache.keys()) {
                if (key.startsWith('read_file::') || key.startsWith('list_dir::') ||
                    key.startsWith('find_files::') || key.startsWith('grep_search::')) {
                    run.toolCache.delete(key);
                }
            }
        } else {
            for (const key of run.toolCache.keys()) {
                for (const p of paths) {
                    if (key.includes(p)) { run.toolCache.delete(key); break; }
                }
            }
        }
    }

    // ─── Logging helpers ─────────────────────────────────────────────────────

    /** Parse tc.args, emit TOOL_CALL log + toolStart event. Returns parsed args. */
    logToolStart(run, tc) {
        let args;
        try { args = JSON.parse(tc.args || '{}'); } catch { args = {}; }
        Logger.info('TOOL_CALL', { id: tc.id, name: tc.name, args });
        const already = run._earlyStartedTools && run._earlyStartedTools.has(tc.id);
        if (already) {
            this._postToRun(run, { type: 'toolArgsFinal', id: tc.id, name: tc.name, args: tc.args || '{}' });
        } else {
            this._postToRun(run, { type: 'toolStart', id: tc.id, name: tc.name, args: tc.args || '{}' });
        }
        return args;
    }

    /** Normalize result to string, emit TOOL_RESULT log + toolResult event. Returns string. */
    logToolResult(run, tc, result, elapsedMs) {
        // Extract structured fields from run_shell before potential stringification.
        // shell.js returns an object on normal exit; error paths still return strings.
        let exitCode;
        if (tc.name === 'run_shell' && result && typeof result === 'object') {
            exitCode = result.exitCode;
        }
        if (typeof result !== 'string') {
            try { result = JSON.stringify(result); } catch { result = String(result); }
        }
        // For structured run_shell results, ok is determined by exitCode (not prefix).
        const ok = (exitCode !== undefined)
            ? (exitCode === 0)
            : !result.startsWith('Error');
        Logger.info('TOOL_RESULT', { id: tc.id, name: tc.name, elapsed_ms: elapsedMs, ok, output: result.slice(0, 2000) });
        // The webview renders this string, so it is capped — but the cap belongs to the payload,
        // not to the JSON envelope: chopping the envelope leaves invalid JSON, and the pane falls
        // back to raw text instead of showing the output.
        const VIEW_LIMIT = 8000;
        const STDERR_LIMIT = 2000;
        let shown = result;
        if (shown.length > VIEW_LIMIT) {
            /* Trim a field only when that field is the long one: a big stderr must not brand a
               short stdout as truncated. And never split a surrogate pair — the tail would
               render as a replacement character. */
            const trim = (s, limit) => {
                if (typeof s !== 'string' || s.length <= limit) return s;
                let cut = limit;
                const code = s.charCodeAt(cut - 1);
                if (code >= 0xD800 && code <= 0xDBFF) cut -= 1;
                return s.slice(0, cut) + '\n\n…[truncated]';
            };
            /* A structured result keeps its shape — only long string values are shortened, so
               the envelope stays parseable. No depth limit: the tree came out of JSON.parse, so
               it is finite, and a cap on depth would let a deep megabyte string through and
               force the whole envelope to be cut as text.

               Trimming is addressed, not blanket: only stdout/text (and stderr, at its own
               smaller cap) are output-sized fields. A trimmed url stops being a url, and the
               pane renders everything as text anyway. Arrays are capped as well: thousands of
               short records are individually fine but add up to megabytes. The marker added
               when an array is cut is a plain string sitting in a list of objects — harmless
               for rendering, but code reading fields off those items would trip on it. Cutting
               the stringified object stays the last resort. */
            const ARRAY_CAP = 40;
            const LONG_FIELDS = new Set(['stdout', 'text']);
            const trimDeep = (v, key) => {
                if (typeof v === 'string') {
                    if (key === 'stderr') return trim(v, STDERR_LIMIT);
                    if (LONG_FIELDS.has(key)) return trim(v, VIEW_LIMIT);
                    return v;
                }
                if (Array.isArray(v)) {
                    const head = v.slice(0, ARRAY_CAP).map(x => trimDeep(x, key));
                    if (v.length > ARRAY_CAP) head.push(`…[${v.length - ARRAY_CAP} more items]`);
                    return head;
                }
                if (v && typeof v === 'object') {
                    const out = {};
                    for (const k of Object.keys(v)) out[k] = trimDeep(v[k], k);
                    return out;
                }
                return v;
            };
            try {
                const p = JSON.parse(shown);
                if (p && typeof p === 'object') {
                    let s = JSON.stringify(p);
                    if (s.length > VIEW_LIMIT) s = JSON.stringify(trimDeep(p, ''));
                    if (s.length > VIEW_LIMIT) s = trim(s, VIEW_LIMIT);
                    shown = s;
                } else {
                    shown = trim(shown, VIEW_LIMIT);
                }
            } catch {
                shown = trim(shown, VIEW_LIMIT);
            }
        }
        this._postToRun(run, { type: 'toolResult', id: tc.id, name: tc.name, ok, exitCode, output: shown });
        return result;
    }

    // ─── Approval ────────────────────────────────────────────────────────────

    /**
     * Race a tool promise against the abort signal so the agent-loop never
     * waits on a tool that ignores `ctx.abortSignal`.  The underlying tool may
     * keep running internally (best effort to also pass `abortSignal` in),
     * but its result will be discarded.  Issue #58 P0-3.
     */
    _raceWithAbort(promise, abortSignal) {
        if (!abortSignal) return promise;
        if (abortSignal.aborted) return Promise.reject(new Error('aborted'));
        return new Promise((resolve, reject) => {
            let settled = false;
            const onAbort = () => {
                if (settled) return;
                settled = true;
                try { abortSignal.removeEventListener('abort', onAbort); } catch {}
                reject(new Error('aborted'));
            };
            abortSignal.addEventListener('abort', onAbort, { once: true });
            promise.then(
                (v) => { if (settled) return; settled = true; try { abortSignal.removeEventListener('abort', onAbort); } catch {} resolve(v); },
                (e) => { if (settled) return; settled = true; try { abortSignal.removeEventListener('abort', onAbort); } catch {} reject(e); },
            );
        });
    }

    async requestApproval(description, abortSignal) {
        const answer = await this._approve({ title: t('approvalRequest').trim(), detail: description, abortSignal });
        return answer !== false;
    }

    /* Posts a card and resolves with the answer: false when declined or aborted, 'once' for a
       single run, 'session' when the user asked not to be asked again for this command. With
       `scoped` false only Allow and Deny are offered — nothing to remember. */
    _approve({ title, detail, abortSignal, scoped = false }) {
        const id = 'ap' + (++this._approvalSeq);
        return new Promise((resolve) => {
            let settled = false;
            const finish = (allow, scope) => {
                if (settled) return;
                settled = true;
                this._approvals.delete(id);
                try { if (abortSignal) abortSignal.removeEventListener('abort', onAbort); } catch {}
                resolve(allow === true ? (scope === 'session' ? 'session' : 'once') : false);
            };
            const onAbort = () => {
                /* The turn is gone, so the buttons would answer nobody: tell the webview to
                   retire the card before the promise resolves. */
                this._post({ type: 'approvalCancel', id });
                finish(false);
            };
            this._approvals.set(id, finish);
            if (abortSignal) {
                if (abortSignal.aborted) { finish(false); return; }
                abortSignal.addEventListener('abort', onAbort, { once: true });
            }
            this._post({ type: 'approvalRequest', id, title, detail, scoped: scoped === true });
        });
    }

    answerApproval(id, allow, scope) {
        const finish = this._approvals.get(id);
        if (!finish) return false;
        finish(allow === true, scope);
        return true;
    }

    // ─── Pre-edit snapshot ───────────────────────────────────────────────────

    snapshotForEdit(run, name, args) {
        const paths = this._collectEditPaths(name, args);
        for (const rel of paths) {
            let abs;
            try { abs = resolvePath(rel); } catch { continue; }
            if (run.turnSnapshots.has(abs)) continue; // only capture once per turn
            let before;
            try { before = fs.readFileSync(abs, 'utf8'); }
            catch { before = null; } // null = file didn't exist
            run.turnSnapshots.set(abs, before);
            // Initialise a pendingEdits skeleton so the recorder pass below has
            // somewhere to land. Keep the earliest captured `before` if the same
            // file is edited multiple times in the turn (matches turnSnapshots).
            if (run.pendingEdits && !run.pendingEdits.has(abs)) {
                run.pendingEdits.set(abs, {
                    tool:     name,
                    before,
                    after:    null,
                    added:    0,
                    removed:  0,
                    isNew:    before === null,
                    isDelete: false,
                    binary:   false,
                    approximate: false,
                    status:   'pending',
                    rel:      this._relFromAbs(abs),
                    updatedAt: Date.now(),
                });
            }
        }
    }

    /** Extract the list of relative paths a write tool will touch. */
    _collectEditPaths(name, args) {
        const paths = [];
        if ((name === 'write_file' || name === 'str_replace_in_file') && args && args.path) {
            paths.push(String(args.path));
        } else if (name === 'apply_patch' && args && args.patch) {
            const re = /^\+\+\+ (?:b\/)?(\S+)/gm;
            let m;
            while ((m = re.exec(String(args.patch))) !== null) {
                const p = m[1].trimEnd();
                if (p && p !== '/dev/null') paths.push(p);
                if (paths.length >= 20) break;
            }
        }
        return paths;
    }

    _relFromAbs(abs) {
        const root = wsRoot() || process.cwd();
        try { return path.relative(root, abs).replace(/\\/g, '/'); }
        catch { return abs; }
    }

    /**
     * After a successful write-tool execution, read the file's new contents,
     * compute +N/-M against the snapshotted `before`, update run.pendingEdits,
     * and emit a `pendingEdits` event for the webview.
     *
     * Idempotent: safe to call multiple times for the same path within a turn
     * (the latest `after` wins; `before` is preserved as the very first one).
     */
    recordEditResult(run, name, args) {
        if (!run || !run.pendingEdits) return;
        const paths = this._collectEditPaths(name, args);
        for (const rel of paths) {
            let abs;
            try { abs = resolvePath(rel); } catch { continue; }
            const entry = run.pendingEdits.get(abs);
            if (!entry) continue; // snapshotForEdit should have created one
            let after;
            let isDelete = false;
            try { after = fs.readFileSync(abs, 'utf8'); }
            catch { after = null; isDelete = true; }
            entry.after    = after;
            entry.isDelete = isDelete;
            const stats = lineDiffStats(entry.before, after);
            entry.added       = stats.added;
            entry.removed     = stats.removed;
            entry.isNew       = stats.isNew;
            entry.isDelete    = stats.isDelete || isDelete;
            entry.binary      = !!stats.binary;
            entry.approximate = !!stats.approximate;
            entry.status      = 'pending';
            entry.updatedAt   = Date.now();
        }
        this._postToRun(run, { type: 'pendingEdits', items: this.serializePendingEdits(run) });
    }

    /** Trim the in-memory map down to the wire-safe shape for the webview. */
    serializePendingEdits(run) {
        if (!run || !run.pendingEdits) return [];
        const out = [];
        for (const [abs, e] of run.pendingEdits) {
            if (e.status !== 'pending') continue;
            out.push({
                path:        abs,
                rel:         e.rel,
                tool:        e.tool,
                added:       e.added,
                removed:     e.removed,
                isNew:       !!e.isNew,
                isDelete:    !!e.isDelete,
                binary:      !!e.binary,
                approximate: !!e.approximate,
                updatedAt:   e.updatedAt,
            });
        }
        // Most recent first — matches the order a user expects to review.
        out.sort((a, b) => b.updatedAt - a.updatedAt);
        return out;
    }

    // ─── Post-edit diagnostics ───────────────────────────────────────────────

    async collectPostEditDiagnostics(name, args) {
        const paths = [];
        if (name === 'write_file' || name === 'str_replace_in_file') {
            if (args && args.path) paths.push(args.path);
        } else if (name === 'apply_patch') {
            const patch = String(args && args.patch || '');
            const re = /^\+\+\+ (?:b\/)?(\S+)/gm;
            let m;
            while ((m = re.exec(patch)) !== null) {
                if (m[1] && m[1] !== '/dev/null') paths.push(m[1]);
                if (paths.length >= 6) break;
            }
        }
        if (!paths.length) return '';

        await new Promise(r => setTimeout(r, 500)); // let language servers reanalyse

        const sevName = (s) => ['Error', 'Warning', 'Info', 'Hint'][s] || 'Info';
        const lines = [];
        let totalErr = 0, totalWarn = 0;
        for (const rel of paths) {
            let abs;
            try { abs = resolvePath(rel); } catch { continue; }
            let uri;
            try { uri = vscode.Uri.file(abs); } catch { continue; }
            const diags = vscode.languages.getDiagnostics(uri) || [];
            const filt = diags
                .filter(d => d.severity === vscode.DiagnosticSeverity.Error ||
                             d.severity === vscode.DiagnosticSeverity.Warning)
                .slice(0, 8);
            if (!filt.length) continue;
            lines.push(`- ${rel}:`);
            for (const d of filt) {
                const sev = sevName(d.severity);
                const ln  = (d.range && d.range.start && (d.range.start.line + 1)) || '?';
                const src = d.source ? `[${d.source}] ` : '';
                const msg = String(d.message || '').replace(/\s+/g, ' ').slice(0, 200);
                if (d.severity === vscode.DiagnosticSeverity.Error) totalErr++;
                else totalWarn++;
                lines.push(`    L${ln} ${sev}: ${src}${msg}`);
            }
        }
        if (!lines.length) return '';
        const header = `--- post-edit diagnostics (${totalErr} error, ${totalWarn} warning) ---`;
        const footer = totalErr > 0
            ? 'ACTION: fix the errors above before reporting the task complete.'
            : 'Warnings only — review and fix if related to your change.';
        return [header, ...lines, footer].join('\n');
    }

    // ─── Main entry point ────────────────────────────────────────────────────

    async execute(name, args, approvalMode, run, abortSignal, tcId) {
        // Deny list / readonly guard
        const cfg = vscode.workspace.getConfiguration('deepseekAgent');
        const denyList    = arr(cfg.get('denyTools'));
        const autoApprove = arr(cfg.get('autoApproveTools'));
        if (denyList.includes(name)) return `Denied by configuration: ${name} is in denyTools.`;

        const isMutating = ToolExecutor.MUTATING.has(name);
        if (approvalMode === 'readonly' && isMutating) return t('deniedReadonly');

        // Issue #66: Plan mode is a soft "readonly" enforced at the executor.
        // The system prompt also instructs the model to stay read-only, but
        // we still guard the executor in case the model ignores the prompt.
        const interactionMode = resolveInteractionMode(cfg);
        if (interactionMode === 'plan' && isMutating) {
            return `PLAN_MODE_FORBIDDEN: ${name} is a write/exec tool and is disabled in Plan mode. Stay read-only (read_file, grep_search, list_dir, find_files, diff_files, web_search, web_fetch, fetch_top, update_plan) and produce a plan for the user to review. The user can switch to Agent mode to execute it.`;
        }

        const skipApproval = autoApprove.includes(name);

        /* Set when this call needed the user's word. Attached to the result below, so the model
           can tell an approved call from one that never asked. */
        let approvalNote = null;

        // Approval dialogs for write + shell
        if ((name === 'write_file' || name === 'str_replace_in_file' || name === 'apply_patch') &&
            approvalMode === 'manual' && !skipApproval) {
            const desc = name === 'write_file'
                ? `${t('writeFileLabel')}${args.path}`
                : name === 'apply_patch'
                    ? `${t('writeFileLabel')}(patch)`
                    : `${t('writeFileLabel')}${args.path} (str_replace)`;
            if (!await this.requestApproval(desc, abortSignal)) return t('deniedByUser');
            approvalNote = 'once';
        }

        /* A dangerous command has its own gate inside run_shell, with a richer answer — allow
           once, allow for the session, deny. Asking here first would put two cards in front of
           one command and let the two answers disagree. */
        if (name === 'run_shell' && approvalMode === 'manual' && !skipApproval &&
            !require('../tools/shell').isDangerous(String(args.command || ''))) {
            if (!await this.requestApproval(`${t('runCmdLabel')}${args.command}`, abortSignal)) return t('deniedByUser');
            approvalNote = 'once';
        }

        // Skill creation writes outside the workspace (~/.deepcopilot/skills/...).
        // Always confirm with the user unless explicitly auto-approved.
        if (name === 'skill_create' && approvalMode === 'manual' && !skipApproval) {
            const desc = `${t('createSkillLabel')}"${args && args.name || '?'}" — ${args && args.description || ''}`;
            if (!await this.requestApproval(desc, abortSignal)) return t('deniedByUser');
            approvalNote = 'once';
        }

        // Cache lookup (read-only tools)
        const cache = run && run.toolCache;
        if (cache && ToolExecutor.CACHEABLE.has(name)) {
            const key = this.argsHash(name, args);
            if (cache.has(key)) {
                const entry = cache.get(key);
                if (name === 'read_file' && args.path) {
                    try {
                        const mtime = fs.statSync(resolvePath(args.path)).mtimeMs;
                        if (entry.mtime === mtime) return entry.result + '\n(cached)';
                        cache.delete(key); // stale — fall through to fresh read
                    } catch { /* file gone — fall through */ }
                } else {
                    return entry.result + '\n(cached)';
                }
            }
        }

        // Pre-edit snapshot
        if (run && run.turnSnapshots && isMutating && name !== 'run_shell') {
            this.snapshotForEdit(run, name, args);
        }

        // Dispatch to registry or special handlers — wrapped in a signal-race so
        // tools that don't honour `ctx.abortSignal` internally (sync I/O, third-
        // party libraries, etc.) still let the agent-loop unblock immediately
        // when the user presses Stop.  Issue #58 (P0-3).
        const dispatchPromise = this.dispatch(name, args, run, abortSignal, tcId);
        const result = await this._raceWithAbort(dispatchPromise, abortSignal);

        // Cache store (read-only)
        if (cache && ToolExecutor.CACHEABLE.has(name) && typeof result === 'string' && !result.startsWith('Error:')) {
            const key = this.argsHash(name, args);
            const entry = { result };
            if (name === 'read_file' && args.path) {
                try { entry.mtime = fs.statSync(resolvePath(args.path)).mtimeMs; } catch {}
            }
            cache.set(key, entry);
            // P0-1: LRU eviction — keep cache bounded to prevent memory leaks in long sessions.
            if (cache.size > ToolExecutor.CACHE_MAX_ENTRIES) {
                cache.delete(cache.keys().next().value);
            }
        }

        // Cache invalidation (mutating)
        if (isMutating) this.invalidateCacheForMutation(run, name, args);

        // After-tool hooks
        if (typeof result === 'string' && !result.startsWith('Error')) {
            const wsR = wsRoot();
            if (wsR) {
                try {
                    const hookOut = await runHooks('after_tool', name, wsR);
                    if (hookOut) return result + '\n\n[hooks]\n' + hookOut;
                } catch (e) { Logger.info('HOOK_ERROR', { name, message: e.message }); }
            }
        }

        // Post-edit diagnostics
        if (typeof result === 'string' && !result.startsWith('Error') &&
            (name === 'write_file' || name === 'str_replace_in_file' || name === 'apply_patch')) {
            // Update the pending-edits panel with the latest after-state.
            try { this.recordEditResult(run, name, args); }
            catch (e) { Logger.info('PENDING_EDIT_RECORD_ERROR', { message: e.message }); }

            const cfg2 = vscode.workspace.getConfiguration('deepseekAgent');
            if (cfg2.get('postEditDiagnostics', true)) {
                try {
                    const diagBlock = await this.collectPostEditDiagnostics(name, args);
                    if (diagBlock) return result + '\n\n' + diagBlock;
                } catch (e) { Logger.info('POST_EDIT_DIAG_ERROR', { message: e.message }); }
            }
        }

        return approvalNote ? this._annotateApproval(result, approvalNote) : result;
    }

    /* Attaches the approval to the tool result so the model can tell an approved call from one
       that never asked. Objects keep their shape; strings get a trailing line. A result that
       already carries `approval` (run_shell decides once vs session itself) is left alone. */
    _annotateApproval(result, note) {
        if (result && typeof result === 'object' && !Array.isArray(result)) {
            return result.approval ? result : { ...result, approval: note };
        }
        if (typeof result === 'string') return `${result}\n\napproval: ${note}`;
        return result;
    }

    // ─── Dispatch ────────────────────────────────────────────────────────────

    async dispatch(name, args, run, abortSignal, tcId) {
        // Registry tools (hot-pluggable)
        const fn = this._registry.get(name);
        if (fn) {
            // Streaming hook: tools that produce live output (run_shell) call
            // ctx.onStreamDelta(chunk) as data arrives; we forward each chunk to
            // the webview tagged with the tool-call id so the card can render
            // a live tail (GH-Copilot-style terminal card).
            const ctx = {
                abortSignal,
                secrets: this._context.secrets,
                sessionId: run?.sessionId ?? null,
                /* shell.js asks here before running a destructive command: the card shows the
                   full command, where a modal cut it off. */
                approveDangerous: (cmd, sig) => this._approve({
                    title: t('dangerCmdTitle').trim(),
                    detail: cmd,
                    abortSignal: sig || abortSignal,
                    scoped: true,
                }),
            };
            // The question that put the model here, so a web search can read the intent rather
            // than only the keywords the model chose. Reminders and checkpoints are skipped:
            // they are history bookkeeping, not something the user asked.
            if (run && Array.isArray(run.messages)) {
                for (let i = run.messages.length - 1; i >= 0; i--) {
                    const m = run.messages[i];
                    const text = m && m.role === 'user' && typeof m.content === 'string' ? m.content.trim() : '';
                    if (!text || /^<(system-reminder|compact-summary)/i.test(text)) continue;
                    ctx.lastUserText = text.slice(0, 400);
                    break;
                }
            }
            // Issue #167: let run_shell_bg register the just-started jobId
            // into the run's own "session-started" set, so agent-loop's
            // BG_WAIT_SKIPPED_MODEL_DONE guard can refuse to end the turn while
            // a freshly spawned background task is still alive. No-op when run
            // is null (e.g. one-shot dispatch from tests).
            ctx.registerBgJob = (jobId) => {
                if (!jobId || !run) return;
                if (!(run._sessionStartedBgJobs instanceof Set)) run._sessionStartedBgJobs = new Set();
                run._sessionStartedBgJobs.add(jobId);
            };
            // Watchdog/monitor detection: when the model inspects an existing
            // deepseek-job-* terminal via read_terminal in this run, treat that
            // as an active monitoring commitment. agent-loop's
            // BG_WAIT_SKIPPED_MODEL_DONE guard refuses to end the turn while a
            // monitored job is still alive — preventing the model from
            // "promising to keep watching" and then immediately stopping when
            // the underlying job was spawned in a previous turn.
            if (name === 'read_terminal' && run && args && typeof args.terminal === 'string') {
                const _jobId = args.terminal;
                if (/^deepseek-job-/.test(_jobId)) {
                    if (!(run._monitoredBgJobs instanceof Set)) run._monitoredBgJobs = new Set();
                    run._monitoredBgJobs.add(_jobId);
                }
            }
            if (tcId) {
                ctx.onStreamDelta = (delta) => {
                    if (!delta) return;
                    this._postToRun(run, { type: 'toolStreamDelta', id: tcId, delta: String(delta) });
                };
            }
            return fn(args, ctx);
        }

        // Special tools that need run-level state
        if (name === 'update_plan')      return this._handleUpdatePlan(args, run);
        if (name === 'revert_last_turn') return this._handleRevertLastTurn(args, run);

        // Skill subsystem (Issue #61) — skill_invoke needs run.messages to inject
        // a synthetic read_file pair; skill_create is a pure file write but
        // also needs `run` for the Issue #146 skill-creator quality gate.
        if (name === 'skill_invoke')     return skillInvoke(args, run);
        if (name === 'skill_create')     return skillCreate(args, run, tcId);

        // Watch + yield_turn: auto-resume primitives. Both need `run` for
        // session-scoped state (yield flag, watcher session binding).
        if (name === 'watch' || name === 'yield_turn') {
            const { toolWatch, toolYieldTurn } = require('../tools/sleep');
            return name === 'watch' ? toolWatch(args, run) : toolYieldTurn(args, run);
        }

        // Sub-agent dispatch
        if (name === 'spawn_agent')      return this._handleSpawnAgent(args, run, abortSignal);

        // MCP pass-through
        if (mcpManager.isMcpTool(name)) {
            try { return await mcpManager.callTool(name, args); }
            catch (e) { return `Error: ${e.message}`; }
        }

        return `Unknown tool: ${name}`;
    }

    // ─── Built-in special handlers ───────────────────────────────────────────

    _handleUpdatePlan(args, run) {
        const normStatus = (status, done) => {
            if (done === true) return 'done';
            const s = String(status || '').toLowerCase();
            if (s === 'completed' || s === 'complete' || s === 'done') return 'done';
            if (s === 'inprogress' || s === 'in_progress') return 'in_progress';
            if (s === 'blocked') return 'blocked';
            return 'pending';
        };
        const normTitle = (item, idx) => {
            const raw = item?.title ?? item?.text ?? item?.step ?? item?.content;
            return String(raw || '').trim() || `Step ${idx + 1}`;
        };

        const rawSteps = Array.isArray(args?.plan) ? args.plan
            : Array.isArray(args?.steps) ? args.steps : [];
        const steps = rawSteps.map((item, idx) => ({
            title: normTitle(item, idx), status: normStatus(item?.status, item?.done),
        }));
        const todos = (Array.isArray(args?.todos) ? args.todos : []).map((item, idx) => ({
            title: normTitle(item, idx), status: normStatus(item?.status, item?.done),
        }));

        if (run) {
            this._postToRun(run, { type: 'plan', steps, todos });
            run.plan = { steps, todos };
            run.planUpdatedIter = run._iter ?? -1;
        } else {
            this._post({ type: 'plan', steps, todos });
        }
        return 'Plan updated.';
    }

    _handleRevertLastTurn(args, run) {
        if (!run || !run.turnSnapshots || run.turnSnapshots.size === 0) {
            return 'No file changes recorded for this turn. Nothing to revert.';
        }
        const reverted = [], failed = [];
        const root = wsRoot() || process.cwd();
        for (const [absPath, original] of run.turnSnapshots) {
            try {
                if (original === null) {
                    if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
                } else {
                    fs.writeFileSync(absPath, original, 'utf8');
                }
                reverted.push(path.relative(root, absPath));
            } catch (e) {
                failed.push(`${path.relative(root, absPath)}: ${e.message}`);
            }
        }
        run.turnSnapshots.clear();
        if (run.pendingEdits) {
            run.pendingEdits.clear();
            this._postToRun(run, { type: 'pendingEdits', items: [] });
        }
        let msg = `Reverted ${reverted.length} file(s) to pre-turn state: ${reverted.join(', ')}`;
        if (failed.length) msg += `\nFailed to revert: ${failed.join('; ')}`;
        return msg;
    }

    // ─── spawn_agent ─────────────────────────────────────────────────────────

    _handleSpawnAgent(args, run, abortSignal) {
        // Lazy initialise SubAgentRunner on first use to avoid circular-require at boot.
        if (!this._subAgentRunner) {
            const { SubAgentRunner } = require('./sub-agent');
            this._subAgentRunner = new SubAgentRunner({
                context:   this._context,
                exec:      this,
                postToRun: this._postToRun,
            });
        }
        return this._subAgentRunner.spawn(args, run, abortSignal);
    }
}

module.exports = { ToolExecutor };
