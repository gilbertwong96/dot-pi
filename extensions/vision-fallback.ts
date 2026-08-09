import { createHash } from 'node:crypto'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'
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
 * Vision side-call chain (tried in order per image):
 *   1. ollama-cloud/kimi-k2.7-code  (OpenAI-compatible)
 *   2. minimax/MiniMax-M3           (Anthropic-compatible; used when Ollama Cloud is degraded)
 *
 * When a provider fails (quota/rate-limit/network), the next provider in the
 * chain is tried automatically for the same image, so a single failed call
 * never leaves the analysis permanently unavailable. Quota errors on Ollama
 * Cloud (main model or vision side calls) degrade the chain to skip Ollama
 * Cloud for the rest of the session.
 *
 * The side call is a raw HTTP request (the pi-ai provider subpath imports vary
 * between pi versions, so we construct the payloads ourselves). The
 * `vision_followup` tool re-queries a previously analyzed image for targeted
 * questions. Models that natively support images are never touched.
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
  degradedNotified: boolean
}

export function createState(): HandoffState {
  return { ollamaCloudDegraded: false, ollamaErrorStreak: 0, degradedNotified: false }
}

export function supportsImages(model: Model<Api> | undefined): boolean {
  return model?.input?.includes('image') ?? false
}

export function hasImageBlocks(message: AgentMessage): boolean {
  if (!('content' in message)) return false
  return Array.isArray(message.content) && message.content.some((block) => block.type === 'image')
}

export function isQuotaErrorText(text: string): boolean {
  return QUOTA_ERROR_PATTERN.test(text)
}

export function isQuotaError(message: AgentMessage): boolean {
  if (message.role !== 'assistant' || message.stopReason !== 'error') return false
  return isQuotaErrorText(message.errorMessage ?? '')
}

export function pickVisionTarget(state: HandoffState): Readonly<{ provider: string; id: string }> {
  return state.ollamaCloudDegraded ? VISION_CHAIN[1] : VISION_CHAIN[0]
}

export function pickVisionTargets(
  state: HandoffState
): ReadonlyArray<{ provider: string; id: string }> {
  return state.ollamaCloudDegraded ? VISION_CHAIN.slice(1) : VISION_CHAIN
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

type StoredImage = { data: string; mimeType: string }
type MessageBlock = { type: string; text?: string; data?: string; mimeType?: string }

interface ApiTextBlock {
  type?: string
  text?: unknown
}

interface ApiPayload {
  content?: unknown
  choices?: Array<{ message?: { content?: unknown } }>
  error?: unknown
}

function extractTextBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return (blocks as ApiTextBlock[])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
    .trim()
}

