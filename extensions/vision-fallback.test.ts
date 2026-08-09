import { describe, expect, test } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'

import {
  buildAnalysisBlock,
  createState,
  hasImageBlocks,
  hashImageId,
  isQuotaError,
  isQuotaErrorText,
  pickVisionTarget,
  pickVisionTargets,
  supportsImages
} from './vision-fallback'

function model(provider: string, id: string, input: ('text' | 'image')[] = ['text']): Model<Api> {
  return { provider, id, input } as Model<Api>
}

function assistant(overrides: Partial<Parameters<typeof isQuotaError>[0]> = {}) {
  return {
    role: 'assistant' as const,
    provider: 'ollama-cloud',
    model: 'deepseek-v4-flash:0731',
    api: 'openai-completions',
    content: [{ type: 'text' as const, text: 'ok' }],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop' as const,
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
        { type: 'image', data: 'x', mimeType: 'image/png' }
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

describe('isQuotaErrorText', () => {
  test('matches rate-limit and quota patterns', () => {
    for (const text of [
      'Ollama Cloud rate limited. Try again shortly.',
      'HTTP 429 Too Many Requests',
      'insufficient quota for this plan',
      'monthly quota exhausted'
    ]) {
      expect(isQuotaErrorText(text)).toBe(true)
    }
  })

  test('ignores other errors', () => {
    expect(isQuotaErrorText('context_length_exceeded')).toBe(false)
    expect(isQuotaErrorText('connection reset')).toBe(false)
  })
})

describe('isQuotaError', () => {
  test('matches quota patterns on errored assistant messages', () => {
    expect(
      isQuotaError(
        assistant({
          stopReason: 'error',
          errorMessage: 'Ollama Cloud rate limited. Try again shortly.'
        })
      )
    ).toBe(true)
  })

  test('ignores other errors and successful messages', () => {
    expect(
      isQuotaError(assistant({ stopReason: 'error', errorMessage: 'context_length_exceeded' }))
    ).toBe(false)
    expect(isQuotaError(assistant())).toBe(false)
  })
})

describe('pickVisionTarget', () => {
  test('healthy chain uses kimi-k2.7-code first', () => {
    expect(pickVisionTarget(createState())).toEqual({
      provider: 'ollama-cloud',
      id: 'kimi-k2.7-code'
    })
  })

  test('degraded chain skips Ollama Cloud entirely', () => {
    const state = createState()
    state.ollamaCloudDegraded = true
    expect(pickVisionTarget(state)).toEqual({ provider: 'minimax', id: 'MiniMax-M3' })
  })
})

describe('pickVisionTargets', () => {
  test('healthy chain tries Ollama Cloud first, then MiniMax', () => {
    expect(pickVisionTargets(createState())).toEqual([
      { provider: 'ollama-cloud', id: 'kimi-k2.7-code' },
      { provider: 'minimax', id: 'MiniMax-M3' }
    ])
  })

  test('degraded chain skips Ollama Cloud', () => {
    const state = createState()
    state.ollamaCloudDegraded = true
    expect(pickVisionTargets(state)).toEqual([{ provider: 'minimax', id: 'MiniMax-M3' }])
  })
})

describe('hashImageId', () => {
  test('produces stable prefixed ids from image bytes', () => {
    const a = hashImageId('same-bytes')
    expect(a).toBe(hashImageId('same-bytes'))
    expect(a).toMatch(/^img_[0-9a-f]{8}$/)
    expect(a).not.toBe(hashImageId('other-bytes'))
  })
})

describe('buildAnalysisBlock', () => {
  test('embeds the image id and analysis in a text block', () => {
    const block = buildAnalysisBlock('img_abc123', 'The screenshot shows a portfolio dashboard.')
    expect(block).toEqual({
      type: 'text',
      text: '[Image analysis (image:img_abc123)]: The screenshot shows a portfolio dashboard.'
    })
  })
})
