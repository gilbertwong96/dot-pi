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
        contextWindow: 1000000,
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
          thinkingFormat: 'deepseek'
        }
      }
    ]
  })
}
