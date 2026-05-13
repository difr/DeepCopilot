// run_shell: execute a shell command with dangerous-command guard.
'use strict';

const cp     = require('child_process');
const vscode = require('vscode');

const { wsRoot } = require('../utils/paths');
const { t }      = require('../utils/i18n');
const { truncate } = require('./utils');

// ─── Dangerous-command detection ─────────────────────────────────────────────

const DANGEROUS_PATTERNS = [
    /\brm\s+-rf?\b/i,
    /\brmdir\s+\/s\b/i,
    /\bRemove-Item\b[^\n]*-Recurse/i,
    /\bdel\s+\/[fsq]/i,
    /\bgit\s+push\b[^\n]*--force\b/i,
    /\bgit\s+push\b[^\n]*\s-f(\s|$)/i,
    /\bgit\s+reset\s+--hard\b/i,
    /\bgit\s+clean\s+-[fdx]+\b/i,
    /\bgit\s+branch\s+-D\b/i,
    /\bdrop\s+(table|database|schema)\b/i,
    /\btruncate\s+table\b/i,
    /\bmkfs\b/, /\bdd\s+if=/i, /\bshutdown\b/i, /\breboot\b/i,
    /\bnpm\s+publish\b/i,
    /\bcurl\b[^|]*\|\s*(sh|bash|pwsh|powershell)/i,
    /\biwr\b[^|]*\|\s*iex\b/i,
    /Invoke-Expression\b/i,
    /:\s*\(\)\s*\{.*:\|:&\s*\}/,
];

function isDangerous(cmd) {
    return DANGEROUS_PATTERNS.some(re => re.test(cmd));
}

async function confirmDangerous(cmd, abortSignal) {
    const dialog = vscode.window.showWarningMessage(
        `${t('dangerCmdTitle')}\n\n${cmd}`,
        { modal: true },
        t('dangerAllowOnce'),
        t('dangerDeny'),
    );
    if (!abortSignal) return (await dialog) === t('dangerAllowOnce');
    return new Promise((resolve) => {
        let settled = false;
        const onAbort = () => { if (settled) return; settled = true; resolve(false); };
        if (abortSignal.aborted) return onAbort();
        abortSignal.addEventListener('abort', onAbort, { once: true });
        dialog.then(
            (choice) => {
                if (settled) return; settled = true;
                try { abortSignal.removeEventListener('abort', onAbort); } catch {}
                resolve(choice === t('dangerAllowOnce'));
            },
            () => { if (settled) return; settled = true; resolve(false); },
        );
    });
}

// ─── run_shell ───────────────────────────────────────────────────────────────
//
// Streams stdout/stderr chunks via ctx.onStreamDelta(delta) as they arrive,
// enabling the webview to render a live tail of the running command
// (GitHub Copilot terminal-card convention).  Returns the final combined
// output string (truncated) just like the original spawnSync implementation.

async function toolRunShell(args, ctx = {}) {
    const command = args.command || '';
    if (isDangerous(command)) {
        const allowed = await confirmDangerous(command, ctx.abortSignal);
        if (!allowed) return `${t('dangerBlocked')}\n\nCommand: ${command}`;
    }

    const MAX_BUF       = 10 * 1024 * 1024;
    const timeoutMs     = args.timeout_ms || 30000;
    const onStreamDelta = typeof ctx.onStreamDelta === 'function' ? ctx.onStreamDelta : null;
    const abortSignal   = ctx.abortSignal;

    return new Promise((resolve) => {
        let proc;
        try {
            proc = cp.spawn(command, [], {
                cwd: wsRoot(),
                shell: true,
                windowsHide: true,
                env: process.env,
            });
        } catch (e) { return resolve(`Error: ${e.message}`); }

        let stdoutBuf = '';
        let stderrBuf = '';
        let combinedSize = 0;
        let killedByTimeout = false;
        let killedByAbort   = false;
        let settled         = false;

        const settle = (val) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (abortSignal && onAbort) {
                try { abortSignal.removeEventListener('abort', onAbort); } catch {}
            }
            resolve(val);
        };

        const timer = setTimeout(() => {
            killedByTimeout = true;
            try { proc.kill('SIGTERM'); } catch {}
        }, timeoutMs);

        const onAbort = () => {
            killedByAbort = true;
            try { proc.kill('SIGTERM'); } catch {}
        };
        if (abortSignal) {
            if (abortSignal.aborted) onAbort();
            else abortSignal.addEventListener('abort', onAbort, { once: true });
        }

        const append = (which, chunk) => {
            const txt = chunk.toString('utf8');
            if (combinedSize + txt.length > MAX_BUF) {
                // truncate hard once we exceed buffer; keep reading silently
                if (which === 'out') stdoutBuf += txt.slice(0, Math.max(0, MAX_BUF - combinedSize));
                else                  stderrBuf += txt.slice(0, Math.max(0, MAX_BUF - combinedSize));
                combinedSize = MAX_BUF;
            } else {
                if (which === 'out') stdoutBuf += txt;
                else                  stderrBuf += txt;
                combinedSize += txt.length;
            }
            if (onStreamDelta) {
                try { onStreamDelta(txt); } catch {}
            }
        };

        proc.stdout && proc.stdout.on('data', (c) => append('out', c));
        proc.stderr && proc.stderr.on('data', (c) => append('err', c));

        proc.on('error', (err) => settle(`Error: ${err.message}`));

        proc.on('close', (code, signal) => {
            const stdout = stdoutBuf.replace(/\s+$/, '');
            const stderr = stderrBuf.replace(/\s+$/, '');
            if (killedByAbort)   return settle('Error: aborted by user');
            if (killedByTimeout) return settle(truncate(`Error: command timed out after ${timeoutMs}ms\n${stdout}${stderr ? '\n--- stderr ---\n' + stderr : ''}`));
            const exitCode = (code == null && signal) ? `signal:${signal}` : code;
            if (exitCode !== 0) return settle(truncate(`Exit ${exitCode}: ${stderr || stdout || '(no output)'}`));
            if (!stdout && !stderr) return settle('(no output, exit 0)');
            if (!stdout && stderr)  return settle(truncate(`(stdout empty, exit 0)\n--- stderr ---\n${stderr}`));
            return settle(truncate(stderr ? `${stdout}\n--- stderr ---\n${stderr}` : stdout));
        });
    });
}

module.exports = { toolRunShell, isDangerous };
