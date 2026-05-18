// read_terminal: serve the model the user's recent integrated-terminal output.
//
// Issue #99. Data sources, in priority order:
//   1. terminal-monitor buffer (executions already streamed by the
//      shell-integration listener).
//   2. The active terminal's `shellIntegration` (when available but the
//      monitor wasn't running yet — e.g. terminal opened pre-activation).
//   3. Structured error `shell_integration_unavailable` so the model can
//      give the user a one-time enable hint without polling.
'use strict';

const vscode = require('vscode');

const { truncate } = require('./utils');
const {
    getRecentExecutions,
    findTerminalByName,
    listTerminals,
} = require('./terminal-monitor');

const DEFAULT_MAX_BYTES = 16 * 1024;
const DEFAULT_LAST_N    = 3;

function _isCaptureEnabled() {
    try {
        const cfg = vscode.workspace.getConfiguration('deepseekAgent');
        return cfg.get('terminal.captureHistory', true) !== false;
    } catch { return true; }
}

function _formatExecution(rec, opts = {}) {
    const status = rec.running
        ? '[running]'
        : (rec.exitCode == null ? '[finished]' : `[exit ${rec.exitCode}]`);
    const cmd = rec.command || '<unknown command>';
    const cwd = rec.cwd ? ` cwd=${rec.cwd}` : '';
    const head = `--- terminal: ${rec.terminalName || '?'} ${status}${cwd}\n$ ${cmd}`;
    const body = rec.output ? rec.output : '(no output captured)';
    return `${head}\n${body}`;
}

async function toolReadTerminal(args = {}, ctx = {}) {
    if (!_isCaptureEnabled()) {
        return JSON.stringify({
            error: 'capture_disabled',
            hint:  'Terminal capture is disabled via deepseekAgent.terminal.captureHistory. Ask the user to re-enable it in Settings or paste the output manually.',
        });
    }

    const lastN     = Math.max(1, Math.min(20, parseInt(args.lastN, 10) || DEFAULT_LAST_N));
    const maxBytes  = Math.max(1024, Math.min(64 * 1024, parseInt(args.maxBytes, 10) || DEFAULT_MAX_BYTES));
    const includeRunning = args.includeRunning !== false;

    // Resolve target terminal
    let terminal;
    if (args.terminal && typeof args.terminal === 'string') {
        terminal = findTerminalByName(args.terminal);
        if (!terminal) {
            return JSON.stringify({
                error:    'terminal_not_found',
                requested: args.terminal,
                available: listTerminals().map(t => t.name).filter(Boolean),
            });
        }
    } else {
        terminal = vscode.window.activeTerminal;
    }

    if (!terminal) {
        return JSON.stringify({
            error: 'no_terminal',
            hint:  'No active integrated terminal. Ask the user to open one (`Terminal: Create New Terminal`) and re-run their command.',
        });
    }

    // Pull from monitor cache (primary source).
    let executions = getRecentExecutions(terminal, lastN);

    // Fallback: terminal opened before monitor, or monitor disabled at boot —
    // check if shellIntegration is at least present so we know whether to
    // surface a structured error or just an empty buffer.
    if (executions.length === 0) {
        const si = terminal.shellIntegration;
        if (!si) {
            return JSON.stringify({
                error:        'shell_integration_unavailable',
                terminalName: terminal.name || '',
                hint:         'The selected terminal does not have shell integration enabled, so DeepCopilot cannot read its output. Ask the user once to enable `terminal.integrated.shellIntegration.enabled` in VS Code Settings (it works automatically for bash/zsh/fish/pwsh; cmd.exe is not supported — recommend PowerShell). Do not ask again in this session.',
            });
        }
        return JSON.stringify({
            error:        'no_recent_executions',
            terminalName: terminal.name || '',
            hint:         'Shell integration is active but no recent commands have been captured yet. Ask the user to run the command again, or to confirm which terminal they meant.',
        });
    }

    if (!includeRunning) executions = executions.filter(e => !e.running);

    const summary = executions.map(_formatExecution).join('\n\n');
    return truncate(summary, maxBytes);
}

module.exports = { toolReadTerminal };
