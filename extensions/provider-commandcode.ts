/**
 * Command Code Provider Extension
 *
 * Registers the Command Code Provider API (https://api.commandcode.ai) as a
 * model provider. All models route through the OpenAI-compatible endpoint,
 * so use /login (or the COMMANDCODE_API_KEY environment variable) to
 * authenticate and /model to pick a model.
 *
 * Get an API key from Command Code Studio (https://commandcode.ai/settings/keys).
 *
 * Cost fields are 0 because the model catalog does not expose pricing.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

function model(id: string, name: string, contextWindow: number, maxTokens: number) {
  return {
    id,
    name,
    reasoning: true,
    input: ['text', 'image'] as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    compat: { supportsReasoningEffort: true }
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider('commandcode', {
    name: 'Command Code',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    apiKey: '$COMMANDCODE_API_KEY',
    api: 'openai-completions',
    models: [
      model('deepseek/deepseek-v4-pro', 'DeepSeek V4 Pro', 1000000, 384000),
      model('deepseek/deepseek-v4-flash', 'DeepSeek V4 Flash', 1000000, 384000),
      model('moonshotai/Kimi-K3', 'Kimi K3', 1000000, 128000),
      model('moonshotai/Kimi-K2.7-Code', 'Kimi K2.7 Code', 256000, 64000),
      model('moonshotai/Kimi-K2.7-Code-Highspeed', 'Kimi K2.7 Code HighSpeed', 262000, 64000),
      model('moonshotai/Kimi-K2.6', 'Kimi K2.6', 256000, 64000),
      model('moonshotai/Kimi-K2.5', 'Kimi K2.5', 256000, 64000),
      model('zai-org/GLM-5.3', 'GLM-5.3', 1000000, 64000),
      model('zai-org/GLM-5.2', 'GLM-5.2', 1000000, 64000),
      model('zai-org/GLM-5.2-Fast', 'GLM-5.2 Fast', 1000000, 64000),
      model('zai-org/GLM-5.1', 'GLM-5.1', 200000, 32000),
      model('zai-org/GLM-5', 'GLM-5', 200000, 32000)
    ]
  })
}
