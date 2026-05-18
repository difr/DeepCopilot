// Shared helpers used by multiple tool modules.
// - truncate: cap output to bound LLM context spend
// - ensurePathAllowed: workspace boundary enforcement (with user-approval cache)
//
// Keep this file small — only add things needed by ≥2 tool sub-modules.
'use strict';

const vscode = require('vscode');
const { t } = require('../utils/i18n');

// ─── Output truncation ───────────────────────────────────────────────────────

const MAX_OUTPUT = 32000;

function truncate(text, max = MAX_OUTPUT) {
    if (typeof text !== 'string') text = String(text);
    if (text.length <= max) return text;
    const headLen = Math.floor(max * 0.6);
    const tailLen = Math.floor(max * 0.3);
    const dropped = text.length - headLen - tailLen;
    return `${text.slice(0, headLen)}\n\n... [${dropped} chars truncated] ...\n\n${text.slice(text.length - tailLen)}`;
}

// ─── Workspace boundary ──────────────────────────────────────────────────────
// Paths approved for out-of-workspace access are cached per extension session.
// The set survives reloads but not a full VS Code restart.

const _outsideWsApprovals = new Set();

async function ensurePathAllowed(absPath, intent /* 'read' | 'write' */) {
    const { isInsideWorkspace } = require('../utils/paths');
    if (isInsideWorkspace(absPath)) return true;
    if (_outsideWsApprovals.has(absPath)) return true;

    // Issue #94: the extension's own skill directories live outside the
    // workspace by design (~/.deepcopilot/skills, ~/.claude/skills,
    // ~/.copilot/skills). Reads from them are part of normal operation and
    // must not trigger an approval dialog. Writes are still gated below.
    //
    // Containment is checked with `path.relative` (not string-prefix) so that
    // `..` segments inside `absPath` cannot escape the whitelisted dirs and
    // platform-specific normalization (case-insensitive comparison on Windows,
    // drive-letter handling) is delegated to Node.
    if (intent === 'read') {
        try {
            const path = require('path');
            const { SKILL_DIRS } = require('../skills');
            const resolved = path.resolve(absPath);
            for (const dir of SKILL_DIRS) {
                const base = path.resolve(dir);
                const rel = path.relative(base, resolved);
                if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
                    return true;
                }
            }
        } catch { /* skills module unavailable — fall through to normal flow */ }
    }

    // In autopilot mode silently allow all out-of-workspace access —
    // the user has already granted blanket approval by choosing that mode.
    const mode = vscode.workspace.getConfiguration('deepseekAgent').get('approvalMode') || 'manual';
    if (mode === 'autopilot') {
        _outsideWsApprovals.add(absPath);
        return true;
    }

    try {
        const choice = await vscode.window.showWarningMessage(
            `${t('pathOutsideWsConfirm')}\n\n${absPath}\n\n(${intent})`,
            { modal: true },
            t('dangerAllowOnce'),
            t('dangerDeny'),
        );
        if (choice === t('dangerAllowOnce')) {
            _outsideWsApprovals.add(absPath);
            return true;
        }
    } catch { /* fall through */ }
    return false;
}

module.exports = { truncate, ensurePathAllowed };
