// Read-only file tools: read_file, list_dir, grep_search, find_files.
// All use spawn (not shell) for external commands — injection-safe.
'use strict';

const fs       = require('fs');
const path     = require('path');
const cp       = require('child_process');
const readline = require('readline');
const vscode   = require('vscode');

const { wsRoot, resolvePath } = require('../utils/paths');
const { t }                   = require('../utils/strings');
const { truncate, ensurePathAllowed } = require('./utils');
const { readFileText, createDecodedStream, decodeBuf, resolveEncoding } = require('../utils/encoding');

// ─── Search engine detection ─────────────────────────────────────────────────
// Prefer, in order:
//   1. ripgrep from PATH (user-installed) — fast, .gitignore-aware, sees
//      untracked files.
//   2. ripgrep bundled with VS Code itself (vscode-ripgrep) — present on
//      every install, no PATH setup needed.
//   3. `git grep` — fast, .gitignore-aware (node_modules/tmp excluded), but
//      ONLY searches tracked files, so it is skipped for untracked targets.
//   4. findstr / grep — last resort; no .gitignore support (slow on trees
//      like node_modules).
//
// Engines 1-3 honour .gitignore, which hides build output and log directories
// (out/, tmp/, .deep-copilot/). The `include_ignored` argument — or an explicit
// path that git itself ignores — drops those rules for the call.

function detectRipgrep() {
    try {
        const probe = process.platform === 'win32' ? 'where' : 'which';
        cp.execFileSync(probe, ['rg'], { stdio: 'pipe' });
        return 'rg';
    } catch { /* not on PATH — try VS Code's bundled copy */ }
    try {
        const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
        const appRoot = vscode.env && vscode.env.appRoot;
        if (!appRoot) return null;
        // VS Code ships ripgrep under several layouts depending on version:
        //   node_modules/@vscode/ripgrep/bin/<exe>
        //   node_modules/@vscode/ripgrep-universal/bin/<platform>/<exe>   (recent)
        //   node_modules.asar.unpacked/... (older builds unpack the asar)
        // Plus GitHub Copilot's bundled copy as a final convenience.
        const platformDir = `${process.platform}-${process.arch}`; // e.g. win32-x64
        const bases = [
            path.join(appRoot, 'node_modules'),
            path.join(appRoot, 'node_modules.asar.unpacked'),
            path.join(appRoot, 'resources', 'app', 'node_modules'),
            path.join(appRoot, 'resources', 'app', 'node_modules.asar.unpacked'),
        ];
        const candidates = [];
        for (const base of bases) {
            candidates.push(path.join(base, 'vscode-ripgrep', 'bin', exe));
            candidates.push(path.join(base, '@vscode', 'ripgrep', 'bin', exe));
            candidates.push(path.join(base, '@vscode', 'ripgrep', 'bin', platformDir, exe));
            candidates.push(path.join(base, '@vscode', 'ripgrep-universal', 'bin', platformDir, exe));
        }
        // GitHub Copilot extension bundles its own rg under the SDK dir.
        candidates.push(path.join(appRoot, 'resources', 'app', 'extensions', 'copilot',
            'node_modules', '@github', 'copilot', 'sdk', 'ripgrep', 'bin', platformDir, exe));
        for (const c of candidates) {
            if (fs.existsSync(c)) return c;
        }
    } catch { /* fall through */ }
    return null;
}
let _RG_CACHE = null;
function rgPath() {
    if (_RG_CACHE === null) _RG_CACHE = detectRipgrep() || '';
    return _RG_CACHE || null;
}

/**
 * Whether `git grep` can fully answer a search for `root` (absolute path).
 * git grep searches the index — it silently misses untracked files, so we
 * use it only when the target is a tracked file, or a directory containing
 * tracked files and no untracked ones.
 */
function _gitGrepUsable(root) {
    try {
        if (fs.statSync(root).isFile()) {
            const r = runArgv('git', ['ls-files', '--error-unmatch', root]);
            return !r.error && r.status === 0;
        }
        const tracked = runArgv('git', ['ls-files', root]);
        if (tracked.error || (tracked.stdout || '').trim() === '') return false;
        const untracked = runArgv('git', ['ls-files', '--others', '--exclude-standard', root]);
        return !untracked.error && (untracked.stdout || '').trim() === '';
    } catch { return false; }
}

