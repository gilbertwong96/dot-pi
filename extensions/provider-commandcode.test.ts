import { afterEach, describe, expect, test } from 'vitest'
import type { RefreshModelsContext } from '@earendil-works/pi-ai'
import type {
  ExtensionAPI,
  ProviderConfig,
  ProviderModelConfig
} from '@earendil-works/pi-coding-agent'

import commandcode, { buildCommandCodeModel, knownCommandCodeModels } from './provider-commandcode'
import { COMMANDCODE_CATALOG } from './provider-commandcode-catalog.generated'

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
  config: ProviderConfig
  refreshModels: NonNullable<ProviderConfig['refreshModels']>
} {
  const captured: { config: ProviderConfig | undefined } = { config: undefined }
  const pi = {
    registerProvider: (_id: string, config: ProviderConfig) => {
      captured.config = config
    }
  } as unknown as ExtensionAPI

  commandcode(pi)

  const config = captured.config!
  if (!config.refreshModels) throw new Error('refreshModels not registered')
  return { config, refreshModels: config.refreshModels }
}

function seedBuiltModel(id: string) {
  return knownCommandCodeModels()
    .map(buildCommandCodeModel)
    .find((model) => model.id === id)
}

function makeContext(overrides: Partial<RefreshModelsContext> = {}): {
  context: RefreshModelsContext
  persisted: NonNullable<Parameters<RefreshModelsContext['publish']>[0]['persist']>[]
} {
  const persisted: NonNullable<Parameters<RefreshModelsContext['publish']>[0]['persist']>[] = []
  const context: RefreshModelsContext = {
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async (publication) => {
      if (publication.persist) persisted.push(publication.persist)
      return true
    },
    ...overrides
  }
  return { context, persisted }
}

function seedModels(): ProviderModelConfig[] {
  return knownCommandCodeModels().map(buildCommandCodeModel)
}

function apiKeyCredential() {
  return { type: 'api_key' as const, key: 'test-key' }
}

function stubCatalog(ids: string[]): void {
  globalThis.fetch = Object.assign(
    async () =>
      jsonResponse({
        data: ids.map((id) => ({ id, name: id, context_length: 1_000_000 }))
      }),
    { preconnect: originalFetch.preconnect }
  ) as typeof fetch
}

function stubFetchFailure(): void {
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error('unexpected network request')
    },
    { preconnect: originalFetch.preconnect }
  ) as typeof fetch
}

/** A persisted catalog entry as pi's FileModelsStore would hand it back. */
function storedCatalog(
  ids: string[],
  checkedAt: number
): NonNullable<RefreshModelsContext['stored']> {
  return {
    checkedAt,
    models: ids.map((id) => ({
      id,
      name: id,
      api: 'openai-completions',
      provider: 'commandcode',
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 999_000,
      maxTokens: 1_000
    }))
  } as NonNullable<RefreshModelsContext['stored']>
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
      cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'xhigh',
        max: 'max'
      },
      compat: { supportsReasoningEffort: true }
    })
  })

  test('deepseek v4.1-flash supports reasoning with off-peak pricing', () => {
    const result = buildCommandCodeModel({
      id: 'deepseek/deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash',
      context_length: 1_000_000
    })

    expect(result).toEqual({
      id: 'deepseek/deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'xhigh',
        max: 'max'
      },
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
})

describe('reasoning capability metadata', () => {
  test('marks multimodal overrides with text+image input', () => {
    const result = buildCommandCodeModel({
      id: 'moonshotai/Kimi-K3',
      name: 'Kimi K3',
      context_length: 1_000_000
    })

    expect(result.input).toEqual(['text', 'image'])
    expect(result.reasoning).toBe(true)
  })

  test('marks a probed reasoning model that has no override entry', () => {
    const result = buildCommandCodeModel({
      id: 'gpt-6-luna',
      name: 'GPT-6 Luna',
      context_length: 1_050_000
    })

    expect(result.reasoning).toBe(true)
    expect(result.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max'
    })
    expect(result.compat).toEqual({ supportsReasoningEffort: true })
  })

  test('hides the max level for models whose upstream rejects effort=max', () => {
    const result = buildCommandCodeModel({
      id: 'Qwen/Qwen3.7-Max',
      name: 'Qwen 3.7 Max',
      context_length: 1_000_000
    })

    expect(result.reasoning).toBe(true)
    expect(result.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: null
    })
  })

  test('hides medium for the Highspeed Kimi variant whose upstream rejects it', () => {
    const result = buildCommandCodeModel({
      id: 'moonshotai/Kimi-K2.7-Code-Highspeed',
      name: 'Kimi K2.7 Code HighSpeed',
      context_length: 262_000
    })

    expect(result.thinkingLevelMap).toMatchObject({
      low: 'low',
      medium: null,
      high: 'high',
      max: 'max'
    })
  })

  test('leaves models with no measured reasoning without thinking levels', () => {
    const result = buildCommandCodeModel({
      id: 'moonshotai/Kimi-K2.5',
      name: 'Kimi K2.5',
      context_length: 256_000
    })

    expect(result.reasoning).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(result, 'thinkingLevelMap')).toBe(false)
  })
})

