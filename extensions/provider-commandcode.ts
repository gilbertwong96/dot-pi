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
 * COMMANDCODE_OVERRIDES (in `shared/commandcode-models.ts`) layers model-specific
 * metadata on top of what the upstream exposes, since the upstream only returns
 * identity fields and `context_length`. The upstream exposes no capability
 * metadata, so reasoning support and the per-model `reasoning_effort` values are
 * pinned from measurements: `scripts/probe-commandcode-capabilities.mjs` re-runs
 * the probe. Claude is only served through the Anthropic Messages shape, so
 * those models carry an `api`/`baseUrl` override.
 *
 * Use /login or the COMMANDCODE_API_KEY environment variable to authenticate
 * and /model to pick a model. Get an API key from Command Code Studio
 * (https://commandcode.ai/settings/keys).
 *
 * Premium models are gated per plan, and the gateway lists the gated ones
 * alongside the rest, so a refresh probes entitlement and persists only the
 * models the account can run (see findExcludedModelIds).
 *
 * Because the gateway charges prompt and completion against one budget, the
 * extension also clamps each request's completion to the room the prompt leaves
 * (see clampCompletionBudget) and, if a request still overshoots, restates the
 * gateway's rejection as the overflow phrase pi recovers from.
 */

import { isModelType, type RefreshModelsContext } from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import {
  buildCommandCodeModel,
  COMMANDCODE_ANTHROPIC_BASE_URL,
  COMMANDCODE_BASE_URL,
  knownCommandCodeModels,
  REFRESH_COOLDOWN_MS,
  type CommandCodeBuildModel,
  type CommandCodeModelConfig
} from './shared/commandcode-models'
import { fetchText } from './shared/http'
import { fetchOpenAIModels, type NormalizedOpenAIModel } from './shared/openai-models'

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

/**
 * Chars per token assumed when sizing a prompt. Prose runs about four and code
 * about three, so counting three over-estimates: the clamp then errs towards a
 * shorter completion instead of a rejected request.
 */
const PAYLOAD_CHARS_PER_TOKEN = 3
/**
 * An image costs far more than its payload length implies, so its bytes are
 * replaced with a flat estimate rather than counted as text — an inlined base64
 * attachment would otherwise claim the whole budget by itself.
 */
const IMAGE_TOKEN_ESTIMATE = 4_000
/** A completion shorter than this cannot carry a tool call worth sending. */
const MIN_COMPLETION_TOKENS = 1_024
/** Room left for the tokenizer's own margin over the estimate. */
const BUDGET_SAFETY_TOKENS = 1_024

interface CompletionBudget {
  /** The model's `context_length`, which its context window advertises. */
  budget: number
  /** The completion allowance the model advertises. */
  maxOutput: number
}

/** Add the tokens `value` occupies, treating image blocks as a flat estimate. */
function countPayloadTokens(value: unknown, total: { tokens: number }): void {
  if (typeof value === 'string') {
    total.tokens += Math.ceil(value.length / PAYLOAD_CHARS_PER_TOKEN)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) countPayloadTokens(item, total)
    return
  }
  if (typeof value !== 'object' || value === null) return

  const record = value as Record<string, unknown>
  if (record.type === 'image' || record.type === 'image_url') {
    total.tokens += IMAGE_TOKEN_ESTIMATE
    return
  }
  for (const [key, child] of Object.entries(record)) {
    total.tokens += Math.ceil(key.length / PAYLOAD_CHARS_PER_TOKEN)
    countPayloadTokens(child, total)
  }
}

/**
 * Shrink a request's completion so prompt plus completion fit the model's one
 * shared budget.
 *
 * pi sizes `max_tokens` from the model alone and never from what the prompt
 * already spent, so a request is only in range while the conversation is short
 * of the model's limit. Returning a smaller completion keeps the request legal
 * instead of trading it for a 400 the session cannot finish in.
 */
export function clampCompletionBudget(payload: unknown, limits: CompletionBudget): unknown {
  if (typeof payload !== 'object' || payload === null) return payload

  const body = payload as Record<string, unknown>
  const field = ['max_tokens', 'max_completion_tokens'].find(
    (name) => typeof body[name] === 'number'
  )
  if (field === undefined) return payload

  const requested = body[field] as number
  const total = { tokens: 0 }
  for (const [key, child] of Object.entries(body)) {
    if (key === field) continue
    total.tokens += Math.ceil(key.length / PAYLOAD_CHARS_PER_TOKEN)
    countPayloadTokens(child, total)
  }

  const room = limits.budget - total.tokens - BUDGET_SAFETY_TOKENS
  const allowed = Math.max(MIN_COMPLETION_TOKENS, Math.min(requested, limits.maxOutput, room))
  return allowed >= requested ? payload : { ...body, [field]: allowed }
}

