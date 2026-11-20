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
  createAssistantMessageEventStream,
  isModelType,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Message,
  type JsonObject,
  type Model,
  type ProviderResponse,
  type RefreshModelsContext,
  type SimpleStreamOptions,
  type Tool,
  type TranscriptContext,
  type Usage
} from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import {
  buildCommandCodeModel,
  MIN_INPUT_WINDOW,
  REFRESH_COOLDOWN_MS,
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

// ---- Streaming -----------------------------------------------------------

/** The CLI release this transport was written against; the gateway gates on it. */
export const COMMANDCODE_GO_VERSION = '1.91.1'
export const COMMANDCODE_GO_BASE_URL = 'https://api.commandcode.ai'
const GENERATE_PATH = '/alpha/generate'
/** The CLI's own default when a caller does not size the completion. */
const DEFAULT_MAX_TOKENS = 64_000
const MID_STREAM_FAILURE = 'Command Code stream interrupted after content started'

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * The gateway reports usage the way the Vercel AI SDK does: `inputTokens` is the
 * whole prompt, cached prefix included. pi charges `input` and `cacheRead`
 * separately, so the cached part is subtracted here instead of being billed
 * twice.
 */
function usageFromFinish(event: Record<string, unknown>): Usage {
  const total = (event.totalUsage ?? {}) as Record<string, unknown>
  const details = (total.inputTokenDetails ?? {}) as Record<string, unknown>
  const cacheRead = count(details.cacheReadTokens)
  const cacheWrite = count(details.cacheWriteTokens)
  const input = Math.max(0, count(total.inputTokens) - cacheRead)
  const output = count(total.outputTokens)
  const usage = zeroUsage()
  usage.input = input
  usage.output = output
  usage.cacheRead = cacheRead
  usage.cacheWrite = cacheWrite
  usage.totalTokens = input + output + cacheRead + cacheWrite
  return usage
}

/**
 * NDJSON, not SSE. A line the gateway does not expect us to understand must not
 * fail the turn, so unparsable lines are skipped the way the CLI skips them.
 */
export async function* readNdjson(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const parse = (line: string): Record<string, unknown> | undefined => {
    const trimmed = line.trim()
    if (!trimmed) return undefined
    try {
      const parsed: unknown = JSON.parse(trimmed)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const event = parse(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      if (event) yield event
      newline = buffer.indexOf('\n')
    }
  }
  buffer += decoder.decode()
  const last = parse(buffer)
  if (last) yield last
}

function goHeaders(apiKey: string, sessionId: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    accept: 'application/x-ndjson',
    'user-agent': 'cli',
    'x-cli-environment': 'production',
    'x-cli-surface': 'cli',
    'x-command-code-version': COMMANDCODE_GO_VERSION,
    'x-session-id': sessionId,
    ...(process.env.CMD_ZDR === '1' ? { 'x-cmd-zdr': '1' } : {})
  }
}

function reasoningEffort(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined
): string | undefined {
  const level = options?.reasoning
  if (!level) return undefined
  const mapped = model.thinkingLevelMap?.[level]
  return typeof mapped === 'string' && mapped ? mapped : undefined
}

function stopReasonFromFinish(event: Record<string, unknown>, sawToolCall: boolean): string {
  const raw = String(event.rawFinishReason ?? event.finishReason ?? '').toLowerCase()
  if (raw === 'tool_calls' || raw === 'tool-calls' || raw === 'tool_use') return 'toolUse'
  if (raw === 'length' || raw === 'max_tokens') return 'length'
  if (sawToolCall) return 'toolUse'
  return 'stop'
}

/** What pi shows when the gateway refuses the request before generating a token. */
async function describeHttpFailure(response: Response): Promise<Error> {
  let raw = ''
  try {
    raw = await response.text()
  } catch {
    // The status alone has to carry the message.
  }
  let detail = raw
  try {
    const parsed = JSON.parse(raw) as {
      error?: { code?: string; message?: string }
      message?: string
    }
    const code = parsed.error?.code
    const message = parsed.error?.message ?? parsed.message
    if (code === 'upgrade_required' && message && /cli|version/i.test(message)) {
      return new Error(
        `Command Code client version rejected (${COMMANDCODE_GO_VERSION}); bump COMMANDCODE_GO_VERSION: ${message}`
      )
    }
    if (message) detail = message
  } catch {
    // Keep the raw body.
  }
  return new Error(`Command Code ${response.status}: ${detail || response.statusText}`)
}

export function streamCommandCodeGo(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()

  void (async () => {
    const output: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: zeroUsage(),
      stopReason: 'stop',
      timestamp: Date.now()
    }

    const fail = (error: unknown) => {
      output.stopReason = options?.signal?.aborted ? 'aborted' : 'error'
      output.errorMessage = error instanceof Error ? error.message : String(error)
      stream.push({
        type: 'error',
        reason: output.stopReason === 'aborted' ? 'aborted' : 'error',
        error: output
      })
      stream.end()
    }

    if (options?.signal?.aborted) {
      fail(new Error('Command Code request aborted before it started'))
      return
    }

    try {
      const apiKey = options?.apiKey
      if (!apiKey) {
        throw new Error(
          'No Command Code API key. Run /login for commandcode-go or set COMMANDCODE_API_KEY=user_...'
        )
      }

      const body = buildGoRequest({
        model: model.id,
        system: getCurrentSystemPrompt(context.messages),
        messages: context.messages,
        tools: getCurrentTools(context.messages),
        maxTokens: options?.maxTokens ?? model.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
        reasoningEffort: reasoningEffort(model, options),
        threadId: options?.sessionId,
        workingDir: process.cwd(),
        date: new Date().toISOString().slice(0, 10),
        platform: process.platform,
        structure: []
      })

      const payload = (await options?.onPayload?.(body, model)) ?? body
      const response = await fetch(`${COMMANDCODE_GO_BASE_URL}${GENERATE_PATH}`, {
        method: 'POST',
        headers: goHeaders(apiKey, options?.sessionId ?? crypto.randomUUID()),
        body: JSON.stringify(payload),
        signal: options?.signal
      })
      await options?.onResponse?.(response as unknown as ProviderResponse, model)

      if (!response.ok || !response.body) throw await describeHttpFailure(response)

      stream.push({ type: 'start', partial: output })

      let textIndex: number | undefined
      let thinkingIndex: number | undefined
      let sawFinish = false
      let sawAbort = false
      const toolIndexById = new Map<string, number>()
      const toolJsonById = new Map<string, string>()
      const endedToolCalls = new Set<string>()
      const endToolCall = (index: number, id: string) => {
        const block = output.content[index]
        if (block?.type !== 'toolCall' || endedToolCalls.has(id)) return
        const raw = toolJsonById.get(id)
        if (raw) {
          try {
            const parsed: unknown = JSON.parse(raw)
            if (parsed && typeof parsed === 'object') {
              block.arguments = parsed as JsonObject
            }
          } catch {
            // Keep whatever partial object the deltas produced.
          }
        }
        endedToolCalls.add(id)
        stream.push({
          type: 'toolcall_end',
          contentIndex: index,
          toolCall: {
            type: 'toolCall',
            id: block.id,
            name: block.name,
            arguments: block.arguments
          },
          partial: output
        })
      }

      const closeBlocks = () => {
        if (thinkingIndex !== undefined) {
          const block = output.content[thinkingIndex]
          if (block?.type === 'thinking') {
            stream.push({
              type: 'thinking_end',
              contentIndex: thinkingIndex,
              content: block.thinking,
              partial: output
            })
          }
          thinkingIndex = undefined
        }
        if (textIndex !== undefined) {
          const block = output.content[textIndex]
          if (block?.type === 'text') {
            stream.push({
              type: 'text_end',
              contentIndex: textIndex,
              content: block.text,
              partial: output
            })
          }
          textIndex = undefined
        }
      }

      for await (const event of readNdjson(response.body)) {
        await options?.onProviderStreamEvent?.(event, model)
        const type = typeof event.type === 'string' ? event.type : ''
        if (type === 'text-delta') {
          if (textIndex === undefined) {
            output.content.push({ type: 'text', text: '' })
            textIndex = output.content.length - 1
            stream.push({ type: 'text_start', contentIndex: textIndex, partial: output })
          }
          const block = output.content[textIndex]
          if (block?.type !== 'text') continue
          const delta = typeof event.text === 'string' ? event.text : ''
          block.text += delta
          stream.push({ type: 'text_delta', contentIndex: textIndex, delta, partial: output })
        } else if (type === 'text-start') {
          if (textIndex === undefined) {
            output.content.push({ type: 'text', text: '' })
            textIndex = output.content.length - 1
            stream.push({ type: 'text_start', contentIndex: textIndex, partial: output })
          }
        } else if (type === 'text-end') {
          if (textIndex !== undefined) {
            const block = output.content[textIndex]
            if (block?.type === 'text') {
              stream.push({
                type: 'text_end',
                contentIndex: textIndex,
                content: block.text,
                partial: output
              })
            }
            textIndex = undefined
          }
        } else if (type === 'reasoning-delta') {
          if (thinkingIndex === undefined) {
            output.content.push({ type: 'thinking', thinking: '' })
            thinkingIndex = output.content.length - 1
            stream.push({ type: 'thinking_start', contentIndex: thinkingIndex, partial: output })
          }
          const block = output.content[thinkingIndex]
          if (block?.type !== 'thinking') continue
          const delta = typeof event.text === 'string' ? event.text : ''
          block.thinking += delta
          stream.push({
            type: 'thinking_delta',
            contentIndex: thinkingIndex,
            delta,
            partial: output
          })
        } else if (type === 'reasoning-start') {
          if (thinkingIndex === undefined) {
            output.content.push({ type: 'thinking', thinking: '' })
            thinkingIndex = output.content.length - 1
            stream.push({ type: 'thinking_start', contentIndex: thinkingIndex, partial: output })
          }
        } else if (type === 'reasoning-end') {
          if (thinkingIndex !== undefined) {
            const block = output.content[thinkingIndex]
            if (block?.type === 'thinking') {
              stream.push({
                type: 'thinking_end',
                contentIndex: thinkingIndex,
                content: block.thinking,
                partial: output
              })
            }
            thinkingIndex = undefined
          }
        } else if (type === 'tool-input-start') {
          const id = String(event.id ?? event.toolCallId ?? '')
          if (!id || toolIndexById.has(id)) continue
          output.content.push({
            type: 'toolCall',
            id,
            name: String(event.toolName ?? event.name ?? ''),
            arguments: {}
          })
          const index = output.content.length - 1
          toolIndexById.set(id, index)
          toolJsonById.set(id, '')
          stream.push({ type: 'toolcall_start', contentIndex: index, partial: output })
        } else if (type === 'tool-input-delta') {
          const id = String(event.id ?? event.toolCallId ?? '')
          const index = toolIndexById.get(id)
          if (index === undefined) continue
          const block = output.content[index]
          if (block?.type !== 'toolCall') continue
          const delta = typeof event.delta === 'string' ? event.delta : ''
          const accumulated = `${toolJsonById.get(id) ?? ''}${delta}`
          toolJsonById.set(id, accumulated)
          try {
            const parsed: unknown = JSON.parse(accumulated)
            if (parsed && typeof parsed === 'object') {
              block.arguments = parsed as JsonObject
            }
          } catch {
            // JSON still streaming.
          }
          stream.push({ type: 'toolcall_delta', contentIndex: index, delta, partial: output })
        } else if (type === 'tool-input-end') {
          const id = String(event.id ?? event.toolCallId ?? '')
          const index = toolIndexById.get(id)
          if (index !== undefined) endToolCall(index, id)
        } else if (type === 'tool-call') {
          const id = String(event.toolCallId ?? event.id ?? '')
          if (!id) continue
          const complete = event.input ?? event.args
          let index = toolIndexById.get(id)
          if (index === undefined) {
            output.content.push({
              type: 'toolCall',
              id,
              name: String(event.toolName ?? event.name ?? ''),
              arguments: {}
            })
            index = output.content.length - 1
            toolIndexById.set(id, index)
            stream.push({ type: 'toolcall_start', contentIndex: index, partial: output })
          }
          const block = output.content[index]
          if (block?.type !== 'toolCall') continue
          if (complete && typeof complete === 'object') {
            block.arguments = complete as JsonObject
          }
          endToolCall(index, id)
        } else if (type === 'finish') {
          sawFinish = true
          closeBlocks()
          output.usage = usageFromFinish(event)
          const raw = String(event.rawFinishReason ?? event.finishReason ?? '').toLowerCase()
          if (raw === 'refusal') {
            output.stopReason = 'error'
            output.errorMessage = 'Command Code refused the request (refusal)'
          } else {
            const sawToolCall = output.content.some((block) => block.type === 'toolCall')
            output.stopReason = stopReasonFromFinish(
              event,
              sawToolCall
            ) as AssistantMessage['stopReason']
          }
        } else if (type === 'abort') {
          sawAbort = true
          closeBlocks()
          output.stopReason = 'aborted'
        } else if (type === 'error') {
          const detail =
            typeof event.error === 'string'
              ? event.error
              : JSON.stringify(event.error ?? event.message ?? 'Command Code stream error')
          throw new Error(output.content.length > 0 ? MID_STREAM_FAILURE : detail)
        }
      }

      if (!sawFinish && !sawAbort) throw new Error(MID_STREAM_FAILURE)

      if (output.stopReason === 'aborted') {
        stream.push({ type: 'error', reason: 'aborted', error: output })
        stream.end()
        return
      }
      if (output.stopReason === 'error') {
        stream.push({ type: 'error', reason: 'error', error: output })
        stream.end()
        return
      }

      stream.push({
        type: 'done',
        reason: output.stopReason as 'stop' | 'length' | 'toolUse',
        message: output
      })
      stream.end()
    } catch (error) {
      fail(error)
    }
  })()

  return stream
}

