// Context-reference resolvers for the `#` picker in the chat input.
//
// Each resolver returns an attachment-shaped payload:
//   { path, content, startLine?, endLine?, lang? }
//
// The `path` field acts as a label for the chip *and* as the path attribute
// on the <attachment …> block sent to the model. For synthetic refs that do
// not point to a real file (diagnostics, git diff, terminal, fetch, …) we
// use angle-bracketed identifiers like `<diagnostics>` so the model can tell
// them apart from real file paths.
//
// Security:
//   - `file` is handled by the existing `fileContent` flow in provider.js
//     (which already validates paths via resolvePath / isInsideWorkspace).
//   - `fetch` defers to src/tools/web-fetch.js which enforces SSRF blocklists.
//   - `terminal` returns only what VS Code's public API exposes (no shell
//     history scraping); when the API is unavailable the chip resolves to a
//     short placeholder string instead of failing.
'use strict';

const vscode = require('vscode');
const path   = require('path');
const cp     = require('child_process');

const { wsRoot, isInsideWorkspace } = require('../utils/paths');
const { toolWebFetch } = require('../tools/web-fetch');

const MAX_CONTENT = 64 * 1024;

function truncate(s, max = MAX_CONTENT) {
    if (typeof s !== 'string') s = String(s == null ? '' : s);
    if (s.length <= max) return s;
    return s.slice(0, max) + '\n... [truncated]';
}

// ── selection / editor ────────────────────────────────────────────────

function resolveSelection() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return { error: 'No active editor' };
    const doc = editor.document;
    const sel = editor.selection;
    if (sel.isEmpty) return { error: 'No text selected in the active editor' };

    const abs  = doc.fileName;
    const root = wsRoot();
    const rel  = root && abs.startsWith(root)
        ? path.relative(root, abs).replace(/\\/g, '/')
        : path.basename(abs);
    return {
        path:      rel,
        content:   truncate(doc.getText(sel), 12000),
        startLine: sel.start.line + 1,
        endLine:   sel.end.line + 1,
        lang:      doc.languageId,
    };
}

function resolveEditor() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return { error: 'No active editor' };
    const doc = editor.document;
    const abs = doc.fileName;
    if (doc.uri.scheme === 'file' && !isInsideWorkspace(abs)) {
        return { error: 'Active file is outside the workspace' };
    }
    const root = wsRoot();
    const rel  = root && abs.startsWith(root)
        ? path.relative(root, abs).replace(/\\/g, '/')
        : path.basename(abs);
    return {
        path:    rel,
        content: truncate(doc.getText()),
        lang:    doc.languageId,
    };
}

// ── diagnostics ───────────────────────────────────────────────────────

function resolveProblems() {
    const root = wsRoot();
    const all  = vscode.languages.getDiagnostics();
    const sevName = { 0: 'error', 1: 'warning', 2: 'info', 3: 'hint' };
    const lines = [];
    let count = 0;
    for (const [uri, diags] of all) {
        if (!diags.length) continue;
        const rel = root && uri.fsPath.startsWith(root)
            ? path.relative(root, uri.fsPath).replace(/\\/g, '/')
            : uri.fsPath;
        for (const d of diags) {
            const ln = d.range.start.line + 1;
            const col = d.range.start.character + 1;
            const sev = sevName[d.severity] || 'info';
            const src = d.source ? `${d.source}` : '';
            lines.push(`${rel}:${ln}:${col} [${sev}] ${src ? src + ': ' : ''}${d.message}`);
            count++;
            if (count >= 200) break;
        }
        if (count >= 200) break;
    }
    if (!lines.length) return { error: 'No problems in the current workspace' };
    return {
        path:    '<problems>',
        content: truncate(lines.join('\n')),
    };
}

// ── git ───────────────────────────────────────────────────────────────

