import { afterEach, describe, expect, test } from 'vitest'
import type { ExtensionAPI, ProviderConfigInput } from '@earendil-works/pi-coding-agent'

import commandcode, { buildCommandCodeModel, COMMANDCODE_OVERRIDES } from './provider-commandcode'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function captureProviderConfig(): {
  config: ProviderConfigInput
  refreshModels: NonNullable<ProviderConfigInput['refreshModels']>
} {
  const captured: { config: ProviderConfigInput | undefined } = { config: undefined }
  const pi = {
    registerProvider: (_id: string, config: ProviderConfigInput) => {
      captured.config = config
    }
  } as unknown as ExtensionAPI

  commandcode(pi)

  const config = captured.config!
  if (!config.refreshModels) throw new Error('refreshModels not registered')
  return { config, refreshModels: config.refreshModels }
}

describe('buildCommandCodeModel', () => {
  test('applies the full override when the model id is known', () => {
    const entry = {
      id: 'deepseek/deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      context_length: 1_000_000
    }

    const result = buildCommandCodeModel(entry)

    expect(result).toEqual({
      id: 'deepseek/deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      reasoning: true,
      input: ['text'],
      cost: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      thinkingLevelMap: COMMANDCODE_OVERRIDES['deepseek/deepseek-v4-flash']!.thinkingLevelMap,
      compat: { supportsReasoningEffort: true }
    })
  })

  test('lifts context_length from upstream when no override provides one', () => {
    const result = buildCommandCodeModel({
      id: 'unknown/model',
      name: 'Unknown Model',
      context_length: 500_000
    })

    expect(result.contextWindow).toBe(500_000)
  })

  test('falls back to the default context window when upstream omits context_length', () => {
    const result = buildCommandCodeModel({ id: 'm', name: 'M' })

    expect(result.contextWindow).toBe(128_000)
  })

  test('caps default maxTokens at the smaller of context window and 8192', () => {
    const small = buildCommandCodeModel({ id: 'm', name: 'M', context_length: 4_000 })
    expect(small.maxTokens).toBe(4_000)

    const big = buildCommandCodeModel({ id: 'm', name: 'M', context_length: 1_000_000 })
    expect(big.maxTokens).toBe(8_192)
  })

  test('prefers the override maxTokens over the default cap', () => {
    const result = buildCommandCodeModel({
      id: 'deepseek/deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      context_length: 1_000_000
    })

    expect(result.maxTokens).toBe(384_000)
  })

  test('uses safe defaults when no override exists', () => {
    const result = buildCommandCodeModel({ id: 'some/new-model', name: 'Some New Model' })

    expect(result).toEqual({
      id: 'some/new-model',
      name: 'Some New Model',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192
    })
    expect(Object.prototype.hasOwnProperty.call(result, 'thinkingLevelMap')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(result, 'compat')).toBe(false)
  })

  test('marks multimodal overrides with text+image input', () => {
    const result = buildCommandCodeModel({
      id: 'moonshotai/Kimi-K3',
      name: 'Kimi K3',
      context_length: 1_000_000
    })

    expect(result.input).toEqual(['text', 'image'])
    expect(result.reasoning).toBe(false)
  })
})

describe('commandcode provider registration', () => {
  test('registers with the commandcode id, openai-completions api, and empty seed list', () => {
    const { config } = captureProviderConfig()

    expect(config).toMatchObject({
      name: 'Command Code',
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      apiKey: '$COMMANDCODE_API_KEY',
      api: 'openai-completions',
      models: []
    })
    expect(typeof config.refreshModels).toBe('function')
  })

  test('refreshModels returns an empty list when no api_key credential is available', async () => {
    const { refreshModels } = captureProviderConfig()

    const result = await refreshModels({
      allowNetwork: true,
      signal: new AbortController().signal,
      publish: async () => true
    })

    expect(result).toEqual([])
  })

  test('refreshModels fetches upstream models and applies overrides', async () => {
    globalThis.fetch = Object.assign(
      async () =>
        jsonResponse({
          data: [
            {
              id: 'deepseek/deepseek-v4-flash',
              name: 'DeepSeek V4 Flash',
              context_length: 1_000_000
            },
            { id: 'moonshotai/Kimi-K3', name: 'Kimi K3', context_length: 1_000_000 },
            { id: 'fresh/upstream-only', name: 'Fresh', context_length: 64_000 }
          ]
        }),
      { preconnect: originalFetch.preconnect }
    ) as typeof fetch

    const { refreshModels } = captureProviderConfig()
    const models = await refreshModels({
      credential: { type: 'api_key', key: 'test-key' },
      allowNetwork: true,
      signal: new AbortController().signal,
      publish: async () => true
    })

    expect(models).toHaveLength(3)
    expect(models[0]).toMatchObject({
      id: 'deepseek/deepseek-v4-flash',
      reasoning: true,
      cost: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
      maxTokens: 384_000
    })
    expect(models[1]).toMatchObject({
      id: 'moonshotai/Kimi-K3',
      input: ['text', 'image'],
      cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 0 }
    })
    expect(models[2]).toMatchObject({
      id: 'fresh/upstream-only',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 64_000,
      maxTokens: 8_192
    })
  })
})
