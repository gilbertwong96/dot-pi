import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { Api, Model } from '@earendil-works/pi-ai'

/**
 * Vision fallback: when an image enters the session but the active model
 * cannot accept images, switch to a vision-capable model automatically.
 *
 * Fallback chain (when the active model lacks vision):
 *   1. ollama-cloud/kimi-k2.7-code
 *   2. minimax/MiniMax-M3 (used directly when Ollama Cloud is degraded)
 *
 * Switches back to the original model when a text-only user message arrives.
 * Manual model changes via /model always cancel the automatic behavior.
 */

const FALLBACK_CHAIN: ReadonlyArray<{ provider: string; id: string }> = [
  { provider: 'ollama-cloud', id: 'kimi-k2.7-code' },
  { provider: 'minimax', id: 'MiniMax-M3' }
]

const OLLAMA_PROVIDER = 'ollama-cloud'
const QUOTA_ERROR_PATTERN = /rate\s*limit|429|quota|exhausted/i
const QUOTA_STREAK_THRESHOLD = 2
const SWITCH_DEBOUNCE_MS = 5000

export interface VisionFallbackState {
  homeModel: { provider: string; id: string } | null
  fallbackActive: boolean
  ollamaCloudDegraded: boolean
  ollamaErrorStreak: number
  pendingSwitchBack: boolean
  internalSwitch: boolean
  lastSwitchAt: number
}

export function createState(): VisionFallbackState {
  return {
    homeModel: null,
    fallbackActive: false,
    ollamaCloudDegraded: false,
    ollamaErrorStreak: 0,
    pendingSwitchBack: false,
    internalSwitch: false,
    lastSwitchAt: 0
  }
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

export function isFallbackTarget(model: Model<Api> | undefined): boolean {
  if (!model) return false
  return FALLBACK_CHAIN.some((t) => t.provider === model.provider && t.id === model.id)
}

export function pickFallbackTargets(
  state: VisionFallbackState,
  current: Model<Api> | undefined
): ReadonlyArray<{ provider: string; id: string }> {
  const chain = state.ollamaCloudDegraded ? FALLBACK_CHAIN.slice(1) : FALLBACK_CHAIN
  return chain.filter((t) => !(t.provider === current?.provider && t.id === current?.id))
}

export default function visionFallback(pi: ExtensionAPI) {
  const states = new Map<string, VisionFallbackState>()

  function getState(ctx: ExtensionContext): VisionFallbackState {
    const sessionId = ctx.sessionManager.getSessionId()
    let state = states.get(sessionId)
    if (!state) {
      state = createState()
      states.set(sessionId, state)
    }
    return state
  }

  async function applyModelSwitch(
    ctx: ExtensionContext,
    state: VisionFallbackState,
    target: { provider: string; id: string },
    notify: string
  ): Promise<boolean> {
    const model = ctx.modelRegistry.find(target.provider, target.id)
    if (!model) return false

    state.internalSwitch = true
    try {
      if (!(await pi.setModel(model))) return false
    } finally {
      state.internalSwitch = false
    }
    ctx.ui.notify(notify, 'info')
    return true
  }

  async function switchToVision(ctx: ExtensionContext, state: VisionFallbackState): Promise<void> {
    const current = ctx.model
    if (!current || supportsImages(current) || state.internalSwitch) return
    if (state.fallbackActive && Date.now() - state.lastSwitchAt < SWITCH_DEBOUNCE_MS) return

    for (const target of pickFallbackTargets(state, current)) {
      const model = ctx.modelRegistry.find(target.provider, target.id)
      if (!model || !supportsImages(model)) continue
      if (!state.homeModel) {
        state.homeModel = { provider: current.provider, id: current.id }
      }
      const switched = await applyModelSwitch(
        ctx,
        state,
        target,
        `Image detected — switched to ${target.id} (vision)`
      )
      if (!switched) continue
      state.fallbackActive = true
      state.pendingSwitchBack = false
      state.lastSwitchAt = Date.now()
      return
    }
    ctx.ui.notify('Image detected but no vision-capable model is available', 'warning')
  }

  async function switchToHome(ctx: ExtensionContext, state: VisionFallbackState): Promise<void> {
    const home = state.homeModel
    if (!home || !state.fallbackActive) return
    if (!isFallbackTarget(ctx.model)) return

    const switched = await applyModelSwitch(ctx, state, home, `Switched back to ${home.id}`)
    if (!switched) {
      ctx.ui.notify(`Could not switch back to ${home.provider}/${home.id}`, 'warning')
    }
    state.fallbackActive = false
    state.homeModel = null
    state.pendingSwitchBack = false
  }

  async function requestSwitchBack(
    ctx: ExtensionContext,
    state: VisionFallbackState
  ): Promise<void> {
    if (!state.fallbackActive || !state.homeModel) return
    if (!isFallbackTarget(ctx.model)) return
    if (ctx.isIdle()) {
      await switchToHome(ctx, state)
    } else {
      state.pendingSwitchBack = true
    }
  }

  pi.on('session_start', (event, ctx) => {
    states.set(ctx.sessionManager.getSessionId(), createState())
  })

  pi.on('session_shutdown', (event, ctx) => {
    states.delete(ctx.sessionManager.getSessionId())
  })

  pi.on('input', async (event, ctx) => {
    const state = getState(ctx)
    if (event.images?.length) {
      await switchToVision(ctx, state)
    } else {
      await requestSwitchBack(ctx, state)
    }
  })

  pi.on('message_start', async (event, ctx) => {
    const state = getState(ctx)
    const { message } = event
    if (message.role === 'user' || message.role === 'toolResult') {
      if (hasImageBlocks(message)) {
        await switchToVision(ctx, state)
      } else if (message.role === 'user') {
        await requestSwitchBack(ctx, state)
      }
    }
  })

  pi.on('message_end', async (event, ctx) => {
    const state = getState(ctx)
    const { message } = event
    if (message.role !== 'assistant' || message.provider !== OLLAMA_PROVIDER) return

    if (isQuotaError(message)) {
      state.ollamaErrorStreak += 1
      if (state.ollamaErrorStreak >= QUOTA_STREAK_THRESHOLD && !state.ollamaCloudDegraded) {
        state.ollamaCloudDegraded = true
        ctx.ui.notify(
          'Ollama Cloud rate-limited or out of quota — image fallback will use MiniMax-M3',
          'warning'
        )
        const current = ctx.model
        if (current?.provider === OLLAMA_PROVIDER && isFallbackTarget(current)) {
          const switched = await applyModelSwitch(
            ctx,
            state,
            FALLBACK_CHAIN[1],
            'Ollama Cloud degraded — switched to MiniMax-M3'
          )
          if (!switched) {
            ctx.ui.notify('Could not switch to MiniMax-M3', 'warning')
          }
        }
      }
    } else {
      state.ollamaErrorStreak = 0
    }
  })

  pi.on('agent_end', async (event, ctx) => {
    const state = getState(ctx)
    if (state.pendingSwitchBack) {
      await switchToHome(ctx, state)
    }
  })

  pi.on('model_select', (event, ctx) => {
    const state = getState(ctx)
    if (state.internalSwitch) return
    state.fallbackActive = false
    state.homeModel = null
    state.pendingSwitchBack = false
  })
}