function gitDiff() {
    return new Promise(resolve => {
        const root = wsRoot();
        if (!root) return resolve({ error: 'No workspace folder' });
        cp.execFile('git', ['diff', '--no-color', '--', '.'], { cwd: root, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
            if (err) return resolve({ error: `git diff failed: ${err.message}` });
            const out = (stdout || '').toString();
            if (!out.trim()) return resolve({ error: 'No unstaged changes' });
            resolve({ path: '<git-changes>', content: truncate(out) });
        });
    });
}

// ── terminal (best-effort) ────────────────────────────────────────────

async function resolveTerminal() {
    const term = vscode.window.activeTerminal;
    if (!term) return { error: 'No active terminal' };
    // VS Code does not expose terminal scrollback via the public API. We grab
    // the current terminal selection if available, otherwise return a marker
    // line so the model knows the user *intended* to share terminal context.
    let buffer = '';
    try {
        // executeCommand returns void/clipboard text depending on version.
        // We attempt copySelection → read clipboard, and restore.
        const prev = await vscode.env.clipboard.readText().catch(() => '');
        await vscode.commands.executeCommand('workbench.action.terminal.copySelection').then(() => {}, () => {});
        const sel  = await vscode.env.clipboard.readText().catch(() => '');
        // restore previous clipboard content
        if (prev !== sel) await vscode.env.clipboard.writeText(prev).catch(() => {});
        buffer = sel || '';
    } catch { /* ignore */ }
    if (!buffer.trim()) {
        return { error: 'Select text in the terminal first, then re-attach #terminal' };
    }
    return {
        path:    '<terminal>',
        content: truncate(buffer, 32 * 1024),
    };
}

// ── workspace symbol ──────────────────────────────────────────────────

async function resolveSymbol(query) {
    const q = String(query || '').trim();
    if (!q) return { error: 'Provide a symbol name, e.g. #symbol:MyClass' };
    let syms = [];
    try {
        syms = await vscode.commands.executeCommand(
            'vscode.executeWorkspaceSymbolProvider', q
        );
    } catch (e) {
        return { error: `Symbol search failed: ${e.message}` };
    }
    if (!syms || !syms.length) return { error: `No symbol matched "${q}"` };
    const root  = wsRoot();
    const lines = syms.slice(0, 20).map(s => {
        const uri = s.location && s.location.uri;
        const ln  = (s.location && s.location.range && s.location.range.start.line + 1) || 1;
        const rel = uri && root && uri.fsPath.startsWith(root)
            ? path.relative(root, uri.fsPath).replace(/\\/g, '/')
            : (uri ? uri.fsPath : '?');
        return `${rel}:${ln}  ${s.kind != null ? '[' + vscode.SymbolKind[s.kind] + ']' : ''} ${s.name}${s.containerName ? '  (' + s.containerName + ')' : ''}`;
    });
    return {
        path:    `<symbol:${q}>`,
        content: lines.join('\n'),
    };
}

// ── fetch ─────────────────────────────────────────────────────────────

async function resolveFetch(url, abortSignal) {
    const u = String(url || '').trim();
    if (!u) return { error: 'Provide a URL, e.g. #fetch:https://example.com' };
    const body = await toolWebFetch({ url: u }, { abortSignal });
    if (typeof body === 'string' && body.startsWith('Error:')) {
        return { error: body.slice('Error:'.length).trim() };
    }
    return {
        path:    `<fetch:${u}>`,
        content: truncate(body, 32 * 1024),
    };
}

// ── dispatch ──────────────────────────────────────────────────────────

const KNOWN_REFS = ['selection', 'editor', 'problems', 'changes', 'terminal', 'symbol', 'fetch'];

async function resolveContextRef(refType, value, ctx = {}) {
    switch (refType) {
        case 'selection': return resolveSelection();
        case 'editor':    return resolveEditor();
        case 'problems':  return resolveProblems();
        case 'changes':   return await gitDiff();
        case 'terminal':  return await resolveTerminal();
        case 'symbol':    return await resolveSymbol(value);
        case 'fetch':     return await resolveFetch(value, ctx.abortSignal);
        default:          return { error: `Unknown ref type: ${refType}` };
    }
}

module.exports = { resolveContextRef, KNOWN_REFS };