describe('Claude routing', () => {
  test('routes Claude models through the Anthropic Messages API', () => {
    const result = buildCommandCodeModel({
      id: 'claude-opus-5',
      name: 'Claude Opus 5',
      context_length: 1_000_000
    })

    expect(result.api).toBe('anthropic-messages')
    expect(result.baseUrl).toBe('https://api.commandcode.ai/provider')
    expect(result.reasoning).toBe(true)
    expect(result.thinkingLevelMap).toEqual({ off: null, xhigh: 'xhigh', max: 'max' })
    expect(result.compat).toEqual({ forceAdaptiveThinking: true, supportsTemperature: false })
    expect(result.input).toEqual(['text', 'image'])
  })

  test('routes every catalog Claude model through the Anthropic Messages API', () => {
    const unrouted = COMMANDCODE_CATALOG.filter((entry) => entry.id.startsWith('claude-'))
      .map((entry) => entry.id)
      .filter((id) => seedBuiltModel(id)?.api !== 'anthropic-messages')

    expect(unrouted).toEqual([])
  })
})

describe('commandcode provider registration', () => {
  test('registers with the commandcode id, openai-completions api, and a seeded model list', () => {
    const { config } = captureProviderConfig()

    expect(config).toMatchObject({
      name: 'Command Code',
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      apiKey: '$COMMANDCODE_API_KEY',
      api: 'openai-completions'
    })
    expect(typeof config.refreshModels).toBe('function')

    // A registry that enumerates providers at session start must see the known
    // models, or it cannot resolve one by id before the picker has refreshed.
    const ids = (config.models ?? []).map((model) => model.id)
    expect(ids).toContain('deepseek/deepseek-v4.1-flash')
    expect(ids.length).toBeGreaterThan(1)
    expect(config.models).toEqual(seedModels())
  })

  test('seeds the whole baked catalog', () => {
    const ids = new Set((captureProviderConfig().config.models ?? []).map((model) => model.id))

    expect(COMMANDCODE_CATALOG.filter((entry) => !ids.has(entry.id))).toEqual([])
  })

  test('seeds the upstream context window instead of the 128K default', () => {
    expect(seedBuiltModel('deepseek/deepseek-v4.1-flash')?.contextWindow).toBe(1_000_000)
    expect(seedBuiltModel('claude-haiku-4-5-20251001')?.contextWindow).toBe(200_000)
    expect(seedBuiltModel('gpt-5.5')?.contextWindow).toBe(400_000)
  })
})

describe('refreshModels fallback', () => {
  test('returns the seed catalog instead of an empty list when no credential resolves', async () => {
    stubFetchFailure()
    const { refreshModels } = captureProviderConfig()
    const { context } = makeContext()

    const models = await refreshModels(context)

    expect(models.map((model) => model.id)).toEqual(seedModels().map((model) => model.id))
  })

  test('returns the seed catalog without touching the network in the cache-only phase', async () => {
    stubFetchFailure()
    const { refreshModels } = captureProviderConfig()
    const { context } = makeContext({ allowNetwork: false, credential: apiKeyCredential() })

    const models = await refreshModels(context)

    expect(models.map((model) => model.id)).toEqual(seedModels().map((model) => model.id))
  })

  test('restores the catalog persisted by an earlier session', async () => {
    stubFetchFailure()
    const { refreshModels } = captureProviderConfig()
    const stored = storedCatalog(['stored/from-disc'], Date.now())
    const { context } = makeContext({
      allowNetwork: false,
      credential: apiKeyCredential(),
      stored
    })

    const models = await refreshModels(context)

    expect(models).toEqual(stored.models)
  })
})

