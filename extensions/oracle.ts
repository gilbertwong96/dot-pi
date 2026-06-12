import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentMessage, ThinkingLevel } from '@earendil-works/pi-agent-core'
import {
  compact,
  estimateTokens,
  type CompactionResult,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionBeforeCompactEvent
} from '@earendil-works/pi-coding-agent'
import type {
  ImageContent,
  Model,
  TextContent,
  ThinkingContent,
  ToolCall
} from '@earendil-works/pi-ai'
import { parse } from 'jsonc-parser'

type PrecompactMode = 'pi' | 'custom' | 'off'
type SummaryMode = 'latest' | 'all' | 'none'
type ToolResultsPolicy = 'all' | 'none' | 'errors-only' | 'errors-and-small'
type ToolCallsPolicy = 'all' | 'names-only' | 'none'
type BashOutputPolicy = 'all' | 'truncate' | 'none'
type ToolsPolicy = 'none' | 'read-only' | 'current' | 'all'
type PromptStyle = 'dense' | 'review' | 'architecture'

interface OracleConfig {
  model?: string
  thinking: ThinkingLevel
  precompact: {
    enabled: boolean
    mode: PrecompactMode
    keepRecentTokens: number
    minTokens: number
    reserveTokens: number
    model?: string
    thinking: ThinkingLevel
  }
  context: {
    maxTokens: number
    summary: SummaryMode
    keepTailTokens: number
    keepUserTurns: number
    keepAssistantTurns: number
    drop: {
      thinking: boolean
      toolResults: ToolResultsPolicy
      toolCalls: ToolCallsPolicy
      bashOutput: BashOutputPolicy
      images: boolean
      customMessages: boolean
    }
    truncate: {
      toolResultChars: number
      bashOutputChars: number
      assistantTextChars: number
    }
  }
  tools: ToolsPolicy
  prompt: {
    costWarning: boolean
    style: PromptStyle
    custom?: string
  }
  restore: {
    model: boolean
    thinking: boolean
    tools: boolean
  }
}

interface OracleRun {
  id: number
  question: string
  config: OracleConfig
  previousModel?: Model<any>
  previousThinking: ThinkingLevel
  previousTools: string[]
  customPrecompact: boolean
}

export const DEFAULT_CONFIG: OracleConfig = {
  thinking: 'high',
  precompact: {
    enabled: true,
    mode: 'pi',
    keepRecentTokens: 4000,
    minTokens: 1000,
    reserveTokens: 12000,
    thinking: 'off'
  },
  context: {
    maxTokens: 12000,
    summary: 'latest',
    keepTailTokens: 3000,
    keepUserTurns: 3,
    keepAssistantTurns: 2,
    drop: {
      thinking: true,
      toolResults: 'all',
      toolCalls: 'names-only',
      bashOutput: 'truncate',
      images: true,
      customMessages: true
    },
    truncate: {
      toolResultChars: 800,
      bashOutputChars: 800,
      assistantTextChars: 2000
    }
  },
  tools: 'none',
  prompt: {
    costWarning: true,
    style: 'dense'
  },
  restore: {
    model: true,
    thinking: true,
    tools: true
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    const parsed = parse(readFileSync(path, 'utf8'))
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function deepMerge<T extends Record<string, unknown>>(base: T, override: unknown): T {
  if (!isRecord(override)) return base
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const previous = out[key]
    out[key] = isRecord(previous) && isRecord(value) ? deepMerge(previous, value) : value
  }
  return out as T
}

function loadOracleConfig(cwd: string): OracleConfig {
  const globalPath = process.env.PI_CODING_AGENT_DIR
    ? join(process.env.PI_CODING_AGENT_DIR, 'settings.json')
    : join(homedir(), '.pi', 'agent', 'settings.json')
  const projectPath = join(cwd, '.pi', 'settings.json')
  const globalSettings = readSettings(globalPath)
  const projectSettings = readSettings(projectPath)
  const merged = deepMerge(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    globalSettings.oracle
  )
  return deepMerge(merged, projectSettings.oracle) as unknown as OracleConfig
}

function splitModelSpec(spec: string): { provider?: string; modelId: string } {
  const slash = spec.indexOf('/')
  if (slash === -1) return { modelId: spec }
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) }
}

function resolveModelFromRegistry(
  ctx: Pick<ExtensionContext, 'modelRegistry'>,
  spec: string
): Model<any> | undefined {
  const { provider, modelId } = splitModelSpec(spec)
  if (provider) return ctx.modelRegistry.find(provider, modelId)

  const matches = ctx.modelRegistry.getAvailable().filter((model) => model.id === modelId)
  return matches.length === 1 ? matches[0] : undefined
}

function truncateChars(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text
}

function textContent(text: string): TextContent[] {
  return text ? [{ type: 'text', text }] : []
}

function filterTextAndImages(
  content: string | (TextContent | ImageContent)[],
  dropImages: boolean
): string | (TextContent | ImageContent)[] {
  if (typeof content === 'string') return content
  return content.filter((block) => block.type === 'text' || !dropImages)
}

