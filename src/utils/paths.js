// Workspace path helpers.
'use strict';

const vscode = require('vscode');
const path = require('path');
const os = require('os');

function wsRoot() {
    const f = vscode.workspace.workspaceFolders;
    return (f && f[0] && f[0].uri.fsPath) || os.homedir();
}

/**
 * Expand a leading "~" (or "~/", "~\") to the user's home directory.
 * Returns the original string when no expansion applies. We intentionally
 * do NOT support "~user" since Node has no portable accessor for it.
 * Issue #94: paths from skill discovery / synthetic injections may carry
 * a literal "~" prefix, and `path.isAbsolute` returns false for those on
 * Windows, causing them to be joined with the workspace root incorrectly.
 */
function expandHome(p) {
    if (typeof p !== 'string' || !p) return p;
    if (p === '~') return os.homedir();
    if (p.startsWith('~/') || p.startsWith('~\\')) {
        return path.join(os.homedir(), p.slice(2));
    }
    return p;
}

function resolvePath(p) {
    if (!p) return wsRoot();
    const expanded = expandHome(p);
    if (path.isAbsolute(expanded)) return expanded;
    return path.join(wsRoot(), expanded);
}

/**
 * Determine whether `absPath` is inside the workspace root (or equal to it).
 * Uses path.relative + safe start checks so symbolic resolution does not
 * matter — we only consider lexical containment, since following symlinks
 * to escape the workspace is itself a signal we want to flag.
 */
function isInsideWorkspace(absPath) {
    const root = wsRoot();
    if (!root) return false;
    const rel = path.relative(root, absPath);
    if (!rel) return true; // exact root
    if (rel.startsWith('..')) return false;
    if (path.isAbsolute(rel)) return false; // different drive on Windows
    return true;
}

module.exports = { wsRoot, resolvePath, isInsideWorkspace, expandHome };
