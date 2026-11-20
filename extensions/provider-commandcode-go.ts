/**
 * Command Code Go-plan provider.
 *
 * Registers `commandcode-go`, a second Command Code provider that speaks the
 * route the official `cmd` CLI uses for every model call:
 * `POST https://api.commandcode.ai/alpha/generate`. The documented Provider API
 * under `/provider/v1/*` refuses inference for Go-plan accounts with
 * `403 upgrade_required` — the whole surface, not one model — so a Go key has no
 * other way into pi. Plans with API entitlement should keep using
 * `provider-commandcode.ts`, which speaks the documented wire.
 *
 * The endpoint is undocumented and version-gated: every request carries
 * `x-command-code-version`, pinned to the CLI release this was written against.
 * A gateway 403 that names a newer minimum is surfaced as "client version
 * rejected", so the next protocol drift is a one-line bump of
 * `COMMANDCODE_GO_VERSION`.
 *
 * The model catalog is the CLI's own: `GET /provider/v1/models?view=client`
 * carries `minimumPlan`, `reasoningEfforts` and `inputModalities` per model, so
 * the picker only lists models this plan can run and the thinking levels come
 * from the gateway's declaration instead of a probe.
 *
 * Authenticate with `/login` (Command Code Go, paste the key),
 * `pi auth login commandcode-go --api-key`, or `COMMANDCODE_API_KEY`. The
 * provider resolves credentials under its own id, so it does not read the
 * `commandcode` entry.
 *
 * Go meters usage against a monthly credit pool with per-model multipliers that
 * do not map onto per-token prices, so every model reports a zero cost.
 */

import {
  buildCommandCodeModel,
  MIN_INPUT_WINDOW,
  type CommandCodeBuildModel,
  type CommandCodeModelConfig
} from './shared/commandcode-models'
import {
  COMMANDCODE_GO_CATALOG,
  type CommandCodeGoCatalogEntry
} from './provider-commandcode-go-catalog.generated'

const MODEL_INPUT_MODALITIES = ['text', 'image'] as const
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/**
 * The gateway names the efforts a model accepts, so the pi level maps onto
 * itself. `minimal` has no wire value on this gateway, and any level the model
 * does not declare stays `null` — pi then hides it instead of sending a level
 * the upstream would ignore.
 */
export function goThinkingLevelMap(
  efforts: readonly string[]
): NonNullable<CommandCodeModelConfig['thinkingLevelMap']> {
  const declared = new Set(efforts)
  return {
    off: declared.has('off') ? 'off' : null,
    minimal: null,
    low: declared.has('low') ? 'low' : null,
    medium: declared.has('medium') ? 'medium' : null,
    high: declared.has('high') ? 'high' : null,
    xhigh: declared.has('xhigh') ? 'xhigh' : null,
    max: declared.has('max') ? 'max' : null
  }
}

/**
 * Build one Go model from its catalog entry. The measured tables supply the
 * output limit pi advertises when the upstream leaves `maxOutputTokens` null,
 * and the result deliberately carries no `api`/`baseUrl`/`cost`: pi only routes
 * a model through this extension's `streamSimple` when the model keeps the
 * provider's own `api`, and Go credits do not convert to per-token prices.
 */
function buildGoModel(entry: CommandCodeGoCatalogEntry): CommandCodeModelConfig {
  const measured: CommandCodeBuildModel = buildCommandCodeModel({
    id: entry.id,
    name: entry.name,
    context_length: entry.context_length
  })
  const reasoning = entry.efforts.length > 0
  const requestedMaxTokens = entry.max_output_tokens ?? measured.maxTokens
  const model: CommandCodeModelConfig = {
    id: measured.id,
    name: measured.name,
    reasoning,
    input: entry.inputs.length > 0 ? [...entry.inputs] : ['text'],
    cost: { ...ZERO_COST },
    contextWindow: measured.contextWindow,
    maxTokens: Math.min(requestedMaxTokens, Math.max(measured.contextWindow - MIN_INPUT_WINDOW, 1))
  }
  if (reasoning) {
    model.thinkingLevelMap = goThinkingLevelMap(entry.efforts)
    model.compat = { supportsReasoningEffort: true }
  }
  return model
}

function toCatalogEntry(row: Record<string, unknown>): CommandCodeGoCatalogEntry | undefined {
  if (row.minimumPlan !== 'individual-go') return undefined
  const { id, name, context_length: contextLength } = row
  if (typeof id !== 'string' || typeof name !== 'string' || typeof contextLength !== 'number') {
    return undefined
  }
  const efforts = Array.isArray(row.reasoningEfforts)
    ? row.reasoningEfforts.filter((effort): effort is string => typeof effort === 'string')
    : []
  const declaredInputs = Array.isArray(row.inputModalities) ? row.inputModalities : ['text']
  const inputs = declaredInputs.filter(
    (modality): modality is (typeof MODEL_INPUT_MODALITIES)[number] =>
      modality === 'text' || modality === 'image'
  )
  const entry: CommandCodeGoCatalogEntry = {
    id,
    name,
    context_length: contextLength,
    efforts,
    inputs: inputs.length > 0 ? inputs : ['text']
  }
  if (typeof row.maxOutputTokens === 'number') entry.max_output_tokens = row.maxOutputTokens
  return entry
}

/** The Go-plan half of a `?view=client` body, as pi's model configs. */
export function parseGoCatalog(data: unknown): CommandCodeModelConfig[] {
  const rows = (data as { data?: unknown } | null)?.data
  if (!Array.isArray(rows)) return []
  const models: CommandCodeModelConfig[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const entry = toCatalogEntry(row as Record<string, unknown>)
    if (entry) models.push(buildGoModel(entry))
  }
  return models
}

/** The catalog this build ships, so a registry that enumerates the provider sees it. */
export function knownGoModels(): CommandCodeModelConfig[] {
  return COMMANDCODE_GO_CATALOG.map(buildGoModel)
}
