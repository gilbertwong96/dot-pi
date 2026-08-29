/**
 * B.AI Provider Extension
 *
 * Registers the B.AI gateway (https://api.b.ai) as a model provider so its
 * models can be used as pi main/fallback models. B.AI exposes an
 * OpenAI-compatible endpoint, so all models route through openai-completions.
 *
 * Set B_AI_API_KEY environment variable, or use /login and sign in with an
 * API key. Get a key from the B.AI API Key management page (https://chat.b.ai).
 *
 * Cost fields are 0 because B.AI bills in platform Credits, which do not map
 * to USD.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function (pi: ExtensionAPI) {
  pi.registerProvider('bai', {
    name: 'B.AI',
    baseUrl: 'https://api.b.ai/v1',
    apiKey: '$B_AI_API_KEY',
    api: 'openai-completions',
    models: [
      {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        // Docs advertise 1M context, but the serving layer rejects inputs above
        // ~256K ("Input token exceed the limit", quota_limit_reached). Declare the
        // real window so pi auto-compacts before hitting it.
        contextWindow: 256000,
        maxTokens: 384000,
        thinkingLevelMap: {
          minimal: null,
          low: 'low',
          medium: null,
          high: 'high',
          max: 'max'
        },
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          // B.AI is a DeepSeek-family API but its base URL isn't api.deepseek.com,
          // so pi-ai's auto-detection misses it. Without this, assistant messages
          // that lack thinking blocks are replayed without reasoning_content and
          // B.AI rejects the request with 400.
          requiresReasoningContentOnAssistantMessages: true,
          thinkingFormat: 'deepseek'
        }
      },
      {
        id: 'glm-5.3-flash',
        name: 'GLM-5.3 Flash',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 131072,
        // Thinking is always on; only reasoning_effort changes (low/high/max).
        // No thinkingFormat: the default branch sends reasoning_effort without a
        // thinking field, matching the always-enabled semantics. off is hidden
        // because reasoning_effort 'none' is not supported.
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: 'low',
          medium: null,
          high: 'high',
          xhigh: 'max'
        },
        compat: {
          supportsReasoningEffort: true,
          // B.AI rejects the developer role (400001 角色信息不正确); the system
          // role must be used instead. Without this, pi sends the system prompt
          // as developer for reasoning models and B.AI rejects the request.
          supportsDeveloperRole: false
        }
      }
    ]
  })
}
