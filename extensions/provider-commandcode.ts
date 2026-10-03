/**
 * Command Code Provider Extension
 *
 * Registers the Command Code Provider API (https://api.commandcode.ai) as a
 * model provider.
 *
 * Catalog behavior mirrors pi-ollama-cloud:
 *   - COMMANDCODE_CATALOG is a baked-in snapshot of upstream `/v1/models`
 *     (regenerate with `node scripts/generate-commandcode-catalog.mjs`). The
 *     upstream is the only source of `context_length`, and pi reads the
 *     provider before `refreshModels` runs at session start, so the seed has to
 *     carry the real context windows instead of the 128K default.
 *   - `refreshModels` rehydrates that snapshot, or the catalog persisted by a
 *     previous session, in its cache-only phase and persists a fresh fetch, so
 *     a session normally never falls back to the generated file.
 *
 * COMMANDCODE_OVERRIDES layers model-specific metadata on top of what the
 * upstream exposes, since the upstream only returns identity fields and
 * `context_length`. The upstream exposes no capability metadata, so reasoning
 * support and the per-model `reasoning_effort` values are pinned from
 * measurements: `scripts/probe-commandcode-capabilities.mjs` re-runs the probe.
 * Claude is only served through the Anthropic Messages shape, so those models
 * carry an `api`/`baseUrl` override.
 *
 * Use /login or the COMMANDCODE_API_KEY environment variable to authenticate
 * and /model to pick a model. Get an API key from Command Code Studio
 * (https://commandcode.ai/settings/keys).
 */

import type { RefreshModelsContext } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ProviderModelConfig } from '@earendil-works/pi-coding-agent'

import { COMMANDCODE_CATALOG } from './provider-commandcode-catalog.generated'
import { fetchOpenAIModels, type NormalizedOpenAIModel } from './shared/openai-models'

const COMMANDCODE_BASE_URL = 'https://api.commandcode.ai/provider/v1'
/** pi's Anthropic client appends /v1/messages to the base URL. */
const COMMANDCODE_ANTHROPIC_BASE_URL = 'https://api.commandcode.ai/provider'

/**
 * pi thinking level to `reasoning_effort`. The gateway rejects `none` and
 * `minimal`, so `off` and `minimal` have no representable value and stay
 * hidden in the level picker.
 */
const THINKING_LEVELS: ProviderModelConfig['thinkingLevelMap'] = {
  off: null,
  minimal: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max'
}

/**
 * Models that answered with `reasoning_tokens` in the 2026-09-13 probe. The
 * last thirteen were not callable on the probe's plan, so they are inferred
 * from their model family.
 */
const REASONING_MODEL_IDS: ReadonlySet<string> = new Set([
  'MiniMaxAI/MiniMax-M2.5',
  'MiniMaxAI/MiniMax-M2.7',
  'MiniMaxAI/MiniMax-M3',
  'Qwen/Qwen3.6-Max-Preview',
  'Qwen/Qwen3.6-Plus',
  'Qwen/Qwen3.7-Flash',
  'Qwen/Qwen3.7-Max',
  'Qwen/Qwen3.7-Plus',
  'Qwen/Qwen3.8-27B',
  'Qwen/Qwen3.8-Flash',
  'Qwen/Qwen3.8-Max',
  'Qwen/Qwen3.8-Max-0902',
  'Qwen/Qwen3.8-Omni-Flash',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-flash-fast',
  'deepseek/deepseek-v4-flash-vision-exp',
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4.1-flash',
  'google/gemini-3.1-flash-lite',
  'google/gemini-3.5-flash',
  'google/gemini-3.5-flash-lite',
  'google/gemini-3.6-flash',
  'google/gemini-3.7-flash',
  'google/gemini-3.8-flash',
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.5',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-6-astra',
  'gpt-6-luna',
  'gpt-6-sol',
  'inclusionai/ling-3.0-flash-sante:free',
  'meituan/LongCat-2.0',
  'meta/muse-spark-1.1',
  'meta/muse-spark-1.2',
  'meta/muse-spark-1.2-contributor',
  'meta/muse-spark-1.3',
  'meta/muse-spark-1.3-contributor',
  'moonshotai/Kimi-K2.6',
  'moonshotai/Kimi-K2.7-Code',
  'moonshotai/Kimi-K2.7-Code-Highspeed',
  'moonshotai/Kimi-K3',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'poolside/laguna-s-2.1-free',
  'sakana/fugu-ultra',
  'stepfun/Step-3.5-Flash',
  'stepfun/Step-3.7-Flash',
  'stepfun/Step-5-Preview',
  'tencent/hy3-paid',
  'tencent/hy4-preview',
  'thinkingmachines/inkling',
  'thinkingmachines/inkling-small',
  'xai/grok-4.5',
  'xai/grok-4.6',
  'xai/grok-4.7',
  'xiaomi/mimo-v2.5',
  'xiaomi/mimo-v2.5-pro',
  'xiaomi/mimo-v2.6-flash',
  'xiaomi/mimo-v2.6-pro',
  'xiaomi/mimo-v2.6-pro-ultraspeed',
  'z-ai/glm-5.3-flash',
  'z-ai/glm-5.3-flashx',
  'zai-org/GLM-5.1',
  'zai-org/GLM-5.2',
  'zai-org/GLM-5.2-Fast',
  'zai-org/GLM-5.3'
])