function transformMessage(message: AgentMessage, config: OracleConfig): AgentMessage | undefined {
  switch (message.role) {
    case 'compactionSummary':
    case 'branchSummary':
      return message
    case 'custom':
      if (config.context.drop.customMessages) return undefined
      return {
        ...message,
        content: filterTextAndImages(message.content, config.context.drop.images)
      }
    case 'user':
      return {
        ...message,
        content: filterTextAndImages(message.content, config.context.drop.images)
      }
    case 'assistant': {
      const content: (TextContent | ThinkingContent | ToolCall)[] = []
      for (const block of message.content) {
        if (block.type === 'thinking') {
          if (!config.context.drop.thinking) content.push(block)
        } else if (block.type === 'text') {
          content.push(
            ...textContent(truncateChars(block.text, config.context.truncate.assistantTextChars))
          )
        } else if (block.type === 'toolCall') {
          if (config.context.drop.toolCalls === 'names-only')
            content.push({ ...block, arguments: {} })
          else if (config.context.drop.toolCalls === 'all') content.push(block)
        }
      }
      return content.length > 0 ? { ...message, content } : undefined
    }
    case 'toolResult': {
      const policy = config.context.drop.toolResults
      if (policy === 'all') return undefined
      if (policy === 'errors-only' && !message.isError) return undefined
      if (policy === 'errors-and-small' && !message.isError && estimateTokens(message) > 500)
        return undefined
      const content: (TextContent | ImageContent)[] = []
      for (const block of message.content) {
        if (block.type === 'image') {
          if (!config.context.drop.images) content.push(block)
        } else {
          content.push(
            ...textContent(truncateChars(block.text, config.context.truncate.toolResultChars))
          )
        }
      }
      return { ...message, content }
    }
    case 'bashExecution': {
      const policy = config.context.drop.bashOutput
      if (policy === 'none') return undefined
      if (policy === 'truncate') {
        return {
          ...message,
          output: truncateChars(message.output, config.context.truncate.bashOutputChars)
        }
      }
      return message
    }
  }
}

function latestCompaction(messages: AgentMessage[]): AgentMessage[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'compactionSummary') return [messages[index]]
  }
  return []
}

function summaryMessages(messages: AgentMessage[], mode: SummaryMode): AgentMessage[] {
  if (mode === 'none') return []
  if (mode === 'latest') return latestCompaction(messages)
  return messages.filter((message) => message.role === 'compactionSummary')
}

function findLastUserIndex(messages: AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'user') return index
  }
  return -1
}

function estimatedTotal(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message), 0)
}

export function buildOracleContext(messages: AgentMessage[], config: OracleConfig): AgentMessage[] {
  const lastUserIndex = findLastUserIndex(messages)
  const lastUser =
    lastUserIndex >= 0 ? transformMessage(messages[lastUserIndex], config) : undefined
  const summaries = summaryMessages(messages, config.context.summary).flatMap((message) => {
    const transformed = transformMessage(message, config)
    return transformed ? [transformed] : []
  })

  const tail: AgentMessage[] = []
  let tailTokens = 0
  let userTurns = 0
  let assistantTurns = 0

  for (let index = lastUserIndex - 1; index >= 0; index--) {
    const original = messages[index]
    if (original.role === 'compactionSummary') continue
    if (original.role === 'user' && userTurns >= config.context.keepUserTurns) continue
    if (original.role === 'assistant' && assistantTurns >= config.context.keepAssistantTurns)
      continue

    const transformed = transformMessage(original, config)
    if (!transformed) continue

    const tokens = estimateTokens(transformed)
    if (tailTokens + tokens > config.context.keepTailTokens) break

    tail.unshift(transformed)
    tailTokens += tokens
    if (original.role === 'user') userTurns++
    if (original.role === 'assistant') assistantTurns++
  }

  const result = [...summaries, ...tail, ...(lastUser ? [lastUser] : [])]
  while (result.length > 1 && estimatedTotal(result) > config.context.maxTokens) {
    const removeIndex = result.findIndex((message) => message.role !== 'compactionSummary')
    if (removeIndex === -1 || result[removeIndex] === lastUser) break
    result.splice(removeIndex, 1)
  }
  return result
}

function oracleSystemPrompt(config: OracleConfig): string {
  if (config.prompt.custom) return config.prompt.custom

  const styleLine =
    config.prompt.style === 'architecture'
      ? 'Focus on architecture, long-term risk, hidden coupling, and irreversible decisions.'
      : config.prompt.style === 'review'
        ? 'Focus on correctness, risk, missing evidence, and decision quality.'
        : 'Be dense, decision-oriented, and explicit about uncertainty.'

  const costWarning = config.prompt.costWarning
    ? 'You are being called as an extremely expensive expert model. Maximize value per input and output token.'
    : 'You are being called as an expert model.'

  return `${costWarning}

The context has been intentionally compressed before this request. Do not complain about missing low-level history. Use the supplied checkpoint, recent context, and user request. ${styleLine}

Avoid restating obvious context. Ask for more context only if it materially changes the answer. Do not call tools unless the user explicitly asks for tool use or the answer would be unsafe without verification.`
}

