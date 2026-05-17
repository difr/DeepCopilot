// Inline completion provider — DeepSeek FIM-powered "ghost text" suggestions.
//
// Issue #60. Off by default (`deepCopilot.inlineCompletion.enable`). When on,
// debounces idle keystrokes and calls DeepSeek's `/beta/completions` FIM
// endpoint to generate a single suggestion using the surrounding lines of the
// active document as prefix/suffix context.
//
// Design notes:
//   - Silent failure: any API error returns no item (never throws to the UI).
//   - Hard caps on prefix/suffix bytes so a huge file does not blow up the
//     request. We trim to the nearest line boundary to avoid mid-token cuts.
//   - Uses an AbortController per-request; the previous request is cancelled
//     as soon as the user types another character.
'use strict';

const vscode = require('vscode');

const { Logger } = require('../logger');
const { fimComplete } = require('../api/deepseek');

const MAX_PREFIX_CHARS = 4000;
const MAX_SUFFIX_CHARS = 2000;
const MAX_COMPLETION_TOKENS = 64;

function trimToLineBoundary(text, maxLen, fromEnd) {
    if (text.length <= maxLen) return text;
    if (fromEnd) {
        // Keep the last maxLen chars, then drop the partial first line.
        const slice = text.slice(text.length - maxLen);
        const idx = slice.indexOf('\n');
        return idx >= 0 ? slice.slice(idx + 1) : slice;
    }
    // Keep the first maxLen chars, then drop the partial last line.
    const slice = text.slice(0, maxLen);
    const idx = slice.lastIndexOf('\n');
    return idx >= 0 ? slice.slice(0, idx + 1) : slice;
}

function registerInlineCompletionProvider(context) {
    let inFlight = null; // { ac: AbortController, token: vscode.CancellationToken }

    const provider = {
        async provideInlineCompletionItems(document, position, ctx, token) {
            try {
                const cfg = vscode.workspace.getConfiguration('deepCopilot.inlineCompletion');
                if (!cfg.get('enable')) return null;

                // Skip when user has multi-selection / non-empty selection — they are editing,
                // not requesting completion.
                const editor = vscode.window.activeTextEditor;
                if (editor && !editor.selection.isEmpty) return null;

                // Debounce idle period. If another keystroke arrives before the
                // delay elapses, the editor cancels this token and we bail.
                const debounceMs = Math.max(0, cfg.get('debounceMs') || 300);
                if (debounceMs > 0) {
                    await new Promise((r) => setTimeout(r, debounceMs));
                    if (token.isCancellationRequested) return null;
                }

                // Resolve API key. Reuse the same secret slot as the chat agent
                // so the user only configures the key once.
                const apiKey = await context.secrets.get('deepseekAgent.apiKey');
                if (!apiKey) return null;

                const baseUrl = vscode.workspace.getConfiguration('deepseekAgent').get('baseUrl')
                    || 'https://api.deepseek.com';
                const model   = vscode.workspace.getConfiguration('deepseekAgent').get('model')
                    || 'deepseek-chat';

                const fullText = document.getText();
                const offset   = document.offsetAt(position);
                const prefix   = trimToLineBoundary(fullText.slice(0, offset), MAX_PREFIX_CHARS, true);
                const suffix   = trimToLineBoundary(fullText.slice(offset),    MAX_SUFFIX_CHARS, false);

                // Cancel any previous in-flight request — we only want a
                // completion for the most recent cursor position.
                if (inFlight) { try { inFlight.ac.abort(); } catch {} }
                const ac = new AbortController();
                inFlight = { ac };
                token.onCancellationRequested(() => { try { ac.abort(); } catch {} });

                const text = await fimComplete(
                    { apiKey, baseUrl, model, prefix, suffix, maxTokens: MAX_COMPLETION_TOKENS },
                    ac.signal,
                );
                inFlight = null;

                if (!text || token.isCancellationRequested) return null;

                // Trim trailing newline-only fragments — they add noise and the
                // user can press Enter themselves.
                const cleaned = text.replace(/\s+$/, '');
                if (!cleaned) return null;

                return { items: [{ insertText: cleaned, range: new vscode.Range(position, position) }] };
            } catch (e) {
                Logger.info('INLINE_COMPLETION_ERROR', { message: (e && e.message) || String(e) });
                return null;
            }
        },
    };

    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider),
    );
    Logger.info('INLINE_COMPLETION_REGISTERED');
}

module.exports = { registerInlineCompletionProvider };