/**
 * Models whose upstream rejects an individual level. The Qwen 3.6/3.7 and
 * Kimi K2.7 upstreams stop at `xhigh`, `tencent/hy4-preview` rejects `max` with
 * an internal MaaS error, and Kimi K2.7 Code HighSpeed rejects `medium` with
 * "invalid moonshotai provider options".
 */
const THINKING_LEVEL_EXCEPTIONS: Record<string, ProviderModelConfig['thinkingLevelMap']> = {
  'Qwen/Qwen3.6-Plus': { max: null },
  'Qwen/Qwen3.7-Max': { max: null },
  'Qwen/Qwen3.7-Plus': { max: null },
  'moonshotai/Kimi-K2.7-Code': { max: null },
  'moonshotai/Kimi-K2.7-Code-Highspeed': { medium: null },
  'tencent/hy4-preview': { max: null }
}

/**
 * Claude is only reachable through the Anthropic Messages shape; calling
 * /chat/completions answers `must be called via /provider/v1/messages`. Level
 * metadata mirrors pi's built-in catalog for the same upstream models.
 */
const CLAUDE_MODELS: Record<string, CommandCodeClaudeSpec> = {
  'claude-fable-5': {
    maxTokens: 128_000,
    thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' },
    forceAdaptiveThinking: true
  },
  'claude-fable-5-1': {
    maxTokens: 128_000,
    thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' },
    forceAdaptiveThinking: true
  },
  'claude-haiku-4-5-20251001': { maxTokens: 64_000 },
  'claude-opus-4-7': {
    maxTokens: 128_000,
    thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
    forceAdaptiveThinking: true
  },
  'claude-opus-4-8': {
    maxTokens: 128_000,
    thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
    forceAdaptiveThinking: true
  },
  'claude-opus-5': {
    maxTokens: 128_000,
    thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' },
    forceAdaptiveThinking: true
  },
  'claude-opus-5-5': {
    maxTokens: 128_000,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max'
    },
    forceAdaptiveThinking: true
  },
  'claude-sonnet-4-6': {
    maxTokens: 128_000,
    thinkingLevelMap: { max: 'max' },
    forceAdaptiveThinking: true
  },
  'claude-sonnet-5': {
    maxTokens: 128_000,
    thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
    forceAdaptiveThinking: true
  },
  'claude-sonnet-5-5': {
    maxTokens: 128_000,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max'
    },
    forceAdaptiveThinking: true
  }
}

interface CommandCodeClaudeSpec {
  maxTokens: number
  thinkingLevelMap?: ProviderModelConfig['thinkingLevelMap']
  forceAdaptiveThinking?: boolean
}

export interface CommandCodeModelSpec {
  input?: ('text' | 'image')[]
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  maxTokens?: number
}

/**
 * Metadata overrides applied to known models on top of the auto-discovered
 * `context_length`. Add an entry when a model needs image input, specific max
 * output, or pricing that the upstream /models endpoint does not expose.
 * Reasoning support is derived from REASONING_MODEL_IDS, not from this table.
 */
