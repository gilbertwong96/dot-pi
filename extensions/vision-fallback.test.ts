import { describe, expect, test } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'

import {
  createState,
  hasImageBlocks,
  isFallbackTarget,
  isQuotaError,
  pickFallbackTargets,
  supportsImages
} from './vision-fallback'

function model(provider: string, id: string, input: ('text' | 'image')[] = ['text']): Model<Api> {
  return { provider, id, input } as Model<Api>
}

function assistant(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    role: 'assistant',
    provider: 'ollama-cloud',
    model: 'deepseek-v4-flash:0731',
    api: 'openai-completions',
    content: [{ type: 'text', text: 'ok' }],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: Date.now(),
    ...overrides
  }
}

describe('supportsImages', () => {
  test('text-only model does not support images', () => {
    expect(supportsImages(model('ollama-cloud', 'deepseek-v4-flash:0731'))).toBe(false)
  })

  test('vision model supports images', () => {
    expect(supportsImages(model('ollama-cloud', 'kimi-k2.7-code', ['text', 'image']))).toBe(true)
  })

  test('missing model metadata defaults to text-only', () => {
    expect(supportsImages(undefined)).toBe(false)
    expect(supportsImages(model('p', 'm'))).toBe(false)
  })
})

describe('hasImageBlocks', () => {
  test('detects image blocks in user content', () => {
    const msg: AgentMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', image: 'data:image/png;base64,x' }
      ],
      timestamp: Date.now()
    }
    expect(hasImageBlocks(msg)).toBe(true)
  })

  test('text-only content has no images', () => {
    const msg: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'plain' }],
      timestamp: Date.now()
    }
    expect(hasImageBlocks(msg)).toBe(false)
  })

  test('string content has no images', () => {
    expect(hasImageBlocks({ role: 'user', content: 'plain', timestamp: Date.now() })).toBe(false)
  })
})

describe('isQuotaError', () => {
  test('matches rate-limit and quota patterns on errored assistant messages', () => {
    for (const errorMessage of [
      'Ollama Cloud rate limited. Try again shortly.',
      'HTTP 429 Too Many Requests',
      'insufficient quota for this plan',
      'monthly quota exhausted'
    ]) {
      expect(isQuotaError(assistant({ stopReason: 'error', errorMessage }))).toBe(true)
    }
  })

  test('ignores other errors and successful messages', () => {
    expect(
      isQuotaError(assistant({ stopReason: 'error', errorMessage: 'context_length_exceeded' }))
    ).toBe(false)
    expect(isQuotaError(assistant())).toBe(false)
  })

  test('ignores non-assistant messages', () => {
    const msg: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      timestamp: Date.now()
    }
    expect(isQuotaError(msg)).toBe(false)
  })
})

describe('isFallbackTarget', () => {
  test('recognizes the vision fallback models', () => {
    expect(isFallbackTarget(model('ollama-cloud', 'kimi-k2.7-code'))).toBe(true)
    expect(isFallbackTarget(model('minimax', 'MiniMax-M3'))).toBe(true)
  })

  test('rejects the home model and unknown models', () => {
    expect(isFallbackTarget(model('ollama-cloud', 'deepseek-v4-flash:0731'))).toBe(false)
    expect(isFallbackTarget(undefined)).toBe(false)
  })
})

describe('pickFallbackTargets', () => {
  test('healthy chain tries kimi first, then MiniMax-M3', () => {
    const targets = pickFallbackTargets(
      createState(),
      model('ollama-cloud', 'deepseek-v4-flash:0731')
    )
    expect(targets.map((t) => t.id)).toEqual(['kimi-k2.7-code', 'MiniMax-M3'])
  })

  test('degraded chain skips Ollama Cloud entirely', () => {
    const state = createState()
    state.ollamaCloudDegraded = true
    const targets = pickFallbackTargets(state, model('ollama-cloud', 'deepseek-v4-flash:0731'))
    expect(targets.map((t) => t.id)).toEqual(['MiniMax-M3'])
  })

  test('excludes the current model from the chain', () => {
    const targets = pickFallbackTargets(createState(), model('ollama-cloud', 'kimi-k2.7-code'))
    expect(targets.map((t) => t.id)).toEqual(['MiniMax-M3'])
  })
})
