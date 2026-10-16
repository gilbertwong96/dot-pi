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
 *
 * Premium models are gated per plan, and the gateway lists the gated ones
 * alongside the rest, so a refresh probes entitlement and persists only the
 * models the account can run (see findExcludedModelIds).
 */

import type { RefreshModelsContext } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ProviderModelConfig } from '@earendil-works/pi-coding-agent'

import { COMMANDCODE_CATALOG } from './provider-commandcode-catalog.generated'
import { fetchText } from './shared/http'
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
  thinkingLevelMap?: ProviderModelConfig['thinkingLevelMap']
  forceAdaptiveThinking?: boolean
}

export interface CommandCodeModelSpec {
  input?: ('text' | 'image')[]
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  maxTokens?: number
  headers?: Record<string, string>
}

/**
 * Four models are unreachable on their own: the gateway routes them through an
 * upstream preference that names providers this account cannot use (`No
 * available providers match the 'only' filter: deepinfra, fireworks`), and the
 * `/provider/v1` schema has no routing field to override it with. Asking for
 * zero data retention makes the gateway route by its ZDR-capable upstreams
 * instead, and those do answer.
 *
 * The trade-off is real: the request only ever reaches a ZDR provider and bills
 * at that provider's rate, and a model with no ZDR upstream is refused with a
 * 422 instead of being served. `xiaomi/mimo-v2.5-pro` is one of those, so it
 * stays unreachable. Drop the headers here if the routing preference is fixed
 * upstream.
 */
const ZDR_ROUTING_HEADERS: Record<string, string> = { 'x-cmd-zdr': '1' }

/**
 * Metadata overrides applied to known models on top of the auto-discovered
 * `context_length`. Add an entry when a model needs image input, specific max
 * output, or pricing that the upstream /models endpoint does not expose.
 * Reasoning support is derived from REASONING_MODEL_IDS, not from this table.
 *
 * A `maxTokens` entry spends the model's context budget, not extra room: the
 * provider counts the completion against the same `context_length` as the
 * prompt (see buildCommandCodeModel). The deepseek models are capped far below
 * the 393_216 the endpoint accepts so a session still has most of the
 * advertised million tokens to grow into.
 */
export const COMMANDCODE_OVERRIDES: Record<string, CommandCodeModelSpec> = {
  'deepseek/deepseek-v4-pro': {
    input: ['text'],
    cost: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
    maxTokens: 65_536
  },
  'deepseek/deepseek-v4-flash': {
    input: ['text'],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
    maxTokens: 65_536
  },
  'deepseek/deepseek-v4.1-flash': {
    input: ['text', 'image'],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
    maxTokens: 65_536
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
    maxTokens: 32_000,
    headers: ZDR_ROUTING_HEADERS
  },
  'zai-org/GLM-5': {
    cost: { input: 1.0, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
    maxTokens: 32_000
  },
  'MiniMaxAI/MiniMax-M2.7': { headers: ZDR_ROUTING_HEADERS },
  'thinkingmachines/inkling': { headers: ZDR_ROUTING_HEADERS },
  'thinkingmachines/inkling-small': { headers: ZDR_ROUTING_HEADERS }
}

const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_MAX_TOKENS = 8_192
/**
 * Floor for the input window an override may leave once its completion budget
 * is taken out of `context_length`, so a model with a tiny budget still
 * advertises a usable one.
 */
const MIN_INPUT_WINDOW = 1_024

/** Skip a network fetch while the persisted catalog is this fresh (mirrors pi's remote catalog provider). */
const REFRESH_COOLDOWN_MS = 4 * 60 * 60 * 1000
/**
 * pi's model selector aborts a catalog refresh after 15s, so a cold fetch has to
 * fit inside that budget or the first picker-open misses the fresh list.
 */
const CATALOG_FETCH_TIMEOUT_MS = 15_000
/**
 * Entitlement probing. The gate answers a model the plan excludes before any
 * upstream call, but not instantly: a burst of probes lands on a ~1s floor, so
 * the timeout has to clear that while the whole pass still fits inside the 15s
 * refresh budget alongside the catalog fetch. Measured against the live gateway
 * a full 92-model pass at this concurrency takes about 6s.
 */
const ENTITLEMENT_PROBE_TIMEOUT_MS = 3_000
const ENTITLEMENT_PROBE_CONCURRENCY = 24
const ENTITLEMENT_PROBE_MAX_TOKENS = 16

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
  headers?: Record<string, string>
  thinkingLevelMap?: ProviderModelConfig['thinkingLevelMap']
  compat?: ProviderModelConfig['compat']
}