/**
 * Whether `absPath` is excluded by git's ignore rules (.gitignore, info/exclude,
 * core.excludesFile). An explicitly targeted ignored path must still be searched:
 * ripgrep applies ignore rules even to paths given on the command line, which
 * silently turned "grep the logs in .deep-copilot/" into "(no matches)".
 */
function _isIgnoredPath(absPath) {
    try {
        const r = runArgv('git', ['check-ignore', '-q', absPath]);
        return !r.error && r.status === 0;
    } catch { return false; }
}

function runArgv(file, argv, opts = {}) {
    return cp.spawnSync(file, argv, {
        cwd: opts.cwd || wsRoot(),
        timeout: opts.timeout || 15000,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        shell: false,
    });
}

// ─── Large-file helpers ───────────────────────────────────────────────────────

const MAX_DIRECT_READ  = 10 * 1024 * 1024; // 10 MB  — above this, use streaming
const MAX_OUTPUT_CHARS = 32000;             // matches truncate() default

/**
 * Stream-read only the requested line range — safe for files of any size.
 * Uses Node readline so it never loads the full file into memory.
 * The read is always O(end_line) in time but O(output size) in memory.
 */
function readLineRangeStreamed(fp, startLine, endLine) {
    const s = Math.max(0, (startLine || 1) - 1);
    const e = (endLine != null) ? endLine : Infinity;

    return new Promise((resolve, reject) => {
        let stream;
        try { stream = createDecodedStream(fp).stream; }
        catch (err) { return reject(err); }

        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

        let lineNum  = 0;
        const lines  = [];
        let outChars = 0;
        let capped   = false;

        const close = () => {
            // Stop 'line' processing immediately — rl.close() alone does not
            // prevent already-queued 'line' events from firing afterwards.
            try { rl.removeAllListeners('line'); } catch {}
            try { if (!rl.closed) rl.close(); } catch {}
            try { if (!stream.destroyed) stream.destroy(); } catch {}
        };

        rl.on('line', (line) => {
            if (capped) return;
            if (lineNum >= s && lineNum < e) {
                const entry = `${lineNum + 1}: ${line}`;
                outChars += entry.length + 1;
                if (outChars > MAX_OUTPUT_CHARS) {
                    capped = true;
                    lines.push(`\n... [output capped at ${MAX_OUTPUT_CHARS} chars — narrow the range] ...`);
                    close();
                    return;
                }
                lines.push(entry);
            }
            lineNum++;
            if (lineNum >= e) close();
        });

        rl.on('close', () => resolve(lines.join('\n') || '(empty range)'));
        rl.on('error', reject);
        stream.on('error', reject);
    });
}

/**
 * Sample the first 64 KB to estimate total line count and detect binary files.
 * Returns { lines: number|null, binary: boolean }
 */
