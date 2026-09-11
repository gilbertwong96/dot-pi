/**
 * Command Code Provider Extension
 *
 * Registers the Command Code Provider API (https://api.commandcode.ai) as a
 * model provider. The model catalog is discovered from the upstream
 * `/v1/models` endpoint on demand (lazy refresh when the model picker is
 * opened); COMMANDCODE_OVERRIDES layers model-specific metadata on top of
 * what the upstream exposes, since the upstream only returns identity fields
 * and `context_length`.
 *
 * Use /login or the COMMANDCODE_API_KEY environment variable to authenticate
 * and /model to pick a model. Get an API key from Command Code Studio
 * (https://commandcode.ai/settings/keys).
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { fetchOpenAIModels, type NormalizedOpenAIModel } from './shared/openai-models'

const COMMANDCODE_BASE_URL = 'https://api.commandcode.ai/provider/v1'

export interface CommandCodeModelSpec {
  reasoning?: boolean
  input?: ('text' | 'image')[]
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  maxTokens?: number
  thinkingLevelMap?: Record<string, string | null>
  compat?: { supportsReasoningEffort?: boolean }
}

/**
 * Metadata overrides applied to known models on top of the auto-discovered
 * `context_length`. Add an entry when a model needs reasoning/image input,
 * specific max output, pricing, or thinking-level mapping that the upstream
 * /models endpoint does not expose.
 */
export const COMMANDCODE_OVERRIDES: Record<string, CommandCodeModelSpec> = {
  'deepseek/deepseek-v4-pro': {
    reasoning: true,
    input: ['text'],
    cost: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
    maxTokens: 384_000,
    thinkingLevelMap: {
      minimal: null,
      low: null,
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max'
    },
    compat: { supportsReasoningEffort: true }
  },
  'deepseek/deepseek-v4-flash': {
    reasoning: true,
    input: ['text'],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
    maxTokens: 384_000,
    thinkingLevelMap: {
      minimal: null,
      low: null,
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max'
    },
    compat: { supportsReasoningEffort: true }
  },
  'deepseek/deepseek-v4.1-flash': {
    reasoning: true,
    input: ['text'],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
    maxTokens: 384_000,
    thinkingLevelMap: {
      minimal: null,
      low: null,
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max'
    },
    compat: { supportsReasoningEffort: true }
  },
  'moonshotai/Kimi-K3': {
    input: ['text', 'image'],
    cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 0 },
    maxTokens: 128_000
  },
  'moonshotai/Kimi-K2.7-Code': {
    input: ['text', 'image'],
    cost: { input: 0.95, output: 4.0, cacheRead: 0.19, cacheWrite: 0 },
    maxTokens: 64_000
  },
  'moonshotai/Kimi-K2.7-Code-Highspeed': {
    input: ['text', 'image'],
    cost: { input: 1.9, output: 8.0, cacheRead: 0.38, cacheWrite: 0 },
    maxTokens: 64_000
  },
  'moonshotai/Kimi-K2.6': {
    input: ['text', 'image'],
    cost: { input: 0.95, output: 4.0, cacheRead: 0.16, cacheWrite: 0 },
    maxTokens: 64_000
  },
  'moonshotai/Kimi-K2.5': {
    input: ['text', 'image'],
    cost: { input: 0.6, output: 3.0, cacheRead: 0.1, cacheWrite: 0 },
    maxTokens: 64_000
  },
  'z-ai/glm-5.3-flash': {
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
    maxTokens: 131_072
  },
  'zai-org/GLM-5.3': {
    cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
    maxTokens: 64_000
  },
  'zai-org/GLM-5.2': {
    reasoning: true,
    cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
    maxTokens: 64_000
  },
  'zai-org/GLM-5.2-Fast': {
    cost: { input: 3.0, output: 10.25, cacheRead: 0.5, cacheWrite: 0 },
    maxTokens: 64_000
  },
  'zai-org/GLM-5.1': {
    cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
    maxTokens: 32_000
  },
  'zai-org/GLM-5': {
    cost: { input: 1.0, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
    maxTokens: 32_000
  }
}

const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_MAX_TOKENS = 8_192

interface CommandCodeBuildModel {
  id: string
  name: string
  reasoning: boolean
  input: ('text' | 'image')[]
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow: number
  maxTokens: number
  thinkingLevelMap?: Record<string, string | null>
  compat?: { supportsReasoningEffort?: boolean }
}

export function buildCommandCodeModel(entry: NormalizedOpenAIModel): CommandCodeBuildModel {
  const override = COMMANDCODE_OVERRIDES[entry.id] ?? {}
  const contextWindow = entry.context_length ?? DEFAULT_CONTEXT_WINDOW
  const maxTokens =
    typeof override.maxTokens === 'number'
      ? override.maxTokens
      : Math.min(contextWindow, DEFAULT_MAX_TOKENS)

  const result: CommandCodeBuildModel = {
    id: entry.id,
    name: entry.name,
    reasoning: override.reasoning ?? false,
    input: override.input ?? ['text'],
    cost: override.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens
  }

  if (override.thinkingLevelMap) result.thinkingLevelMap = override.thinkingLevelMap
  if (override.compat) result.compat = override.compat

  return result
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider('commandcode', {
    name: 'Command Code',
    baseUrl: COMMANDCODE_BASE_URL,
    apiKey: '$COMMANDCODE_API_KEY',
    api: 'openai-completions',
    models: [],
    async refreshModels(context) {
      if (context.credential?.type !== 'api_key') return []
      const apiKey = context.credential.key
      if (!apiKey) return []
      const remote = await fetchOpenAIModels(COMMANDCODE_BASE_URL, apiKey, {
        signal: context.signal,
        timeoutMs: 15_000
      })
      return remote.map(buildCommandCodeModel)
    }
  })
}
