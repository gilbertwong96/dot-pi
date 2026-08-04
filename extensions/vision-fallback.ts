import { createHash } from 'node:crypto'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { streamSimpleAnthropic } from '@earendil-works/pi-ai/anthropic'
import { streamSimpleOpenAICompletions } from '@earendil-works/pi-ai/openai-completions'
import type { Api, ImageContent, Model } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

/**
 * Client-side vision handoff (pattern from pi-provider-umans).
 *
 * When an image enters the session but the active model cannot accept images
 * (e.g. deepseek-v4-flash:0731), analyze the image with a native-vision model
 * in a side call and replace the image block with `[Image analysis (image:ID)]:
 * ...` text. The analysis persists in the conversation, so it is not
 * re-analyzed on later turns, and the main model never changes.
 *
 * Vision side-call chain:
 *   1. ollama-cloud/kimi-k2.7-code
 *   2. minimax/MiniMax-M3 (used directly when Ollama Cloud is degraded)
 *
 * The `vision_followup` tool re-queries a previously analyzed image for
 * targeted questions. Models that natively support images are never touched.
 */

const VISION_CHAIN: ReadonlyArray<{ provider: string; id: string }> = [
  { provider: 'ollama-cloud', id: 'kimi-k2.7-code' },
  { provider: 'minimax', id: 'MiniMax-M3' }
]

const QUOTA_ERROR_PATTERN = /rate\s*limit|429|quota|exhausted/i
const QUOTA_STREAK_THRESHOLD = 2
const ANALYSIS_MAX_TOKENS = 1024
const ANALYSIS_TIMEOUT_MS = 60_000

const ANALYSIS_PROMPT =
  'You are a vision assistant for a text-only coding model. Analyze the attached image thoroughly but concisely. ' +
  'Capture: any visible text (verbatim), UI/layout, code/errors/stack traces, diagrams/charts, and other notable details. ' +
  'Write a compact structured report. Do not speculate beyond what is visible.'

export interface HandoffState {
  ollamaCloudDegraded: boolean
  ollamaErrorStreak: number
}

export function createState(): HandoffState {
  return { ollamaCloudDegraded: false, ollamaErrorStreak: 0 }
}

export function supportsImages(model: Model<Api> | undefined): boolean {
  return model?.input?.includes('image') ?? false
}

export function hasImageBlocks(message: AgentMessage): boolean {
  if (!('content' in message)) return false
  return Array.isArray(message.content) && message.content.some((block) => block.type === 'image')
}

export function isQuotaError(message: AgentMessage): boolean {
  if (message.role !== 'assistant' || message.stopReason !== 'error') return false
  return QUOTA_ERROR_PATTERN.test(message.errorMessage ?? '')
}

export function isQuotaErrorText(text: string): boolean {
  return QUOTA_ERROR_PATTERN.test(text)
}

export function pickVisionTarget(state: HandoffState): Readonly<{ provider: string; id: string }> {
  return state.ollamaCloudDegraded ? VISION_CHAIN[1] : VISION_CHAIN[0]
}

export function hashImageId(data: string): string {
  return 'img_' + createHash('sha256').update(data).digest('hex').slice(0, 8)
}

export function buildAnalysisBlock(
  imageId: string,
  analysis: string
): { type: 'text'; text: string } {
  return { type: 'text', text: `[Image analysis (image:${imageId})]: ${analysis}` }
}

type MessageBlock = { type: string; text?: string; data?: string; mimeType?: string }

type StoredImage = { data: string; mimeType: string }