describe('refreshModels network', () => {
  test('fetches the upstream models and applies overrides', async () => {
    stubCatalog(['deepseek/deepseek-v4-flash', 'moonshotai/Kimi-K3', 'fresh/upstream-only'])
    const { refreshModels } = captureProviderConfig()
    const { context } = makeContext({ credential: apiKeyCredential() })

    const models = await refreshModels(context)

    expect(models).toHaveLength(3)
    expect(models[0]).toMatchObject({
      id: 'deepseek/deepseek-v4-flash',
      contextWindow: 1_000_000,
      reasoning: true,
      cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
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
      contextWindow: 1_000_000,
      maxTokens: 8_192
    })
  })

  test('persists the fetched catalog so the next session starts from it', async () => {
    stubCatalog(['deepseek/deepseek-v4.1-flash', 'claude-sonnet-5-5'])
    const { refreshModels } = captureProviderConfig()
    const { context, persisted } = makeContext({ credential: apiKeyCredential() })

    const models = await refreshModels(context)

    expect(persisted).toHaveLength(1)
    expect(persisted[0].checkedAt).toBeTypeOf('number')
    expect(persisted[0].models.map((model) => model.id)).toEqual(models.map((model) => model.id))
    // The store is typed to pi-ai's Model shape, so the provider identity
    // fields the composer otherwise fills in have to be written with it.
    expect(persisted[0].models[0]).toMatchObject({
      provider: 'commandcode',
      api: 'openai-completions',
      baseUrl: 'https://api.commandcode.ai/provider/v1'
    })
    expect(persisted[0].models[1]).toMatchObject({
      provider: 'commandcode',
      api: 'anthropic-messages',
      baseUrl: 'https://api.commandcode.ai/provider'
    })
  })

  test('keeps the persisted catalog while it is fresh instead of refetching', async () => {
    stubFetchFailure()
    const { refreshModels } = captureProviderConfig()
    const stored = storedCatalog(['stored/fresh'], Date.now())
    const { context } = makeContext({ credential: apiKeyCredential(), stored })

    const models = await refreshModels(context)

    expect(models.map((model) => model.id)).toEqual(['stored/fresh'])
  })

  test('refetches a stale persisted catalog', async () => {
    stubCatalog(['fresh/upstream'])
    const { refreshModels } = captureProviderConfig()
    const stored = storedCatalog(['stored/stale'], Date.now() - 5 * 60 * 60 * 1000)
    const { context } = makeContext({ credential: apiKeyCredential(), stored })

    const models = await refreshModels(context)

    expect(models.map((model) => model.id)).toEqual(['fresh/upstream'])
  })

  test('refetches a fresh persisted catalog when the refresh is forced', async () => {
    stubCatalog(['fresh/upstream'])
    const { refreshModels } = captureProviderConfig()
    const stored = storedCatalog(['stored/fresh'], Date.now())
    const { context } = makeContext({ credential: apiKeyCredential(), stored, force: true })

    const models = await refreshModels(context)

    expect(models.map((model) => model.id)).toEqual(['fresh/upstream'])
  })

  test('keeps the fallback when the upstream reports no models', async () => {
    stubCatalog([])
    const { refreshModels } = captureProviderConfig()
    const { context, persisted } = makeContext({ credential: apiKeyCredential() })

    const models = await refreshModels(context)

    expect(models.map((model) => model.id)).toEqual(seedModels().map((model) => model.id))
    expect(persisted).toEqual([])
  })

  test('keeps the fallback when the refresh is aborted mid-flight', async () => {
    const controller = new AbortController()
    globalThis.fetch = Object.assign(
      async () => {
        controller.abort()
        throw new Error('aborted')
      },
      { preconnect: originalFetch.preconnect }
    ) as typeof fetch
    const { refreshModels } = captureProviderConfig()
    const { context, persisted } = makeContext({
      credential: apiKeyCredential(),
      signal: controller.signal
    })

    const models = await refreshModels(context)

    expect(models.map((model) => model.id)).toEqual(seedModels().map((model) => model.id))
    expect(persisted).toEqual([])
  })
})
