// User-visible UI strings for Deep Copilot — English only.
//
// Everything the user can see lives here so wording stays consistent across
// the extension host, the webview template, and the tools. `t(key)` returns
// the string, `tf(key, params)` additionally substitutes {placeholder} tokens.
'use strict';

const STRINGS = {
    // ── API key / base URL ────────────────────────────────────────────────
    apiKeyPrompt:       'Enter your API key (stored in VS Code SecretStorage, never written to settings.json)',
    apiKeySaved:        'Deep Copilot: API key saved.',
    apiKeyDeleted:      'Deep Copilot: API key deleted.',
    apiKeyMissing:      'Set your API key first — click the key icon in the toolbar.',
    baseUrlIntl:        'International (default)',
    baseUrlCustom:      'Custom...',
    baseUrlClear:       'Clear (use default)',
    baseUrlEnter:       'Enter an OpenAI-compatible Base URL',
    baseUrlSet:         'Deep Copilot: Base URL = ',
    baseUrlCurrent:     'Current: ',
    baseUrlDefault:     'default (international)',
    baseUrlDefaultNote: '(default international)',
    firstRunInstalled:  'Deep Copilot is installed. Set your API key to get started.',
    firstRunSetKey:     'Set API Key',
    firstRunLater:      'Later',
    statusBarTooltip:   'Click to open Deep Copilot',

    // ── Tavily key (web_search) ───────────────────────────────────────────
    tavilyKeyPrompt:  'Enter your Tavily API key (for web_search; get one at https://app.tavily.com — 1000 free searches/month)',
    tavilyKeySaved:   'Deep Copilot: Tavily API key saved.',
    tavilyKeyRemoved: 'Deep Copilot: Tavily API key deleted.',

    // ── "API settings" quick pick ─────────────────────────────────────────
    apiStatusTitle:         'Deep Copilot · API Settings',
    apiStatusPlaceholder:   'Pick an item to configure (Esc to close)',
    apiStatusApiKey:        'API key',
    apiStatusRequired:      '(required)',
    apiStatusApiKeyDetail:  'Powers chat and tool calls · get one at platform.deepseek.com/api_keys',
    apiStatusTavily:        'Tavily API key',
    apiStatusOptional:      '(optional)',
    apiStatusTavilyDetail:  'Turns on the web_search tool · app.tavily.com (1000 free/month)',
    apiStatusConfigured:    'Configured · ',
    apiStatusNotSet:        'Not set',
    apiStatusNotSetSearch:  'Not set (web_search disabled)',
    apiStatusBaseUrl:       'Base URL',
    apiStatusBaseUrlDetail: 'Works with any OpenAI-compatible endpoint',
    apiStatusCurrent:       'Current config',
    apiStatusCurrentDetail: 'Model: {model} · Approval mode: {mode} (change in VS Code settings)',

    // ── Standalone builds (no server, no terminal UI) ─────────────────────
    standaloneNoServer: 'Deep Copilot runs standalone — there is no backend server to restart.',
    standaloneNoTui:    'Deep Copilot has no separate terminal UI — the chat opens in a VS Code tab.',

    // ── Debug log ─────────────────────────────────────────────────────────
    logFileLabel:    'Log file: ',
    logOpenInEditor: 'Open in Editor',
    logCopyPath:     'Copy Path',
    logRevealInOS:   'Reveal in File Explorer',
    logPathCopied:   'Log path copied.',
    logNotInit:      'Log not initialized yet (send a message first).',

    // ── Approval prompts ──────────────────────────────────────────────────
    approvalRequest:      'Deep Copilot wants to: ',
    approvalApprove:      'Approve',
    approvalDeny:         'Deny',
    deniedByUser:         'Denied by user.',
    dangerCmdTitle:       'Deep Copilot wants to run a potentially destructive command:',
    dangerAllowOnce:      'Allow once',
    dangerDeny:           'Deny',
    dangerBlocked:        'Blocked: command flagged as potentially destructive and the user declined to approve it. Do NOT retry the same command. Explain to the user what you intended and ask whether to proceed, or propose a safer alternative.',
    blockedOutsideWs:     'Blocked: path is outside the workspace and was not approved.',
    pathOutsideWsConfirm: 'Deep Copilot wants to access a path outside the workspace:',
    deniedReadonly:       'Denied: Read-Only mode is active.',
    writeFileLabel:       'Write file: ',
    runCmdLabel:          'Run: ',
    createSkillLabel:     'Create skill: ',
    sessionUntitled:      'Untitled',

    // ── Error cards ───────────────────────────────────────────────────────
    errTitle:      'Request failed',
    errTitle401:   'Invalid or expired API Key',
    errTip401:     'Click the 🔑 button and enter your API key again. Make sure the key has not expired or been disabled.',
    errTitle402:   'Insufficient account balance',
    errTip402:     'Top up your account and try again.',
    errTitle429:   'Rate limit exceeded',
    errTip429:     'You have hit the provider rate limit. Wait a few seconds and click Retry.',
    errTitle400:   'Bad request',
    errTip400:     'The context may be too long or the message format may be invalid. Try clearing the session (Ctrl+K) and retrying.',
    errTitle5xx:   'Service error',
    errTip5xx:     'Server returned {code}. This is usually a temporary issue — retry in a few seconds.',
    errNetwork:    'Network connection failed',
    errTipNetwork: 'Cannot reach the API. Check your network, proxy, or firewall settings.',
    errAborted:    'Generation stopped',
    errTipAborted: 'Generation was interrupted by the user.',

    // ── Webview (chat panel) ──────────────────────────────────────────────
    wvWelcomeSub:        'Open, fair, and accessible AI productivity for all',
    wvWelcomeHint:       'Type a message and press Enter to send',
    wvSessions:          'Sessions',
    wvWorkspace:         'Workspace',
    wvWorkspaceTitle:    'Show only current workspace sessions',
    wvAll:               'All',
    wvSearchPlaceholder: 'Search sessions...',
    wvNewSession:        'New Session',
    wvNoSessions:        'No sessions',
    wvThinking:          '● ● ● Thinking...',
    wvInputPlaceholder:  'Describe what you want to build',
    wvSend:              'Send',
    wvApiTitle:          'API settings · DeepSeek / Tavily / Base URL',
    wvCacheTitle:        'Prompt cache hit rate (higher = cheaper)',
    wvSwitchModel:       'Switch model',
    wvApprovalMode:      'Approval Mode',
    wvInteractionMode:   'Interaction Mode',
    wvBalanceTitle:      'Account balance (click to refresh)',
    wvBalanceInit:       '💰 Checking...',

    // Pending-edits panel (review agent-authored writes before keep/discard)
    wvPendingEditsTitle:      'Pending edits',
    wvPendingEditsKeep:       'Keep',
    wvPendingEditsKeepAll:    'Keep all',
    wvPendingEditsDiscard:    'Discard',
    wvPendingEditsDiscardAll: 'Discard all',
    wvPendingEditsNew:        'new',
    wvPendingEditsDeleted:    'deleted',
    wvPendingEditsBinary:     'binary',

    // Sidebar launcher hint page — shown in the left activity-bar view.
    sidebarHintLead:     'For the best experience, open Deep Copilot as an editor tab',
    sidebarHintBenefit1: 'Larger, dedicated chat area',
    sidebarHintBenefit2: 'Left activity bar free for Explorer, Git & more',
    sidebarHintButton:   'Open now',
    sidebarHintFooter:   '⊙ Or click Deep Copilot in the status bar below',

    // ── In-flight status lines ────────────────────────────────────────────
    // The bracketed `[Note: ...]` prefix is a stable marker token the LLM is
    // instructed (via tools/schema.js) to detect; keep it identical verbatim.
    shellNoOutput:          '[Note: no output for last {sec}s]',
    shellSilentTimeout:     '[Note: process was silent for last {sec}s before timeout — likely hung (e.g. port in use, waiting for input, blocked on external resource). Do NOT retry blindly; report the situation to the user.]',
    statusAutoResumed:      '🔔 Auto-resumed ({trigger})',
    statusCompacting:       '🗜 Compacting history…',
    statusEmergencyCompact: '⚠️ Context near limit — emergency compaction applied…',
    statusNuclearCompact:   '🔥 Nuclear compaction applied ({before}K→{after}K tokens)…',
    statusSuspended:        '💤 Suspended: {reason} ({count} watcher(s) armed)',

    // ── Session archive → Markdown export (issue #165) ────────────────────
    archiveSaved:         'Session archived to {path}',
    archiveFailed:        'Deep Copilot: failed to archive session — {msg}',
    archiveOpenFile:      'Open File',
    archiveRevealInOS:    'Reveal in Explorer',
    archiveSaveLabel:     'Save Archive',
    archivePickWorkspace: 'Pick a workspace folder to save the archive into',
    archiveErrEscape:     'Refused to write archive: resolved path is outside the workspace.',
    archiveOpenFailed:    'Could not open the archived file — {msg}',
    archiveRoleUser:      'User',
    archiveRoleAssistant: 'Assistant',
    archiveThoughtsLabel: 'Reasoning',
};

function t(key) {
    return STRINGS[key] != null ? STRINGS[key] : key;
}

// Formatted variant of t() — substitutes {placeholder} tokens with values
// from params. Use for strings that need runtime values interpolated.
function tf(key, params) {
    let s = t(key);
    if (params) {
        for (const k of Object.keys(params)) {
            s = s.split('{' + k + '}').join(String(params[k]));
        }
    }
    return s;
}

module.exports = { t, tf };