function estimateLineCount(fp, fileSize) {
    const SAMPLE = 65536;
    let fd;
    try {
        fd = fs.openSync(fp, 'r');
        const buf = Buffer.alloc(SAMPLE);
        const n   = fs.readSync(fd, buf, 0, SAMPLE, 0);
        if (n === 0) return { lines: 0, binary: false };
        // Binary detection: any null byte in the sample
        for (let i = 0; i < n; i++) if (buf[i] === 0) return { lines: null, binary: true };
        const sample  = decodeBuf(buf.slice(0, n), resolveEncoding(fp));
        const nlCount = (sample.match(/\n/g) || []).length;
        if (nlCount === 0) return { lines: 1, binary: false }; // no newlines found
        const avgLineBytes = n / nlCount;
        return { lines: Math.round(fileSize / avgLineBytes), binary: false };
    } catch { return { lines: null, binary: false }; }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

// ─── read_file ───────────────────────────────────────────────────────────────

async function toolReadFile(args) {
    try {
        const fp = resolvePath(args.path);
        if (!await ensurePathAllowed(fp, 'read')) return t('blockedOutsideWs');

        let stat;
        try { stat = fs.statSync(fp); } catch { /* will fail below on readFileSync */ }

        const fileSize = stat ? stat.size : 0;
        const isLarge  = fileSize > MAX_DIRECT_READ;
        const hasRange = !!(args.start_line || args.end_line);

        // ── Large file + line range: stream, never load full file ────────
        if (isLarge && hasRange) {
            return await readLineRangeStreamed(fp, args.start_line, args.end_line);
        }

        // ── Large file, no range: return a structured plan for the agent ─
        if (isLarge && !hasRange) {
            const mb  = (fileSize / 1024 / 1024).toFixed(1);
            const { lines: estLines, binary } = estimateLineCount(fp, fileSize);

            if (binary) {
                return [
                    `[large-binary-file] ${path.basename(fp)} — ${mb} MB`,
                    ``,
                    `This appears to be a binary/non-text file. Strategies:`,
                    `  • grep_search — ripgrep handles binary files gracefully (text patterns)`,
                    `  • Describe the expected binary format so the agent can plan a hex/struct approach.`,
                ].join('\n');
            }

            const lineStr   = estLines != null ? `~${estLines.toLocaleString()} lines` : 'line count unknown';
            const N_AGENTS  = 8;
            const chunkSize = estLines ? Math.ceil(estLines / N_AGENTS) : null;
            const chunkHint = chunkSize
                ? Array.from({ length: N_AGENTS }, (_, i) => {
                      const sl = i * chunkSize + 1;
                      const el = (i + 1) * chunkSize;
                      return `    agent ${i + 1}: start_line=${sl} end_line=${el}`;
                  }).join('\n')
                : `    read_file path="${args.path}" start_line=1 end_line=50000  (then increment)`;

            return [
                `[large-file] ${path.basename(fp)} — ${mb} MB | ${lineStr}`,
                ``,
                `File is too large for a single read. Recommended strategies:`,
                ``,
                `1. grep_search — find specific content without reading the whole file:`,
                `   grep_search pattern="keyword" path="${args.path}"`,
                ``,
                `2. Read a specific range (streaming, no OOM risk at any file size):`,
                `   read_file path="${args.path}" start_line=1 end_line=1000`,
                ``,
                `3. Parallel sub-agents via spawn_agent (fastest for full coverage):`,
                `   Spawn ${N_AGENTS} agents, each reading a chunk of ${chunkSize ? chunkSize.toLocaleString() : '?'} lines:`,
                chunkHint,
                `   Each sub-agent summarises its chunk; main agent aggregates.`,
            ].join('\n');
        }

        // ── Normal path (file ≤ 10 MB) ────────────────────────────────────
        const { text } = readFileText(fp);
        if (args.start_line || args.end_line) {
            const lines = text.split('\n');
            const s = Math.max(0, (args.start_line || 1) - 1);
            const e = args.end_line || lines.length;
            return truncate(lines.slice(s, e).map((l, i) => `${s + i + 1}: ${l}`).join('\n'));
        }
        // Issue #142 P2-4: nudge the model toward sub-agents / ranged reads
        // for medium-large files that would otherwise burn a lot of context.
        if (fileSize > 50 * 1024) {
            const kb = Math.round(fileSize / 1024);
            const hint = `\n\n[hint] this file is ${kb} KB — consider \`spawn_agent\` (agent_type=explore) for analysis, or \`read_file\` with start_line/end_line to read a focused range, to save context.`;
            // Reserve hint length in the truncate budget so the combined output
            // still fits in MAX_OUTPUT_CHARS (Copilot review feedback).
            return truncate(text, MAX_OUTPUT_CHARS - hint.length) + hint;
        }
        return truncate(text);
    } catch (e) { return `Error: ${e.message}`; }
}

// ─── list_dir ────────────────────────────────────────────────────────────────

async function toolListDir(args) {
    try {
        const dp = resolvePath(args.path || '.');
        if (!await ensurePathAllowed(dp, 'read')) return t('blockedOutsideWs');
        const entries = fs.readdirSync(dp, { withFileTypes: true });
        return truncate(entries.map(e => e.isDirectory() ? e.name + '/' : e.name).join('\n') || '(empty)');
    } catch (e) { return `Error: ${e.message}`; }
}

// ─── grep_search (shell-injection-safe) ─────────────────────────────────────

async function toolGrepSearch(args) {
    try {
        const root = resolvePath(args.path || '.');
        if (!await ensurePathAllowed(root, 'read')) return t('blockedOutsideWs');
        const pattern = String(args.pattern || '');
        if (!pattern) return 'Error: pattern is required';

        // ripgrep applies .gitignore even to explicitly given paths, so a search
        // narrowed to an ignored location (.deep-copilot/logs, out/, tmp/) came
        // back as "(no matches)". Two ways to opt out:
        //   • include_ignored=true — blanket switch: ignore rules off everywhere,
        //     hidden directories included (.git stays excluded);
        //   • an explicit path that git itself ignores — the caller clearly
        //     targeted that location, so ignore rules are dropped for the call.
        const explicitPath = !!(args.path && String(args.path).trim() && String(args.path).trim() !== '.');
        const ignoreAware  = !!args.include_ignored || (explicitPath && _isIgnoredPath(root));

        let engine = '';
        const rg = rgPath();
        let r;
        if (rg) {
            engine = 'rg';
            const argv = ['--line-number', '--max-count', '10', '--max-filesize', '1M'];
            if (ignoreAware) argv.push('--no-ignore');
            if (args.include_ignored) argv.push('--hidden', '--glob', '!.git/**');
            if (!args.is_regex) argv.push('--fixed-strings');
            if (args.include) argv.push('--glob', String(args.include));
            argv.push('--', pattern, root);
            r = runArgv(rg, argv);
        } else if (!args.include_ignored && !args.include && _gitGrepUsable(root)) {
            engine = 'gitgrep';
            // git grep: .gitignore-aware and fast, but only tracks committed
            // files (guarded by _gitGrepUsable). Same path:line:text output
            // shape as ripgrep, so no extra formatting is needed.
            const argv = ['grep', '--line-number', '--max-count', '10'];
            if (!args.is_regex) argv.push('--fixed-strings');
            else argv.push('--extended-regexp'); // BRE treats \( as a group — use ERE to match findstr /r semantics
            argv.push('--', pattern, root);
            r = runArgv('git', argv);
        } else if (process.platform === 'win32') {
            engine = 'findstr';
            // findstr takes a file mask, not a bare path. Masks are resolved
            // against the cwd (wsRoot, set by runArgv), so relative masks keep
            // output paths consistent with the rg / git-grep branches. No /i:
            // findstr is then case-sensitive, matching rg and grep.
            const rel = path.relative(wsRoot(), root);
            const flags = ['/n'];
            let isDir = false;
            try { isDir = fs.statSync(root).isDirectory(); } catch { /* missing → bare mask below */ }
            let mask;
            if (isDir) {
                flags.push('/s'); // recursion only makes sense for a directory
                // findstr masks are per-directory globs (no **); /s recurses.
                mask = args.include ? path.join(rel, String(args.include)) : path.join(rel, '*');
            } else {
                // A single file must be passed as-is — the naive
                // path.join(root, '*') yields "file.js\*" that findstr cannot
                // open → silent "(no matches)". No /s either: recursion would
                // match same-named files in subdirectories.
                // A missing path also lands here: findstr errors to stderr,
                // stdout stays empty → "(no matches)" (searching the parent
                // dir would silently return unrelated hits instead).
                mask = rel;
            }
            if (args.is_regex) flags.push('/r');
            r = runArgv('findstr', flags.concat([`/c:${pattern}`, mask]));
        } else {
            engine = 'grep';
            const argv = ['-rn', '--max-count=10']; // per-file cap matches rg / git grep
            if (!args.is_regex) argv.push('-F');
            if (args.include) argv.push(`--include=${args.include}`);
            argv.push('--', pattern, root);
            r = runArgv('grep', argv);
        }

        if (r.error) return `Error: ${r.error.message}`;
        const out = (r.stdout || '').trim();
        if (!out) {
            // Without this note an ignore-rule miss is indistinguishable from a
            // genuine miss. Only the ignore-aware engines can produce one.
            const ignoreAwareEngine = engine === 'rg' || engine === 'gitgrep';
            const hint = (!ignoreAware && ignoreAwareEngine)
                ? '\n(hint: paths excluded by .gitignore — node_modules/, out/, tmp/, .deep-copilot/, *.log — were skipped; retry with include_ignored: true to search them)'
                : '';
            return '(no matches)' + hint;
        }
        return truncate(out.split(/\r?\n/).slice(0, 200).join('\n'));
    } catch (e) { return `Error: ${e.message}`; }
}

// ─── find_files ──────────────────────────────────────────────────────────────

async function toolFindFiles(args) {
    try {
        const root = resolvePath(args.path || '.');
        if (!await ensurePathAllowed(root, 'read')) return t('blockedOutsideWs');
        const pattern = String(args.pattern || '*');
        const max     = Math.max(1, Math.min(500, Number(args.max) || 100));

        const rg = rgPath();
        if (rg) {
            const r = runArgv(rg, ['--files', '--glob', pattern, '--max-filesize', '4M', '--', root]);
            if (r.error) return `Error: ${r.error.message}`;
            const lines = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean).slice(0, max);
            return truncate(lines.join('\n') || '(no matches)');
        }
        try {
            // Without rg, scope the search to `root` via RelativePattern —
            // vscode.workspace.findFiles(pattern) would search the whole
            // workspace and silently ignore the requested directory.
            // Normalize bare "*.js" to "**/*.js" (findFiles globs do not
            // cross "/", unlike rg's gitignore-style --glob).
            const glob = String(pattern).includes('/') || String(pattern).includes('\\')
                ? pattern
                : '**/' + pattern;
            const relPattern = new vscode.RelativePattern(root, glob);
            const uris = await vscode.workspace.findFiles(relPattern, '**/node_modules/**', max);
            // Match rg output shape: paths relative to the workspace root.
            const lines = uris.map(u => vscode.workspace.asRelativePath(u)).filter(Boolean).slice(0, max);
            return truncate(lines.join('\n') || '(no matches)');
        } catch (e) { return `Error: ${e.message}`; }
    } catch (e) { return `Error: ${e.message}`; }
}