export const COMMANDCODE_OVERRIDES: Record<string, CommandCodeModelSpec> = {
  'deepseek/deepseek-v4-pro': {
    input: ['text'],
    cost: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
    maxTokens: 384_000
  },
  'deepseek/deepseek-v4-flash': {
    input: ['text'],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
    maxTokens: 384_000
  },
  'deepseek/deepseek-v4.1-flash': {
    input: ['text', 'image'],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
    maxTokens: 384_000
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
    input: ['text', 'image'],
    cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
    maxTokens: 131_072
  },
  'zai-org/GLM-5.3': {
    cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
    maxTokens: 64_000
  },
  'zai-org/GLM-5.2': {
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

/** Skip a network fetch while the persisted catalog is this fresh (mirrors pi's remote catalog provider). */
const REFRESH_COOLDOWN_MS = 4 * 60 * 60 * 1000
/**
 * pi's model selector aborts a catalog refresh after 15s, so a cold fetch has to
 * fit inside that budget or the first picker-open misses the fresh list.
 */
const CATALOG_FETCH_TIMEOUT_MS = 15_000

interface CommandCodeBuildModel {
  id: string
  name: string
  api?: 'anthropic-messages'
  baseUrl?: string
  reasoning: boolean
  input: ('text' | 'image')[]
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow: number
  maxTokens: number
  thinkingLevelMap?: ProviderModelConfig['thinkingLevelMap']
  compat?: ProviderModelConfig['compat']
}

export function buildCommandCodeModel(entry: NormalizedOpenAIModel): CommandCodeBuildModel {
  const override = COMMANDCODE_OVERRIDES[entry.id] ?? {}
  const claude = CLAUDE_MODELS[entry.id]
  const contextWindow = entry.context_length ?? DEFAULT_CONTEXT_WINDOW
  const maxTokens =
    claude?.maxTokens ??
    (typeof override.maxTokens === 'number'
      ? override.maxTokens
      : Math.min(contextWindow, DEFAULT_MAX_TOKENS))

  const result: CommandCodeBuildModel = {
    id: entry.id,
    name: entry.name,
    reasoning: false,
    input: override.input ?? ['text'],
    cost: override.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens
  }

  if (claude) {
    result.api = 'anthropic-messages'
    result.baseUrl = COMMANDCODE_ANTHROPIC_BASE_URL
    result.reasoning = true
    result.input = ['text', 'image']
    if (claude.thinkingLevelMap) result.thinkingLevelMap = claude.thinkingLevelMap
    if (claude.forceAdaptiveThinking) {
      result.compat = { forceAdaptiveThinking: true, supportsTemperature: false }
    }
    return result
  }

  if (REASONING_MODEL_IDS.has(entry.id)) {
    result.reasoning = true
    result.thinkingLevelMap = { ...THINKING_LEVELS, ...THINKING_LEVEL_EXCEPTIONS[entry.id] }
    result.compat = { supportsReasoningEffort: true }
  }

  return result
}

/**
 * The catalog this provider ships, so a registry that enumerates the provider
 * at start-up sees it — `refreshModels` only fills the list once a refresh
 * runs, which leaves a provider with `models: []` (and therefore no resolvable
 * models) to anything that reads the registry at session start.
 *
 * COMMANDCODE_CATALOG is the upstream snapshot and already contains every model
 * the hand-maintained tables reference; the union keeps those metadata entries
 * resolvable if a regeneration drops one upstream.
 */
export function knownCommandCodeModels(): NormalizedOpenAIModel[] {
  const byId = new Map(COMMANDCODE_CATALOG.map((entry) => [entry.id, entry]))
  for (const id of [
    ...Object.keys(COMMANDCODE_OVERRIDES),
    ...Object.keys(CLAUDE_MODELS),
    ...REASONING_MODEL_IDS
  ]) {
    if (!byId.has(id)) byId.set(id, { id, name: id })
  }
  return [...byId.values()]
}

/**
 * The `refreshModels` callback pi invokes for "commandcode". Pi calls it twice
 * per refresh: a restore phase (`allowNetwork: false`) before auth resolution,
 * then a network phase (`allowNetwork: true`) once a credential resolves. The
 * composer swaps the return value into the model list on every invocation, so
 * this must always return a usable catalog — never `[]` — and must persist what
 * it fetched, or the next session starts from the seed again.
 */
export async function refreshCommandCodeCatalog(
  context: RefreshModelsContext
): Promise<ProviderModelConfig[]> {
  const fallback = context.stored?.models.length
    ? [...context.stored.models]
    : knownCommandCodeModels().map(buildCommandCodeModel)

  if (!context.allowNetwork || context.signal.aborted) return fallback

  const checkedAt = context.stored?.checkedAt
  if (!context.force && checkedAt !== undefined && Date.now() - checkedAt < REFRESH_COOLDOWN_MS) {
    return fallback
  }

  const credential = context.credential
  if (credential?.type !== 'api_key' || !credential.key) return fallback

  let remote: NormalizedOpenAIModel[]
  try {
    remote = await fetchOpenAIModels(COMMANDCODE_BASE_URL, credential.key, {
      signal: context.signal,
      timeoutMs: CATALOG_FETCH_TIMEOUT_MS
    })
  } catch (error) {
    // An aborted refresh keeps the last good catalog; anything else propagates so
    // pi reports it and keeps the previous list.
    if (context.signal.aborted) return fallback
    throw error
  }
  if (context.signal.aborted) return fallback

  const models = remote.map(buildCommandCodeModel)
  // Guard: an empty result must not be published or persisted, or it would leave
  // the provider with no models for the duration of the cooldown.
  if (models.length === 0) return fallback

  // The store is typed to pi-ai's internal Model shape, so rehydrate the
  // provider identity fields that the composer otherwise fills in.
  const persisted = models.map((model) => ({
    ...model,
    provider: 'commandcode',
    api: model.api ?? 'openai-completions',
    baseUrl: model.baseUrl ?? COMMANDCODE_BASE_URL
  }))

  // Best-effort persistence: the in-memory list already updates from the return
  // value, so a rejected or failed store write must not lose the fresh catalog.
  try {
    const published = await context.publish({
      persist: { models: persisted, checkedAt: Date.now() }
    })
    if (!published) console.warn('[commandcode] Catalog persist rejected (refresh superseded).')
  } catch {
    // Ignored: the catalog above is still returned.
  }

  return persisted
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider('commandcode', {
    name: 'Command Code',
    baseUrl: COMMANDCODE_BASE_URL,
    apiKey: '$COMMANDCODE_API_KEY',
    api: 'openai-completions',
    models: knownCommandCodeModels().map(buildCommandCodeModel),
    refreshModels: refreshCommandCodeCatalog
  })
}