export default function visionFallback(pi: ExtensionAPI) {
  const states = new Map<string, HandoffState>()
  const imageStore = new Map<string, StoredImage>()

  function getState(ctx: ExtensionContext): HandoffState {
    const sessionId = ctx.sessionManager.getSessionId()
    let state = states.get(sessionId)
    if (!state) {
      state = createState()
      states.set(sessionId, state)
    }
    return state
  }

  function recordVisionError(state: HandoffState, provider: string, errorMessage: string): void {
    if (provider !== VISION_CHAIN[0].provider) return
    if (!isQuotaErrorText(errorMessage)) {
      state.ollamaErrorStreak = 0
      return
    }
    state.ollamaErrorStreak += 1
    if (state.ollamaErrorStreak >= QUOTA_STREAK_THRESHOLD) {
      state.ollamaCloudDegraded = true
    }
  }

  async function analyzeImage(
    model: Model<Api>,
    apiKey: string,
    image: StoredImage,
    prompt: string,
    signal: AbortSignal | undefined
  ): Promise<string> {
    const content: Array<{ type: 'text'; text: string } | ImageContent> = [
      { type: 'text', text: prompt },
      { type: 'image', data: image.data, mimeType: image.mimeType }
    ]
    const context = {
      messages: [{ role: 'user' as const, content, timestamp: Date.now() }],
      tools: []
    }
    const options = {
      apiKey,
      signal,
      maxRetries: 0,
      maxTokens: ANALYSIS_MAX_TOKENS,
      timeoutMs: ANALYSIS_TIMEOUT_MS
    }

    let stream
    if (model.api === 'anthropic-messages') {
      stream = streamSimpleAnthropic(
        model as unknown as Model<'anthropic-messages'>,
        context,
        options
      )
    } else {
      stream = streamSimpleOpenAICompletions(
        model as unknown as Model<'openai-completions'>,
        context,
        options
      )
    }

    const message = await stream.result()
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      throw new Error(
        message.errorMessage || `Vision model ${model.id} failed (${message.stopReason})`
      )
    }
    const text = message.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim()
    return text || '(no analysis returned)'
  }

  async function transformMessageImages(
    message: AgentMessage,
    model: Model<Api>,
    apiKey: string,
    signal: AbortSignal | undefined,
    state: HandoffState
  ): Promise<AgentMessage | undefined> {
    if (!('content' in message)) return undefined
    const content = Array.isArray(message.content) ? (message.content as MessageBlock[]) : null
    if (!content) return undefined

    const replacements = new Map<number, { type: 'text'; text: string }>()
    await Promise.all(
      content.map(async (block, index) => {
        if (block.type !== 'image') return
        const data = block.data ?? ''
        const mimeType = block.mimeType ?? 'image/png'
        const id = hashImageId(data)
        imageStore.set(id, { data, mimeType })
        let analysis: string
        try {
          analysis = await analyzeImage(model, apiKey, { data, mimeType }, ANALYSIS_PROMPT, signal)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          recordVisionError(state, model.provider, detail)
          analysis = `analysis unavailable (${detail}); call the vision_followup tool with image id ${id} to retry`
        }
        replacements.set(index, buildAnalysisBlock(id, analysis))
      })
    )

    if (replacements.size === 0) return undefined
    return {
      ...message,
      content: content.map((block, index) => replacements.get(index) ?? block)
    } as AgentMessage
  }

  pi.on('session_start', (event, ctx) => {
    states.set(ctx.sessionManager.getSessionId(), createState())
    imageStore.clear()
  })

  pi.on('session_shutdown', (event, ctx) => {
    states.delete(ctx.sessionManager.getSessionId())
    imageStore.clear()
  })

  // Intercept images headed to a text-only model and replace them with
  // persisted analysis text. Runs on the finalized user / toolResult message
  // before the next LLM call, so the text model never sees the raw image and
  // the analysis sticks in history (KV-cache friendly: no re-analysis).
  pi.on('message_end', async (event, ctx) => {
    if (supportsImages(ctx.model)) return
    const { message } = event
    if (message.role !== 'user' && message.role !== 'toolResult') return
    if (!hasImageBlocks(message)) return

    const state = getState(ctx)
    const target = pickVisionTarget(state)
    if (!target) {
      ctx.ui.notify('Image detected but no vision model is configured', 'warning')
      return
    }
    const model = ctx.modelRegistry.find(target.provider, target.id)
    if (!model || !supportsImages(model)) {
      ctx.ui.notify(
        `Image detected but vision model ${target.provider}/${target.id} is unavailable`,
        'warning'
      )
      return
    }
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(target.provider)
    if (!apiKey) {
      ctx.ui.notify(`Image detected but no API key for ${target.provider}`, 'warning')
      return
    }

    const imageCount = Array.isArray(message.content)
      ? message.content.filter((block) => block.type === 'image').length
      : 0
    ctx.ui.notify(
      `Vision handoff: analyzing ${imageCount} image${imageCount > 1 ? 's' : ''} with ${target.id}`,
      'info'
    )
    try {
      const transformed = await transformMessageImages(message, model, apiKey, ctx.signal, state)
      if (transformed) {
        if (state.ollamaCloudDegraded) {
          ctx.ui.notify(
            'Ollama Cloud rate-limited or out of quota — vision analysis will use MiniMax-M3',
            'warning'
          )
        }
        return { message: transformed }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      ctx.ui.notify(`Vision handoff failed: ${detail}`, 'error')
    }
  })

  pi.registerTool({
    name: 'vision_followup',
    label: 'Vision Follow-up',
    description:
      'Ask a targeted question about an image that was summarized into an `[Image analysis (image:ID)]` ' +
      'block. Use when the initial summary omits a specific detail you need (text, region, color, layout). ' +
      'Pass the image ID from the block and your question.',
    promptSnippet: 'Ask the vision model a targeted follow-up about an analyzed image',
    promptGuidelines: [
      'Use vision_followup to ask a targeted follow-up about any `[Image analysis (image:ID)]` block ' +
        'when the initial summary lacks a specific detail you need (text, region, color, layout). ' +
        'Pass the image ID and your question.'
    ],
    parameters: Type.Object({
      image_id: Type.String({
        description: 'Image ID from the `[Image analysis (image:ID)]` block'
      }),
      question: Type.String({ description: 'The specific question to answer about the image' })
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const image = imageStore.get(params.image_id)
      if (!image) {
        return {
          content: [
            {
              type: 'text',
              text:
                `Image ${params.image_id} is not available in this session ` +
                '(it predates the session or the session was reloaded). ' +
                'Only the initial analysis in the conversation remains.'
            }
          ],
          details: {}
        }
      }
      const state = getState(ctx)
      const target = pickVisionTarget(state)
      const model = target ? ctx.modelRegistry.find(target.provider, target.id) : undefined
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(target?.provider ?? '')
      if (!model || !apiKey) {
        return {
          content: [
            { type: 'text', text: 'Vision model or API key unavailable; cannot query the image.' }
          ],
          details: {}
        }
      }
      try {
        const answer = await analyzeImage(model, apiKey, image, params.question, signal)
        return { content: [{ type: 'text', text: answer }], details: {} }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        recordVisionError(state, model.provider, detail)
        return {
          content: [{ type: 'text', text: `Vision follow-up failed: ${detail}` }],
          details: {}
        }
      }
    }
  })
}
