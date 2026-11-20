/**
 * Command Code model metadata shared by the provider that speaks the Provider
 * API (`provider-commandcode.ts`) and the one that speaks the CLI's
 * `/alpha/generate` transport (`provider-commandcode-go.ts`).
 *
 * The upstream models endpoint only returns identity fields, so everything a
 * model needs beyond its id — reasoning support, the per-model output limit,
 * whether it accepts images, the Anthropic-only shape for Claude — is pinned
 * here from measurements. `scripts/probe-commandcode-capabilities.mjs` re-runs
 * the probe that produced the reasoning tables.
 */

import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent'

import { COMMANDCODE_CATALOG } from '../provider-commandcode-catalog.generated'
import type { NormalizedOpenAIModel } from './openai-models'

/** Pi 1.5 declares provider models as a chat/image/classifier union; Command Code serves chat. */
export type CommandCodeModelConfig = Extract<ProviderModelConfig, { type?: 'chat' }>

export const COMMANDCODE_BASE_URL = 'https://api.commandcode.ai/provider/v1'
/** pi's Anthropic client appends /v1/messages to the base URL. */
export const COMMANDCODE_ANTHROPIC_BASE_URL = 'https://api.commandcode.ai/provider'

/**
 * pi thinking level to `reasoning_effort`. The gateway rejects `none` and
 * `minimal` outright, so neither has a representable value. `off` is only
 * representable for the models that can turn thinking off, which the gateway
 * names in its own rejection (see THINKING_LEVEL_EXCEPTIONS).
 */
const THINKING_LEVELS: CommandCodeModelConfig['thinkingLevelMap'] = {
  off: null,
  minimal: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max'
}

/**
 * Models that answered with `reasoning_tokens` in the 2026-11-16 probe. The
 * three this account cannot call — gemini-4-carbon and gpt-6.1-terra are gated by
 * its plan, muse-ember is refused by region — are inferred from their model
 * family. `ornith/ornith-1.5-122b` accepts every effort but reports no reasoning
 * tokens, so it stays out.
 */