function formatApiError(status: number, payload: ApiPayload): string {
  const detail =
    payload.error !== undefined
      ? typeof payload.error === 'object'
        ? JSON.stringify(payload.error).slice(0, 200)
        : String(payload.error)
      : ''
  return `HTTP ${status}${detail ? `: ${detail}` : ''}`
}

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

  function notifyIfDegraded(ctx: ExtensionContext, state: HandoffState): void {
    if (!state.ollamaCloudDegraded || state.degradedNotified) return
    state.degradedNotified = true
    ctx.ui.notify(
      'Ollama Cloud rate-limited or out of quota — vision analysis will use MiniMax-M3',
      'warning'
    )
  }

  async function analyzeImage(
    model: Model<Api>,
    apiKey: string,
    image: StoredImage,
    prompt: string,
    signal: AbortSignal | undefined
  ): Promise<string> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), ANALYSIS_TIMEOUT_MS)
    const onAbort = () => ctrl.abort()
    if (signal) {
      if (signal.aborted) ctrl.abort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      const baseUrl = model.baseUrl.replace(/\/+$/, '')
      if (model.api === 'anthropic-messages') {
        const res = await fetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: model.id,
            max_tokens: ANALYSIS_MAX_TOKENS,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: prompt },
                  {
                    type: 'image',
                    source: { type: 'base64', media_type: image.mimeType, data: image.data }
                  }
                ]
              }
            ]
          }),
          signal: ctrl.signal
        })
        const payload = (await res.json().catch(() => ({}))) as ApiPayload
        if (!res.ok) throw new Error(formatApiError(res.status, payload))
        return extractTextBlocks(payload.content) || '(no analysis returned)'
      }
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: model.id,
          max_tokens: ANALYSIS_MAX_TOKENS,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                {
                  type: 'image_url',
                  image_url: { url: `data:${image.mimeType};base64,${image.data}` }
                }
              ]
            }
          ]
        }),
        signal: ctrl.signal
      })
      const payload = (await res.json().catch(() => ({}))) as ApiPayload
      if (!res.ok) throw new Error(formatApiError(res.status, payload))
      const content = payload.choices?.[0]?.message?.content
      const text = typeof content === 'string' ? content.trim() : extractTextBlocks(content)
      return text || '(no analysis returned)'
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }

  async function analyzeWithChain(
    state: HandoffState,
    ctx: ExtensionContext,
    image: StoredImage,
    prompt: string,
    signal: AbortSignal | undefined,
    notifyFailure: (provider: string, id: string, detail: string) => void
  ): Promise<string> {
    const targets = pickVisionTargets(state)
    for (const target of targets) {
      const model = ctx.modelRegistry.find(target.provider, target.id)
      if (!model || !supportsImages(model)) {
        notifyFailure(target.provider, target.id, 'model not found or not vision-capable')
        continue
      }
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(target.provider)
      if (!apiKey) {
        notifyFailure(target.provider, target.id, 'no API key configured')
        continue
      }
      try {
        const analysis = await analyzeImage(model, apiKey, image, prompt, signal)
        recordVisionError(state, target.provider, '')
        return analysis
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        recordVisionError(state, target.provider, detail)
        notifyFailure(target.provider, target.id, detail)
      }
    }
    const details = targets.map((t) => `${t.provider}/${t.id}`).join(', ')
    throw new Error(`all vision providers failed (${details})`)
  }

  async function transformMessageImages(
    message: AgentMessage,
    state: HandoffState,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined
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
          analysis = await analyzeWithChain(
            state,
            ctx,
            { data, mimeType },
            ANALYSIS_PROMPT,
            signal,
            (provider, modelId, detail) => {
              ctx.ui.notify(
                `Vision provider ${provider}/${modelId} failed: ${detail.slice(0, 200)}`,
                'warning'
              )
            }
          )
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
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
    const { message } = event
    const state = getState(ctx)

    // Consecutive quota/rate-limit errors on Ollama Cloud (main model or vision
    // side calls) degrade the vision chain to MiniMax-M3 for this session.
    if (
      message.role === 'assistant' &&
      'provider' in message &&
      message.provider === 'ollama-cloud'
    ) {
      recordVisionError(state, message.provider, message.errorMessage ?? '')
    }
    notifyIfDegraded(ctx, state)

    if (supportsImages(ctx.model)) return
    if (message.role !== 'user' && message.role !== 'toolResult') return
    if (!hasImageBlocks(message)) return

    const targets = pickVisionTargets(state)
    if (targets.length === 0) {
      ctx.ui.notify('Image detected but no vision model is configured', 'warning')
      return
    }
    const imageCount = Array.isArray(message.content)
      ? message.content.filter((block) => block.type === 'image').length
      : 0
    ctx.ui.notify(
      `Vision handoff: analyzing ${imageCount} image${imageCount > 1 ? 's' : ''} (chain: ${targets
        .map((t) => t.id)
        .join(' → ')})`,
      'info'
    )
    try {
      const transformed = await transformMessageImages(message, state, ctx, ctx.signal)
      notifyIfDegraded(ctx, state)
      if (transformed) {
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
      try {
        const answer = await analyzeWithChain(
          state,
          ctx,
          image,
          params.question,
          signal,
          (provider, modelId, detail) => {
            ctx.ui.notify(
              `Vision provider ${provider}/${modelId} failed: ${detail.slice(0, 200)}`,
              'warning'
            )
          }
        )
        notifyIfDegraded(ctx, state)
        return { content: [{ type: 'text', text: answer }], details: {} }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        return {
          content: [{ type: 'text', text: `Vision follow-up failed: ${detail}` }],
          details: {}
        }
      }
    }
  })
}