// ─── get_diagnostics ────────────────────────────────────────────────────────

async function toolGetDiagnostics(args) {
    const sevName = s => ['Error', 'Warning', 'Info', 'Hint'][s] || 'Info';
    const lines = [];
    let totalErr = 0, totalWarn = 0;

    if (args && args.path) {
        let abs;
        try { abs = resolvePath(args.path); } catch (e) { return `Error: ${e.message}`; }
        const uri  = vscode.Uri.file(abs);
        const diags = vscode.languages.getDiagnostics(uri) || [];
        const errs  = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
        const warns = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Warning);
        totalErr = errs.length;
        totalWarn = warns.length;
        if (!totalErr && !totalWarn) return `No errors or warnings found in ${args.path}.`;
        lines.push(`- ${args.path}:`);
        // Count over the FULL array; slice only the lines to bound context.
        for (const d of [...errs, ...warns].slice(0, 10)) {
            const ln  = (d.range && d.range.start && d.range.start.line + 1) || '?';
            const src = d.source ? `[${d.source}] ` : '';
            const msg = String(d.message || '').replace(/\s+/g, ' ').slice(0, 200);
            lines.push(`  L${ln} ${sevName(d.severity)}: ${src}${msg}`);
        }
    } else {
        const all = vscode.languages.getDiagnostics();
        for (const [uri, diags] of all) {
            const errs  = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
            const warns = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Warning);
            if (!errs.length && !warns.length) continue;
            totalErr += errs.length;
            totalWarn += warns.length;
            const rel = vscode.workspace.asRelativePath(uri);
            lines.push(`- ${rel}:`);
            // Totals above use the full arrays; cap only the listed lines.
            for (const d of [...errs, ...warns].slice(0, 10)) {
                const ln  = (d.range && d.range.start && d.range.start.line + 1) || '?';
                const src = d.source ? `[${d.source}] ` : '';
                const msg = String(d.message || '').replace(/\s+/g, ' ').slice(0, 200);
                lines.push(`  L${ln} ${sevName(d.severity)}: ${src}${msg}`);
            }
        }
        if (!lines.length) return 'No errors or warnings found in workspace.';
    }
    return [`diagnostics: ${totalErr} error(s), ${totalWarn} warning(s)`, ...lines].join('\n');
}

module.exports = { toolReadFile, toolListDir, toolGrepSearch, toolFindFiles, toolGetDiagnostics, _gitGrepUsable, _isIgnoredPath, rgPath };