function oracleUserPrompt(question: string): string {
  return `Oracle request. Answer the following using the compressed context and the expensive-model instructions.\n\n${question}`
}

function compactionInstructions(config: OracleConfig): string {
  return `Prepare a compact checkpoint for a one-shot expensive expert model call.

Preserve durable facts, constraints, user preferences, decisions and rationale, exact file paths, current state, unresolved questions, blockers, and next actions.

Drop routine logs, repeated tool output, incidental failed attempts, conversational filler, and details that do not affect the expert answer.

Target retained recent context after compaction: ${config.precompact.keepRecentTokens} tokens. Target total oracle context after filtering: ${config.context.maxTokens} tokens.`
}

async function runCompaction(ctx: ExtensionCommandContext, config: OracleConfig) {
  if (!config.precompact.enabled || config.precompact.mode === 'off') return

  const usage = ctx.getContextUsage()
  if (
    usage?.tokens !== null &&
    usage?.tokens !== undefined &&
    usage.tokens < config.precompact.minTokens
  ) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    ctx.compact({
      customInstructions: compactionInstructions(config),
      onComplete: () => resolve(),
      onError: (error) => {
        if (/Nothing to compact|Already compacted/.test(error.message)) resolve()
        else reject(error)
      }
    })
  })
}

async function runCustomCompaction(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  run: OracleRun
) {
  const config = run.config
  const modelSpec = config.precompact.model ?? config.model
  const model = modelSpec ? resolveModelFromRegistry(ctx, modelSpec) : ctx.model
  if (!model) return

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
  if (!auth.ok) return

  const result = await compact(
    event.preparation,
    model,
    auth.apiKey,
    auth.headers,
    compactionInstructions(config),
    event.signal,
    config.precompact.thinking
  )

  return { compaction: result satisfies CompactionResult }
}

function toolNamesForPolicy(
  policy: ToolsPolicy,
  previousTools: string[],
  pi: ExtensionAPI
): string[] {
  if (policy === 'current') return previousTools
  if (policy === 'all') return pi.getAllTools().map((tool) => tool.name)
  if (policy === 'read-only')
    return previousTools.filter((name) => ['read', 'grep', 'find', 'ls'].includes(name))
  return []
}

export default function oracle(pi: ExtensionAPI) {
  let activeRun: OracleRun | undefined
  let nextRunId = 1

  pi.on('session_before_compact', async (event, ctx) => {
    if (!activeRun?.customPrecompact) return
    return runCustomCompaction(event, ctx, activeRun)
  })

  pi.on('before_agent_start', (event) => {
    if (!activeRun || event.prompt !== oracleUserPrompt(activeRun.question)) return
    return { systemPrompt: `${event.systemPrompt}\n\n${oracleSystemPrompt(activeRun.config)}` }
  })

  pi.on('context', (event) => {
    if (!activeRun) return
    return { messages: buildOracleContext(event.messages, activeRun.config) }
  })

  pi.on('agent_end', async () => {
    const run = activeRun
    if (!run) return
    activeRun = undefined

    if (run.config.restore.tools) pi.setActiveTools(run.previousTools)
    if (run.config.restore.thinking) pi.setThinkingLevel(run.previousThinking)
    if (run.config.restore.model && run.previousModel) await pi.setModel(run.previousModel)
  })

  pi.registerCommand('oracle', {
    description: 'Ask a configured expensive model with aggressive one-shot context reduction',
    async handler(args, ctx) {
      const question = args.trim()
      if (!question) {
        ctx.ui.notify('Usage: /oracle <question>', 'warning')
        return
      }

      if (activeRun) {
        ctx.ui.notify('An oracle request is already active.', 'warning')
        return
      }

      await ctx.waitForIdle()

      const config = loadOracleConfig(ctx.cwd)
      const previousModel = ctx.model
      const previousThinking = pi.getThinkingLevel()
      const previousTools = pi.getActiveTools()
      const targetModel = config.model ? resolveModelFromRegistry(ctx, config.model) : previousModel

      if (!targetModel) {
        ctx.ui.notify('Oracle model not found. Configure oracle.model as provider/model.', 'error')
        return
      }

      activeRun = {
        id: nextRunId++,
        question,
        config,
        previousModel,
        previousThinking,
        previousTools,
        customPrecompact: config.precompact.enabled && config.precompact.mode === 'custom'
      }

      try {
        await runCompaction(ctx, config)
        const switched = await pi.setModel(targetModel)
        if (!switched)
          throw new Error(`No auth configured for ${targetModel.provider}/${targetModel.id}`)
        pi.setThinkingLevel(config.thinking)
        pi.setActiveTools(toolNamesForPolicy(config.tools, previousTools, pi))
        pi.sendUserMessage(oracleUserPrompt(question))
      } catch (error) {
        const run = activeRun
        activeRun = undefined
        if (run?.config.restore.tools) pi.setActiveTools(run.previousTools)
        if (run?.config.restore.thinking) pi.setThinkingLevel(run.previousThinking)
        if (run?.config.restore.model && run.previousModel) await pi.setModel(run.previousModel)
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
      }
    }
  })
}
