// Adapter: thin routing layer between higher-level callers and the per-protocol
// API clients (OpenAI-compatible vs native Anthropic). All vendor/model data
// now lives in src/providers/*.json — consult `src/providers/index.js`.
'use strict';

const { streamChat: streamChatBase, fetchBalance } = require('./openai-client');
const { streamChat: streamChatAnthropic }          = require('./anthropic-client');

const {
    getProvider,
    getModel,
    getEffectiveQuirks,
    sanitizeMessages,
    resolveModel,
} = require('../providers');

const MODEL_CONFIG_DEFAULT = { contextWindow: 65536, maxOutputTokens: 16384 };

/**
 * Resolve everything `chat/provider.js` needs to issue a one-shot HTTP request
 * (connection test, balance refresh): protocol-level URL, the actual model id,
 * and the relevant quirks. Higher-level callers (`streamChat`) inline these
 * lookups themselves.
 */
function resolveProviderConfig(provider, overrideBaseUrl, overrideModel) {
    const p     = getProvider(provider) || getProvider('custom');
    const pid   = p ? p.id : (provider || 'deepseek');
    const model = resolveModel(pid, overrideModel);
    const cfg   = getModel(pid, model) || MODEL_CONFIG_DEFAULT;
    const quirks = getEffectiveQuirks(pid, model);
    // A user-set Base URL (`apiBaseUrl`) wins over the provider's built-in endpoint —
    // this is the documented behaviour (src/providers/_schema.json) and what the 🔑
    // dialog / README promise (e.g. mainland-China users point it at api.deepseeki.com).
    // The provider's own baseUrl is the fallback.
    return {
        baseUrl:                (overrideBaseUrl || '').trim() || p?.baseUrl || 'https://api.deepseek.com',
        model,
        noApiKey:               !!p?.noApiKey,
        streamOptions:          quirks.streamOptions !== false,
        parallelTools:          quirks.parallelTools !== false,
        useMaxCompletionTokens: !!quirks.useMaxCompletionTokens,
        testConnectionMaxTokens: quirks.testConnectionMaxTokens ?? null,
        balanceEndpoint:        quirks.balanceEndpoint || null,
        reasoningField:         quirks.reasoningField  || null,
        contextWindow:          cfg.contextWindow,
        maxOutputTokens:        cfg.maxOutputTokens,
    };
}

// ─── streamChat: the only routing entry point ────────────────────────────

function streamChat({ provider, apiKey, baseUrl, model, messages, ...rest }, callbacks, abortSignal) {
    const providerId = provider || 'deepseek';
    const p          = getProvider(providerId) || getProvider('custom');
    const pid        = p ? p.id : providerId;
    const effProtocol = p?.protocol || 'openai';
    const effModel    = resolveModel(pid, model);
    // Same precedence rule as `resolveProviderConfig`: a user-set Base URL wins over
    // the provider's built-in endpoint; the built-in one is the fallback.
    const effBaseUrl  = (baseUrl || '').trim() || p?.baseUrl || 'https://api.deepseek.com';
    const modelCfg    = getModel(pid, effModel) || MODEL_CONFIG_DEFAULT;
    const quirks      = getEffectiveQuirks(pid, effModel);

    // Apply provider-declared input sanitisation (e.g. DeepSeek strips
    // `reasoning_content` for non-reasoning models; reasoning models are exempt
    // because the API requires reasoning_content to be passed back each turn).
    const cleanMessages = sanitizeMessages(pid, messages, effModel);
    // This array is what the client puts on the wire; the request-level fields (stream,
    // tools, max_tokens) are added afterwards and sit behind it in the payload. Callers
    // that re-issue the very same request — history compaction replays it so DeepSeek
    // serves the prefix from its prompt cache — need this sanitised array, not the raw
    // input, which has not been through provider sanitisation yet.
    const withSentMessages = res => ({ ...(res || {}), sentMessages: cleanMessages });

    if (effProtocol === 'anthropic') {
        return streamChatAnthropic(
            {
                ...rest,
                apiKey:           apiKey || '',
                baseUrl:          effBaseUrl,
                model:            effModel,
                messages:         cleanMessages,
                maxOutputTokens:  modelCfg.maxOutputTokens,
            },
            callbacks,
            abortSignal,
        ).then(withSentMessages);
    }

    // OpenAI-compatible path (DeepSeek / OpenAI / Custom / etc.)
    const effApiKey = p?.noApiKey ? 'no-key' : (apiKey || '');
    return streamChatBase(
        {
            ...rest,
            apiKey:                effApiKey,
            baseUrl:               effBaseUrl,
            model:                 effModel,
            messages:              cleanMessages,
            streamOptions:         quirks.streamOptions !== false,
            parallelTools:         quirks.parallelTools !== false,
            useMaxCompletionTokens: !!quirks.useMaxCompletionTokens,
            reasoningField:        quirks.reasoningField || null,
            maxOutputTokens:       modelCfg.maxOutputTokens,
            // The caller's explicit effort (sub-agents pin low/high) wins; otherwise the
            // model's declared default applies. The value therefore goes out on every
            // request for this model, so the turn and the compaction that replays it
            // cannot drift apart -- and a drift is what costs the prompt cache.
            reasoningEffort:       rest.reasoningEffort || modelCfg.reasoningEffort || undefined,
        },
        callbacks,
        abortSignal,
    ).then(withSentMessages);
}

module.exports = {
    streamChat,
    fetchBalance,
    resolveProviderConfig,
};