/**
 * The gateway's ways of relaying a prompt + completion rejection. The bare
 * `invalid request error` relay also covers malformed requests, where cutting the
 * context would hide the real cause, so it is left alone.
 */
const BUDGET_REJECTION_PATTERNS = [
  /the configured rewrite value still does not satisfy the rule/i,
  /input is longer than the model'?s? context length/i
]

/**
 * pi recovers from a context overflow by compacting once and retrying, but it
 * only recognizes that from the error text, and none of the gateway's wordings
 * appear in its patterns. Restating the rejection with pi's own overflow phrase in
 * front of it turns the stuck session into a compaction, and keeps the gateway's
 * text visible for when the recovery does not help.
 */
export function asBudgetOverflow(errorMessage: string): string | undefined {
  if (!BUDGET_REJECTION_PATTERNS.some((pattern) => pattern.test(errorMessage))) return undefined
  return `prompt is too long: Command Code rejected prompt + max_tokens against the model's context_length. Upstream: ${errorMessage}`
}

/**
 * Each model's own budget, keyed by the id a request names. The seed is
 * authoritative over the model in flight: a catalog persisted by an older build
 * carries a window that already had the completion taken out of it.
 */
function completionBudgets(): Map<string, CompletionBudget> {
  const budgets = new Map<string, CompletionBudget>()
  for (const entry of knownCommandCodeModels()) {
    const model = buildCommandCodeModel(entry)
    budgets.set(model.id, { budget: model.contextWindow, maxOutput: model.maxTokens })
  }
  return budgets
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
 * A persisted entry carries the identity fields and the context window the
 * upstream advertised; everything else about it was baked in by the build that
 * fetched it. Rebuilding through the current tables keeps a session from
 * serving levels, output limits or image support that an older build recorded —
 * a catalog persisted before a model was measured stays level-less for the rest
 * of the refresh cooldown, because that window short-circuits the fetch that
 * would rebuild it.
 */
function rebuildStoredModel(model: CommandCodeModelConfig): CommandCodeModelConfig {
  return buildCommandCodeModel({
    id: model.id,
    name: model.name,
    context_length: model.contextWindow
  })
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
): Promise<CommandCodeModelConfig[]> {
  const stored = context.stored?.models
  // The store holds pi-ai's catalog union; Command Code only ever persists chat models.
  const fallback = stored?.length
    ? stored.filter((model) => isModelType(model, 'chat')).map(rebuildStoredModel)
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
  // provider, so serve the catalog this build ships. The stored fallback is the
  // snapshot a previous refresh already filtered, so falling back to it would keep
  // hiding models upstream still lists — and it can never self-heal, because the
  // all-excluded result short-circuits the persist below.
  if (models.length === 0) {
    console.warn(
      '[commandcode] The account plan excludes every model upstream lists; serving the shipped catalog.'
    )
    return knownCommandCodeModels().map(buildCommandCodeModel)
  }

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
  const budgets = completionBudgets()

  pi.registerProvider('commandcode', {
    name: 'Command Code',
    baseUrl: COMMANDCODE_BASE_URL,
    apiKey: '$COMMANDCODE_API_KEY',
    api: 'openai-completions',
    models: knownCommandCodeModels().map(buildCommandCodeModel),
    refreshModels: refreshCommandCodeCatalog
  })

  pi.on('before_provider_request', (event, ctx) => {
    const model = ctx.model
    if (model?.provider !== 'commandcode') return

    const limits = budgets.get(model.id) ?? {
      budget: model.contextWindow,
      maxOutput: model.maxTokens
    }
    return clampCompletionBudget(event.payload, limits)
  })

  pi.on('message_end', (event) => {
    const message = event.message
    if (message.role !== 'assistant' || message.stopReason !== 'error') return
    if (message.provider !== 'commandcode' || !message.errorMessage) return

    const errorMessage = asBudgetOverflow(message.errorMessage)
    if (errorMessage === undefined) return
    return { message: { ...message, errorMessage } }
  })
}