/**
 * Command Code spends one `context_length` budget on prompt and completion
 * together, and rejects the request when `prompt_tokens + max_tokens` exceeds
 * it: deepseek-v4.1-flash serves a sum of exactly 1_048_576 and answers
 * 1_048_577 with a 400. The gateway relays that rejection as either `invalid
 * request error` or `the configured rewrite value still does not satisfy the
 * rule`, each suffixed with the failing request's trace id.
 *
 * pi holds back only its own `reserveTokens` (16_384 by default) before it
 * compacts, so a model that advertises the whole budget as its context window
 * leaves the session a tail it can grow into but never complete a request in —
 * every turn fails with that 400 until the conversation compacts. Advertising
 * the budget minus the completion keeps the worst case at the advertised
 * length, which is the most pi may send once it has compacted.
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
  const contextWindow = contextBudget - maxTokens

  const result: CommandCodeBuildModel = {
    id: entry.id,
    name: entry.name,
    reasoning: false,
    input: override.input ?? ['text'],
    cost: override.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens
  }

  if (override.headers) result.headers = override.headers

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
 * Whether the account may run `model`.
 *
 * Command Code exposes no plan, credit or entitlement route — `/provider/v1`
 * only serves chat/completions, messages, models and responses — and it lists
 * every model it can serve, gated or not, so the only way to learn what a plan
 * covers is to ask for each model once. A model the plan excludes is turned away
 * by the gateway's own gate with `403 permission_error`: either
 * `MODEL_NOT_IN_PLAN: <model> available in <tier> and above plans or extra on
 * demand usage`, or the mis-worded `Authentication failed. Please check your
 * credentials.` that a model with no upstream plan gate returns instead.
 *
 * Only that error type hides a model. A 200, a 429, an upstream 5xx, a gateway
 * validation error or the timeout all count as entitled, because an
 * inconclusive probe must never hide a model that works.
 *
 * The probe follows the model's own shape (see CLAUDE_MODELS): Claude only
 * answers on `/messages`, and anything else on `/chat/completions`.
 */
async function isEntitled(
  model: CommandCodeBuildModel,
  apiKey: string,
  signal: AbortSignal
): Promise<boolean> {
  const anthropic = model.api === 'anthropic-messages'
  const url = anthropic
    ? `${COMMANDCODE_ANTHROPIC_BASE_URL}/v1/messages`
    : `${COMMANDCODE_BASE_URL}/chat/completions`
  const headers: Record<string, string> = anthropic
    ? { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` }
  const body = JSON.stringify({
    model: model.id,
    max_tokens: ENTITLEMENT_PROBE_MAX_TOKENS,
    messages: [{ role: 'user', content: 'hi' }]
  })

  try {
    const result = await fetchText(
      url,
      { method: 'POST', headers, body },
      { signal, timeoutMs: ENTITLEMENT_PROBE_TIMEOUT_MS }
    )
    return !isPlanDenial(result.text)
  } catch {
    return true
  }
}

/** Both endpoint shapes wrap the gate's answer as `error.type`. */
function isPlanDenial(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { error?: { type?: unknown } }
    return parsed.error?.type === 'permission_error'
  } catch {
    return false
  }
}

/**
 * The ids this account's plan excludes. Probing is the only way to learn them
 * (see isEntitled) and it is what makes the picker honest: the persisted catalog
 * is the filtered one, so the exclusions are paid for once per refresh cooldown
 * instead of showing up as a 403 the first time someone picks the model. That
 * also means a dropped model is not addressable until the next refresh, so a
 * session that already used one has to be refreshed (or pi run with a forced
 * catalog refresh) before it can be resumed on the same model.
 */
async function findExcludedModelIds(
  models: CommandCodeBuildModel[],
  apiKey: string,
  signal: AbortSignal
): Promise<Set<string>> {
  const excluded = new Set<string>()
  let next = 0

  const worker = async () => {
    while (!signal.aborted) {
      const model = models[next++]
      if (model === undefined) return
      if (!(await isEntitled(model, apiKey, signal))) excluded.add(model.id)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(ENTITLEMENT_PROBE_CONCURRENCY, models.length) }, worker)
  )
  return excluded
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

  const built = remote.map(buildCommandCodeModel)
  // Guard: an empty result must not be published or persisted, or it would leave
  // the provider with no models for the duration of the cooldown.
  if (built.length === 0) return fallback

  const excluded = await findExcludedModelIds(built, credential.key, context.signal)
  if (context.signal.aborted) return fallback

  const models = built.filter((model) => !excluded.has(model.id))
  // A plan that excludes everything (or a gate that misfires) must not empty the
  // provider, so keep the unfiltered catalog rather than publish nothing.
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
