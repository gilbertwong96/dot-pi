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

import type { Message, Tool } from '@earendil-works/pi-ai'

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

// ---- Wire shapes ---------------------------------------------------------

type WireSystemPart = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }

type WireUserPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string; mimeType: string }

type WireAssistantPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }

type WireToolResultPart = {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  output: { type: 'text' | 'error-text'; value: string }
}

type WireMessage =
  | { role: 'user'; content: WireUserPart[] }
  | { role: 'assistant'; content: WireAssistantPart[] }
  | { role: 'tool'; content: WireToolResultPart[] }

type WireTool = { name: string; description: string; input_schema: unknown }

export interface GoRequestInput {
  model: string
  system: string
  messages: Message[]
  tools: Tool[]
  maxTokens: number
  temperature?: number
  reasoningEffort?: string
  threadId?: string
  workingDir: string
  date: string
  platform: string
  structure: string[]
}

export interface GoRequestBody {
  config: {
    workingDir: string
    date: string
    environment: string
    structure: string[]
    isGitRepo: boolean
    currentBranch: string
    mainBranch: string
    gitStatus: string
    recentCommits: string[]
  }
  memory: null
  taste: null
  skills: null
  permissionMode: 'standard'
  threadId?: string
  params: {
    model: string
    system: WireSystemPart[]
    messages: WireMessage[]
    tools: WireTool[]
    max_tokens: number
    stream: true
    temperature?: number
    reasoning_effort?: string
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The CLI sends the prompt as text parts with `cache_control` on every part but
 * the last, which is what makes the shared prefix cacheable upstream. A plain
 * string is not the shape the gateway sees from its own client.
 */
export function toWireSystem(system: string): WireSystemPart[] {
  const parts = system
    .split('\n')
    .filter((part) => part.length > 0)
    .map<WireSystemPart>((text) => ({ type: 'text', text }))
  return parts.map((part, index) =>
    index < parts.length - 1 ? { ...part, cache_control: { type: 'ephemeral' } } : part
  )
}

/** pi's transcript → the gateway's Vercel-AI-SDK `ModelMessage` shape. */
export function toWireMessages(messages: Message[]): WireMessage[] {
  const wire: WireMessage[] = []

  for (const message of messages) {
    if (message.role === 'system') continue

    if (message.role === 'user') {
      const content: WireUserPart[] = []
      if (typeof message.content === 'string') {
        if (message.content) content.push({ type: 'text', text: message.content })
      } else {
        for (const part of message.content) {
          if (part.type === 'text') content.push({ type: 'text', text: part.text })
          else if (part.type === 'image') {
            content.push({
              type: 'image',
              image: `data:${part.mimeType};base64,${part.data}`,
              mimeType: part.mimeType
            })
          }
        }
      }
      if (content.length > 0) wire.push({ role: 'user', content })
      continue
    }

    if (message.role === 'assistant') {
      const content: WireAssistantPart[] = []
      for (const part of message.content) {
        if (part.type === 'text') {
          if (part.text) content.push({ type: 'text', text: part.text })
        } else if (part.type === 'thinking') {
          if (part.thinking) content.push({ type: 'reasoning', text: part.thinking })
        } else if (part.type === 'toolCall') {
          content.push({
            type: 'tool-call',
            toolCallId: part.id,
            toolName: part.name,
            input: part.arguments
          })
        }
      }
      if (content.length > 0) wire.push({ role: 'assistant', content })
      continue
    }

    const value = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    const result: WireToolResultPart = {
      type: 'tool-result',
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      output: message.isError ? { type: 'error-text', value } : { type: 'text', value }
    }
    const last = wire[wire.length - 1]
    if (last?.role === 'tool') last.content.push(result)
    else wire.push({ role: 'tool', content: [result] })
  }

  return wire
}

export function toWireTools(tools: Tool[]): WireTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters
  }))
}

/**
 * The envelope the CLI posts. `config` is the workspace preamble the gateway
 * renders for its own client; pi already carries the environment in its system
 * prompt, so the neutral fields here keep the request well-formed without
 * shelling out on every turn.
 */
export function buildGoRequest(input: GoRequestInput): GoRequestBody {
  const threadId = input.threadId && UUID_PATTERN.test(input.threadId) ? input.threadId : undefined
  return {
    config: {
      workingDir: input.workingDir,
      date: input.date,
      environment: input.platform,
      structure: input.structure,
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: []
    },
    memory: null,
    taste: null,
    skills: null,
    permissionMode: 'standard',
    ...(threadId ? { threadId } : {}),
    params: {
      model: input.model,
      system: toWireSystem(input.system),
      messages: toWireMessages(input.messages),
      tools: toWireTools(input.tools),
      max_tokens: input.maxTokens,
      stream: true,
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {})
    }
  }
}
