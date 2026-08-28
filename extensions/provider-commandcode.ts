/**
 * Command Code Provider Extension
 *
 * Registers the Command Code Provider API (https://api.commandcode.ai) as a
 * model provider. All models route through the OpenAI-compatible endpoint,
 * so use /login (or the COMMANDCODE_API_KEY environment variable) to
 * authenticate and /model to pick a model.
 *
 * Get an API key from Command Code Studio (https://commandcode.ai/settings/keys).
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

interface ModelSpec {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  reasoning?: boolean
  input?: ('text' | 'image')[]
}

const MODEL_SPECS: ModelSpec[] = [
  {
    id: 'deepseek/deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    contextWindow: 1000000,
    maxTokens: 384000,
    cost: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
    reasoning: true
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    contextWindow: 1000000,
    maxTokens: 384000,
    cost: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
    reasoning: true
  },
  {
    id: 'moonshotai/Kimi-K3',
    name: 'Kimi K3',
    contextWindow: 1000000,
    maxTokens: 128000,
    cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 0 },
    input: ['text', 'image']
  },
  {
    id: 'moonshotai/Kimi-K2.7-Code',
    name: 'Kimi K2.7 Code',
    contextWindow: 256000,
    maxTokens: 64000,
    cost: { input: 0.95, output: 4.0, cacheRead: 0.19, cacheWrite: 0 },
    input: ['text', 'image']
  },
  {
    id: 'moonshotai/Kimi-K2.7-Code-Highspeed',
    name: 'Kimi K2.7 Code HighSpeed',
    contextWindow: 262000,
    maxTokens: 64000,
    cost: { input: 1.9, output: 8.0, cacheRead: 0.38, cacheWrite: 0 },
    input: ['text', 'image']
  },
  {
    id: 'moonshotai/Kimi-K2.6',
    name: 'Kimi K2.6',
    contextWindow: 256000,
    maxTokens: 64000,
    cost: { input: 0.95, output: 4.0, cacheRead: 0.16, cacheWrite: 0 },
    input: ['text', 'image']
  },
  {
    id: 'moonshotai/Kimi-K2.5',
    name: 'Kimi K2.5',
    contextWindow: 256000,
    maxTokens: 64000,
    cost: { input: 0.6, output: 3.0, cacheRead: 0.1, cacheWrite: 0 },
    input: ['text', 'image']
  },
  {
    id: 'z-ai/glm-5.3-flash',
    name: 'GLM-5.3 Flash',
    contextWindow: 1048576,
    maxTokens: 131072,
    cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
    reasoning: true,
    input: ['text', 'image']
  },
  {
    id: 'zai-org/GLM-5.3',
    name: 'GLM-5.3',
    contextWindow: 1000000,
    maxTokens: 64000,
    cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 }
  },
  {
    id: 'zai-org/GLM-5.2',
    name: 'GLM-5.2',
    contextWindow: 1000000,
    maxTokens: 64000,
    cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
    reasoning: true
  },
  {
    id: 'zai-org/GLM-5.2-Fast',
    name: 'GLM-5.2 Fast',
    contextWindow: 1000000,
    maxTokens: 64000,
    cost: { input: 3.0, output: 10.25, cacheRead: 0.5, cacheWrite: 0 }
  },
  {
    id: 'zai-org/GLM-5.1',
    name: 'GLM-5.1',
    contextWindow: 200000,
    maxTokens: 32000,
    cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 }
  },
  {
    id: 'zai-org/GLM-5',
    name: 'GLM-5',
    contextWindow: 200000,
    maxTokens: 32000,
    cost: { input: 1.0, output: 3.2, cacheRead: 0.2, cacheWrite: 0 }
  }
]

export default function (pi: ExtensionAPI) {
  pi.registerProvider('commandcode', {
    name: 'Command Code',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    apiKey: '$COMMANDCODE_API_KEY',
    api: 'openai-completions',
    models: MODEL_SPECS.map((spec) => ({
      id: spec.id,
      name: spec.name,
      reasoning: spec.reasoning ?? false,
      input: spec.input ?? ['text'],
      cost: spec.cost,
      contextWindow: spec.contextWindow,
      maxTokens: spec.maxTokens,
      ...(spec.reasoning
        ? {
            thinkingLevelMap: {
              minimal: null,
              low: null,
              medium: null,
              high: 'high',
              xhigh: null,
              max: 'max'
            },
            compat: { supportsReasoningEffort: true }
          }
        : {})
    }))
  })
}
