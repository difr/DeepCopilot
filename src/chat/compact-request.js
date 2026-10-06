// CompactRequest: the one place that spells out the request shape a turn and every compaction
// path have to share.
//
// The provider keys its prompt cache on the whole request, so compaction can only ride the
// cached prefix when its system prompt and tool set match the turn's exactly. Both callers
// assemble their requests here because they drifted apart: the manual path kept sending MCP
// tools after the turn had been told to omit them, and it never went silent in ask mode.
//
// Dependencies: tools/schema, utils/settings. Callers own the message history and the snapshot.
'use strict';

const { getToolDefs } = require('../tools/schema');
const { str } = require('../utils/settings');

// The mode the whole extension agrees on. It picks the system prompt and, in ask mode, decides
// whether tools travel at all, so a second spelling of this formula is a cache miss waiting to
// happen. The tool executor reads it too, for its plan-mode guard.
const DEFAULT_INTERACTION_MODE = 'agent';

function resolveInteractionMode(cfg) {
    return str(cfg.get('interactionMode')) || DEFAULT_INTERACTION_MODE;
}

// The system prompt a turn sends. `prompts/system` is required lazily: it reads workspace state,
// and a caller that only wants the tool set should not pay for that.
function chatSystemPrompt(mode) {
    const { buildSystemPrompt } = require('../prompts/system');
    return buildSystemPrompt({ includeWorkspaceInstructions: true, mode });
}

// The tool set the turn carries, and therefore the one compaction must carry too: none in ask
// mode (`noTools`), and MCP tools only when the user allows them (issue #142 P2-3).
function chatToolDefs({ noTools, includeMcpTools = true, mcpDefs }) {
    if (noTools) return null;
    return getToolDefs(includeMcpTools ? (mcpDefs || []) : []);
}

// The settings-driven half of the tool set. Callers pass the collected MCP definitions because
// only they know when the servers have finished connecting.
function chatToolsFromSettings({ cfg, noTools, mcpDefs }) {
    return chatToolDefs({ noTools, includeMcpTools: cfg.get('includeMcpTools', true), mcpDefs });
}

function buildCompactApiConfig({ apiKey, baseUrl, model, provider, focus, systemPrompt, tools, lastRequestMessages }) {
    return {
        apiKey, baseUrl, model, provider, focus,
        prefixMessages: [{ role: 'system', content: systemPrompt }],
        // A null tool set means "no tools field at all" downstream, which is what the turn
        // sends in ask mode.
        tools,
        lastRequestMessages: lastRequestMessages || undefined,
    };
}

module.exports = {
    chatToolDefs,
    chatToolsFromSettings,
    chatSystemPrompt,
    resolveInteractionMode,
    buildCompactApiConfig,
};