export const REASONING_MODEL_IDS: ReadonlySet<string> = new Set([
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
  'deepseek/deepseek-v4.1-flash-fast',
  'deepseek/deepseek-v4.1-flash-ultrafast',
  'google/gemini-3.1-flash-lite',
  'google/gemini-3.5-flash',
  'google/gemini-3.5-flash-lite',
  'google/gemini-3.6-flash',
  'google/gemini-3.7-flash',
  'google/gemini-3.8-flash',
  'google/gemini-4-carbon',
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
  'gpt-6.1-terra',
  'inclusionai/ling-3.0-flash-sante:free',
  'inclusionai/ling-3.1-flash-1019',
  'meituan/LongCat-2.0',
  'meta/muse-ember',
  'meta/muse-spark-1.1',
  'meta/muse-spark-1.2',
  'meta/muse-spark-1.2-contributor',
  'meta/muse-spark-1.3',
  'meta/muse-spark-1.3-contributor',
  'minimax/minimax-m3.1-flash',
  'moonshotai/Kimi-K2.6',
  'moonshotai/Kimi-K2.7-Code',
  'moonshotai/Kimi-K2.7-Code-Highspeed',
  'moonshotai/Kimi-K3',
  'moonshotai/Kimi-K3.1-Pro',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'sakana/fugu-ultra',
  'stepfun/Step-3.5-Flash',
  'stepfun/Step-3.7-Flash',
  'stepfun/Step-5-Preview',
  'tencent/hy3-paid',
  'tencent/hy4-preview',
  'thinkingmachines/inkling',
  'thinkingmachines/inkling-2-small:free',
  'thinkingmachines/inkling-small',
  'xai/grok-4.5',
  'xai/grok-4.6',
  'xai/grok-4.7',
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
 * Models that expose a different level set than the gateway accepts. The gateway
 * validates `reasoning_effort` against its own enum
 * (`off|low|medium|high|xhigh|max`), so it answers 200 for a level the upstream
 * does not distinguish — probing acceptance alone cannot find these, only
 * comparing generated reasoning does. The Qwen 3.6/3.7 and Kimi K2.7 upstreams
 * stop at `xhigh`, `tencent/hy4-preview` rejects `max` with an internal MaaS
 * error, and Kimi K2.7 Code HighSpeed rejects `medium` with "invalid moonshotai
 * provider options".
 *
 * `off` is the one level the gateway gates per model: it answers 400 "Only
 * models that can turn thinking off accept it", which is how the DeepSeek ids
 * below were picked out. `deepseek-v4-flash-fast` is the family's exception — it
 * rejects `off` — and no non-DeepSeek model accepts it.
 *
 * DeepSeek V4.1 Flash accepts `low`, `medium` and `high` but does not separate
 * them: 8 probes per level on `deepseek-v4.1-flash-ultrafast` gave medians of
 * 870, 1082 and 867 reasoning tokens over ranges that all overlap 466-1942,
 * while `xhigh` and `max` sit an order of magnitude higher and keep hitting the
 * completion cap. `medium` and `xhigh` therefore stay hidden.
 */
const THINKING_LEVEL_EXCEPTIONS: Record<string, CommandCodeModelConfig['thinkingLevelMap']> = {
  'Qwen/Qwen3.6-Plus': { max: null },
  'Qwen/Qwen3.7-Max': { max: null },
  'Qwen/Qwen3.7-Plus': { max: null },
  'deepseek/deepseek-v4-flash': { off: 'off' },
  'deepseek/deepseek-v4-flash-vision-exp': { off: 'off' },
  'deepseek/deepseek-v4-pro': { off: 'off' },
  'deepseek/deepseek-v4.1-flash': { off: 'off', medium: null, xhigh: null },
  'deepseek/deepseek-v4.1-flash-fast': { off: 'off', medium: null, xhigh: null },
  'deepseek/deepseek-v4.1-flash-ultrafast': { off: 'off', medium: null, xhigh: null },
  'moonshotai/Kimi-K2.7-Code': { max: null },
  'moonshotai/Kimi-K2.7-Code-Highspeed': { medium: null },
  'tencent/hy4-preview': { max: null }
}

/**
 * Claude is only reachable through the Anthropic Messages shape; calling
 * /chat/completions answers `must be called via /provider/v1/messages`. Level
 * metadata mirrors pi's built-in catalog for the same upstream models, and the
 * Fable models are all off this account's plan, so they cannot be re-probed:
 * claude-fable-5-2, which pi's catalog predates, inherits from claude-fable-5.
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
  'claude-fable-5-2': {
    maxTokens: 128_000,
    thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' },
    forceAdaptiveThinking: true
  },
  'claude-haiku-4-5-20251001': { maxTokens: 64_000 },
  'claude-haiku-5-5': {
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
  thinkingLevelMap?: CommandCodeModelConfig['thinkingLevelMap']
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
 *
 * A `maxTokens` entry is the model's native output limit. The provider counts the
 * completion against the same `context_length` as the prompt (see
 * buildCommandCodeModel), so an allowance this large only stays legal because
 * clampCompletionBudget cuts it back to the room the prompt leaves. The deepseek
 * family accepts 393_216 (probed 2026-10), matching what Ollama Cloud ships for the
 * same model.
 *
 * The `-fast`, `-ultrafast` and vision deepseek variants take their output limit
 * from here too, but their cost stays unset: the upstream exposes no pricing and
 * there is nothing measured to fill in.
 */
export const COMMANDCODE_OVERRIDES: Record<string, CommandCodeModelSpec> = {
  'deepseek/deepseek-v4-pro': {
    input: ['text'],
    cost: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
    maxTokens: 393_216
  },
  'deepseek/deepseek-v4-flash': {
    input: ['text'],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
    maxTokens: 393_216
  },
  'deepseek/deepseek-v4-flash-fast': { maxTokens: 393_216 },
  'deepseek/deepseek-v4-flash-vision-exp': { maxTokens: 393_216 },
  'deepseek/deepseek-v4.1-flash': {
    input: ['text', 'image'],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
    maxTokens: 393_216
  },
  'deepseek/deepseek-v4.1-flash-fast': { maxTokens: 393_216 },
  'deepseek/deepseek-v4.1-flash-ultrafast': { maxTokens: 393_216 },
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

export const DEFAULT_CONTEXT_WINDOW = 128_000
export const DEFAULT_MAX_TOKENS = 8_192
/**
 * Floor for the input window an override may leave, so a model whose completion
 * allowance approaches its whole budget still advertises a readable window.
 */
export const MIN_INPUT_WINDOW = 1_024

/** Skip a network fetch while the persisted catalog is this fresh (mirrors pi's remote catalog provider). */
export const REFRESH_COOLDOWN_MS = 4 * 60 * 60 * 1000
export interface CommandCodeBuildModel {
  id: string
  name: string
  api?: 'anthropic-messages'
  baseUrl?: string
  reasoning: boolean
  input: ('text' | 'image')[]
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow: number
  maxTokens: number
  thinkingLevelMap?: CommandCodeModelConfig['thinkingLevelMap']
  compat?: CommandCodeModelConfig['compat']
}

/**
 * Command Code spends one `context_length` budget on prompt and completion
 * together, and rejects the request when `prompt_tokens + max_tokens` exceeds
 * it: deepseek-v4.1-flash serves a sum of exactly 1_048_576 and answers
 * 1_048_577 with a 400. The gateway relays that rejection as either `invalid
 * request error` or `the configured rewrite value still does not satisfy the
 * rule`, each suffixed with the failing request's trace id.
 *
 * That makes the window and the completion independent: the window is what the
 * model can read and `maxTokens` is what it may write, exactly as every other
 * provider advertises them (Ollama Cloud ships the same deepseek model as
 * 1_048_576 in and 393_216 out). The shared budget is respected per request
 * instead — clampCompletionBudget shrinks the completion to the room the prompt
 * leaves — which keeps a long session inside the budget without giving up most of
 * its window to a completion allowance a turn never uses.
 */
export function buildCommandCodeModel(entry: NormalizedOpenAIModel): CommandCodeBuildModel {
  const override = COMMANDCODE_OVERRIDES[entry.id] ?? {}
  const claude = CLAUDE_MODELS[entry.id]
  const contextBudget = entry.context_length ?? DEFAULT_CONTEXT_WINDOW
  const requestedMaxTokens =
    claude?.maxTokens ??
    (typeof override.maxTokens === 'number'
      ? override.maxTokens
      : Math.min(contextBudget, DEFAULT_MAX_TOKENS))
  const maxTokens = Math.min(requestedMaxTokens, Math.max(contextBudget - MIN_INPUT_WINDOW, 1))
  const contextWindow = contextBudget

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