// ---- Catalog refresh and registration ------------------------------------

async function fetchGoCatalog(
  apiKey: string,
  signal: AbortSignal
): Promise<CommandCodeModelConfig[]> {
  const response = await fetch(`${COMMANDCODE_GO_BASE_URL}/provider/v1/models?view=client`, {
    headers: {
      authorization: `Bearer ${apiKey}`,
      'x-command-code-version': COMMANDCODE_GO_VERSION
    },
    signal
  })
  if (!response.ok) throw new Error(`Command Code models ${response.status}`)
  return parseGoCatalog(await response.json())
}

/**
 * The `refreshModels` callback pi invokes for "commandcode-go". The stored
 * catalog is already filtered to this plan and rebuilt by this build, so it is
 * the fallback in the cache-only phase; a live fetch replaces it behind the same
 * cooldown the other provider uses. A fetch failure, an empty Go list or an
 * abort all keep what pi already had — publishing nothing is always better than
 * publishing an empty provider.
 */
export async function refreshCommandCodeGoCatalog(
  context: RefreshModelsContext
): Promise<CommandCodeModelConfig[]> {
  const stored = context.stored?.models
  const fallback = stored?.length
    ? stored.filter((model) => isModelType(model, 'chat'))
    : knownGoModels()

  if (!context.allowNetwork || context.signal.aborted) return fallback

  const checkedAt = context.stored?.checkedAt
  if (!context.force && checkedAt !== undefined && Date.now() - checkedAt < REFRESH_COOLDOWN_MS) {
    return fallback
  }

  const credential = context.credential
  if (credential?.type !== 'api_key' || !credential.key) return fallback

  let models: CommandCodeModelConfig[]
  try {
    models = await fetchGoCatalog(credential.key, context.signal)
  } catch {
    return fallback
  }
  if (context.signal.aborted || models.length === 0) return fallback

  const persisted = models.map((model) => ({
    ...model,
    provider: 'commandcode-go',
    api: 'commandcode-alpha',
    baseUrl: COMMANDCODE_GO_BASE_URL
  }))
  try {
    await context.publish({ persist: { models: persisted, checkedAt: Date.now() } })
  } catch {
    // Persisting is best effort; the returned list already updates this session.
  }
  return persisted
}

export default function commandcodeGo(pi: ExtensionAPI): void {
  pi.registerProvider('commandcode-go', {
    name: 'Command Code (Go plan)',
    baseUrl: COMMANDCODE_GO_BASE_URL,
    apiKey: '$COMMANDCODE_API_KEY',
    api: 'commandcode-alpha',
    models: knownGoModels(),
    refreshModels: refreshCommandCodeGoCatalog
  })
}
