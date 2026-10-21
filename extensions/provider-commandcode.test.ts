import { afterEach, describe, expect, test } from 'vitest'
import type { RefreshModelsContext } from '@earendil-works/pi-ai'
import type {
  BeforeProviderRequestEvent,
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
  ProviderConfig,
  ProviderModelConfig
} from '@earendil-works/pi-coding-agent'

import commandcode, {
  asBudgetOverflow,
  buildCommandCodeModel,
  clampCompletionBudget,
  knownCommandCodeModels
} from './provider-commandcode'
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
    },
    on: () => () => undefined
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

type RequestPayloadHandler = (event: BeforeProviderRequestEvent, ctx: ExtensionContext) => unknown
type MessageEndHandler = (event: MessageEndEvent, ctx: ExtensionContext) => unknown

function captureHandlers(): {
  beforeProviderRequest: RequestPayloadHandler
  messageEnd: MessageEndHandler
} {
  const handlers: {
    beforeProviderRequest: RequestPayloadHandler | undefined
    messageEnd: MessageEndHandler | undefined
  } = { beforeProviderRequest: undefined, messageEnd: undefined }

  const pi = {
    registerProvider: () => undefined,
    on: (name: string, handler: unknown) => {
      if (name === 'before_provider_request') {
        handlers.beforeProviderRequest = handler as RequestPayloadHandler
      }
      if (name === 'message_end') handlers.messageEnd = handler as MessageEndHandler
      return () => undefined
    }
  } as unknown as ExtensionAPI

  commandcode(pi)

  const { beforeProviderRequest, messageEnd } = handlers
  if (!beforeProviderRequest) throw new Error('before_provider_request not registered')
  if (!messageEnd) throw new Error('message_end not registered')
  return { beforeProviderRequest, messageEnd }
}

/** An id outside the shipped catalog, so the handler trusts the model's own numbers. */
function testModel(contextWindow: number, maxTokens: number): ExtensionContext['model'] {
  return {
    id: 'test/model',
    provider: 'commandcode',
    contextWindow,
    maxTokens
  } as unknown as ExtensionContext['model']
}

function runPayload(payload: unknown, model: ExtensionContext['model']): Record<string, unknown> {
  const { beforeProviderRequest } = captureHandlers()
  const event: BeforeProviderRequestEvent = { type: 'before_provider_request', payload }
  return beforeProviderRequest(event, { model } as ExtensionContext) as Record<string, unknown>
}

function assistantError(options: {
  errorMessage: string
  provider?: string
  stopReason?: 'error' | 'stop'
}): MessageEndEvent['message'] {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: options.provider ?? 'commandcode',
    model: 'deepseek/deepseek-v4.1-flash',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: options.stopReason ?? 'error',
    errorMessage: options.errorMessage,
    timestamp: 0
  } as MessageEndEvent['message']
}

function runMessageEnd(message: MessageEndEvent['message']) {
  const { messageEnd } = captureHandlers()
  const event: MessageEndEvent = { type: 'message_end', message }
  return messageEnd(event, {} as ExtensionContext) as
    | { message?: MessageEndEvent['message'] }
    | undefined
}

/** A prompt of `chars` characters: `ceil(chars / 3)` tokens plus the key overhead. */
function promptPayload(
  field: 'max_tokens' | 'max_completion_tokens',
  chars: number,
  maxTokens: number
) {
  return {
    [field]: maxTokens,
    model: 'test/model',
    messages: [{ role: 'user', content: 'a'.repeat(chars) }]
  }
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

interface ProbeCall {
  url: string
  model: string
  headers: Record<string, string>
}

/**
 * Stub `/models` plus the entitlement probes that follow it. Every model answers
 * 200 unless `respond` claims it, so a test states only the outcomes it cares
 * about.
 */
function stubProbedCatalog(
  ids: string[],
  respond: (model: string) => Response | 'throw' | undefined = () => undefined
): { calls: ProbeCall[] } {
  const calls: ProbeCall[] = []
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/models')) {
        return jsonResponse({
          data: ids.map((id) => ({ id, name: id, context_length: 1_000_000 }))
        })
      }

      const headers = new Headers(init?.headers)
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string }
      const model = body.model ?? ''
      calls.push({ url, model, headers: Object.fromEntries(headers.entries()) })

      const response = respond(model)
      if (response === 'throw') throw new Error('probe failed')
      return (
        response ?? jsonResponse({ choices: [{ message: { role: 'assistant', content: '' } }] })
      )
    },
    { preconnect: originalFetch.preconnect }
  ) as typeof fetch
  return { calls }
}

/** The gate's answer for a model the account's plan excludes. */
function planDenial(url: string, message: string): Response {
  return url.endsWith('/messages')
    ? jsonResponse({ type: 'error', error: { type: 'permission_error', message } }, 403)
    : jsonResponse({ error: { message, type: 'permission_error', code: 'FORBIDDEN' } }, 403)
}

function modelNotInPlan(model: string): string {
  return `MODEL_NOT_IN_PLAN: ${model} available in Pro and above plans or extra on demand usage`
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
      maxTokens: 393_216,
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
      maxTokens: 393_216,
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

  test('advertises the whole upstream budget as the context window', () => {
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
    const big = buildCommandCodeModel({ id: 'm', name: 'M', context_length: 1_000_000 })
    expect(big.maxTokens).toBe(8_192)

    const small = buildCommandCodeModel({ id: 'm', name: 'M', context_length: 4_000 })
    expect(small.maxTokens).toBe(4_000 - 1_024)
    expect(small.contextWindow).toBe(4_000)
  })

  test('prefers the override maxTokens over the default cap', () => {
    const result = buildCommandCodeModel({
      id: 'deepseek/deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      context_length: 1_000_000
    })

    expect(result.maxTokens).toBe(393_216)
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

  test('routes every Claude model the provider knows through the Anthropic Messages API', () => {
    const unrouted = knownCommandCodeModels()
      .map((entry) => entry.id)
      .filter((id) => id.startsWith('claude-'))
      .filter((id) => seedBuiltModel(id)?.api !== 'anthropic-messages')

    expect(unrouted).toEqual([])
  })

  test('routes a Claude model the baked catalog predates', () => {
    const result = buildCommandCodeModel({
      id: 'claude-haiku-5-5',
      name: 'Claude Haiku 5.5',
      context_length: 1_000_000
    })

    expect(result).toMatchObject({
      api: 'anthropic-messages',
      baseUrl: 'https://api.commandcode.ai/provider',
      maxTokens: 128_000,
      contextWindow: 1_000_000
    })
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

  test('seeds the upstream context budget instead of the 128K default', () => {
    expect(seedBuiltModel('deepseek/deepseek-v4.1-flash')?.contextWindow).toBe(1_000_000)
    expect(seedBuiltModel('claude-haiku-4-5-20251001')?.contextWindow).toBe(200_000)
    expect(seedBuiltModel('gpt-5.5')?.contextWindow).toBe(400_000)
  })
})

describe('context budget', () => {
  test('advertises every model`s whole upstream budget', () => {
    const overcounting = knownCommandCodeModels().flatMap((entry) => {
      const model = buildCommandCodeModel(entry)
      return model.contextWindow === (entry.context_length ?? 128_000) ? [] : [model.id]
    })

    expect(overcounting).toEqual([])
  })

  test('never claims a completion the budget cannot pay for', () => {
    const overcommitted = knownCommandCodeModels().flatMap((entry) => {
      const model = buildCommandCodeModel(entry)
      return model.maxTokens > model.contextWindow - 1_024 ? [model.id] : []
    })

    expect(overcommitted).toEqual([])
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
      maxTokens: 393_216
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

describe('plan entitlement', () => {
  const OPENAI_PROBE = 'https://api.commandcode.ai/provider/v1/chat/completions'
  const MESSAGES_PROBE = 'https://api.commandcode.ai/provider/v1/messages'

  test('drops the models the account plan excludes and persists the rest', async () => {
    const { calls } = stubProbedCatalog(['deepseek/deepseek-v4.1-flash', 'gpt-5.4'], (model) =>
      model === 'gpt-5.4' ? planDenial(OPENAI_PROBE, modelNotInPlan(model)) : undefined
    )
    const { refreshModels } = captureProviderConfig()
    const { context, persisted } = makeContext({ credential: apiKeyCredential() })

    const models = await refreshModels(context)

    expect(models.map((model) => model.id)).toEqual(['deepseek/deepseek-v4.1-flash'])
    // Persisting the filtered list is what stops every session from re-probing.
    expect(persisted[0].models.map((model) => model.id)).toEqual(['deepseek/deepseek-v4.1-flash'])
    expect(calls.map((call) => call.url)).toEqual([OPENAI_PROBE, OPENAI_PROBE])
  })

  test('probes Claude through the Anthropic Messages shape with its own header', async () => {
    const { calls } = stubProbedCatalog(
      ['claude-sonnet-5', 'deepseek/deepseek-v4.1-flash'],
      (model) =>
        model === 'claude-sonnet-5' ? planDenial(MESSAGES_PROBE, modelNotInPlan(model)) : undefined
    )
    const { refreshModels } = captureProviderConfig()
    const { context } = makeContext({ credential: apiKeyCredential() })

    const models = await refreshModels(context)

    expect(models.map((model) => model.id)).toEqual(['deepseek/deepseek-v4.1-flash'])
    const claude = calls.find((call) => call.model === 'claude-sonnet-5')
    expect(claude).toMatchObject({ url: MESSAGES_PROBE, headers: { 'x-api-key': 'test-key' } })
    const deepseek = calls.find((call) => call.model === 'deepseek/deepseek-v4.1-flash')
    expect(deepseek).toMatchObject({
      url: OPENAI_PROBE,
      headers: { authorization: 'Bearer test-key' }
    })
  })

  test('honours the mis-worded gate a model with no upstream plan entry returns', async () => {
    const { calls } = stubProbedCatalog(
      ['claude-sonnet-5-5', 'deepseek/deepseek-v4.1-flash'],
      (model) =>
        model === 'claude-sonnet-5-5'
          ? planDenial(MESSAGES_PROBE, 'Authentication failed. Please check your credentials.')
          : undefined
    )
    const { refreshModels } = captureProviderConfig()
    const { context } = makeContext({ credential: apiKeyCredential() })

    const models = await refreshModels(context)

    expect(models.map((model) => model.id)).toEqual(['deepseek/deepseek-v4.1-flash'])
    expect(calls).toHaveLength(2)
  })

  test('keeps a model whose probe is inconclusive', async () => {
    const inconclusive: Record<string, Response | 'throw'> = {
      'gated/model': planDenial(OPENAI_PROBE, modelNotInPlan('gated/model')),
      'rate-limited/model': jsonResponse({ error: { message: 'slow down' } }, 429),
      'upstream/model': jsonResponse({ error: { message: 'invalid request error' } }, 400),
      'broken/model': jsonResponse({ error: { message: 'upstream exploded' } }, 500),
      'throwing/model': 'throw'
    }
    stubProbedCatalog(Object.keys(inconclusive), (model) => inconclusive[model])
    const { refreshModels } = captureProviderConfig()
    const { context } = makeContext({ credential: apiKeyCredential() })

    const models = await refreshModels(context)

    expect(models.map((model) => model.id)).toEqual([
      'rate-limited/model',
      'upstream/model',
      'broken/model',
      'throwing/model'
    ])
  })

  test('keeps the seed catalog when the plan excludes every upstream model', async () => {
    stubProbedCatalog(['gpt-5.4', 'claude-sonnet-5'], (model) =>
      planDenial(model.startsWith('claude-') ? MESSAGES_PROBE : OPENAI_PROBE, modelNotInPlan(model))
    )
    const { refreshModels } = captureProviderConfig()
    const { context, persisted } = makeContext({ credential: apiKeyCredential() })

    const models = await refreshModels(context)

    expect(models.map((model) => model.id)).toEqual(seedModels().map((model) => model.id))
    expect(persisted).toEqual([])
  })

  test('keeps the fallback when the catalog is refreshed without a credential', async () => {
    const { calls } = stubProbedCatalog(['deepseek/deepseek-v4.1-flash'])
    const { refreshModels } = captureProviderConfig()
    const { context } = makeContext()

    const models = await refreshModels(context)

    expect(models.map((model) => model.id)).toEqual(seedModels().map((model) => model.id))
    expect(calls).toEqual([])
  })
})

describe('completion budget', () => {
  /**
   * Budget 10_000, completion allowance 8_192. The 21_000-char prompt costs
   * ceil(21_000 / 3) = 7_000 tokens plus 16 tokens of keys and short values, so
   * the room left is 10_000 - 7_016 - 1_024 = 1_960.
   */
  test('cuts the completion down to the room the prompt leaves', () => {
    const payload = promptPayload('max_tokens', 21_000, 8_192)

    const result = runPayload(payload, testModel(10_000, 8_192))

    expect(result.max_tokens).toBe(1_960)
    expect(payload.max_tokens).toBe(8_192)
  })

  test('keeps a floor when the prompt has eaten the whole budget', () => {
    const result = runPayload(promptPayload('max_tokens', 33_000, 8_192), testModel(10_000, 8_192))

    expect(result.max_tokens).toBe(1_024)
  })

  test('leaves a short prompt alone', () => {
    const payload = promptPayload('max_tokens', 2, 8_192)

    expect(runPayload(payload, testModel(1_000_000, 393_216))).toBe(payload)
  })

  test('never asks for more than the model advertises', () => {
    const result = runPayload(promptPayload('max_tokens', 2, 500_000), testModel(1_000_000, 8_192))

    expect(result.max_tokens).toBe(8_192)
  })

  test('clamps max_completion_tokens the same way', () => {
    const result = runPayload(
      promptPayload('max_completion_tokens', 21_000, 8_192),
      testModel(10_000, 8_192)
    )

    expect(result.max_completion_tokens).toBe(1_960)
    expect(result.max_tokens).toBeUndefined()
  })

  test('prices an inlined image instead of counting its bytes', () => {
    const payload = {
      max_tokens: 8_192,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${'A'.repeat(3_000_000)}` }
            }
          ]
        }
      ]
    }

    expect(runPayload(payload, testModel(1_000_000, 8_192))).toBe(payload)
  })

  test('reads the shipped budget for a catalog model', () => {
    const seeded = seedBuiltModel('deepseek/deepseek-v4.1-flash')!
    const model = {
      ...testModel(seeded.contextWindow, seeded.maxTokens),
      id: seeded.id
    } as ExtensionContext['model']

    const tight = runPayload(promptPayload('max_tokens', 3_000_000, seeded.maxTokens), model)
    const roomy = runPayload(promptPayload('max_tokens', 2, seeded.maxTokens), model)

    expect(tight.max_tokens).toBe(1_024)
    expect(roomy.max_tokens).toBe(seeded.maxTokens)
  })

  test('ignores a request without a completion field', () => {
    const payload = { model: 'test/model', messages: [] }

    expect(clampCompletionBudget(payload, { budget: 10_000, maxOutput: 8_192 })).toBe(payload)
  })
})

describe('budget rejection', () => {
  const rewriteRelay =
    '400: {"message":"{\\"message\\":\\"the configured rewrite value still does not satisfy the rule trace_id: 2de317daecc9b6a8e79a8e5ad4f96cc1\\",\\"type\\":\\"invalid_request_error\\"}","type":"invalid_request_error"}'

  test('restates the rejection as the overflow pi recovers from', () => {
    const result = runMessageEnd(assistantError({ errorMessage: rewriteRelay }))
    const errorMessage = (result?.message as { errorMessage?: string } | undefined)?.errorMessage

    expect(errorMessage).toContain('prompt is too long')
    expect(errorMessage).toContain('the configured rewrite value still does not satisfy the rule')
    expect(errorMessage).toContain('2de317daecc9b6a8e79a8e5ad4f96cc1')
  })

  test('restates the explicit input-length wording', () => {
    expect(asBudgetOverflow("The input is longer than the model's context length")).toBeDefined()
  })

  test('leaves the generic relay alone so a malformed request stays visible', () => {
    expect(asBudgetOverflow('400: {"error":{"message":"invalid request error"}}')).toBeUndefined()
    expect(runMessageEnd(assistantError({ errorMessage: 'invalid request error' }))).toBeUndefined()
  })

  test('leaves other providers and finished messages alone', () => {
    expect(
      runMessageEnd(assistantError({ errorMessage: rewriteRelay, provider: 'anthropic' }))
    ).toBeUndefined()
    expect(
      runMessageEnd(assistantError({ errorMessage: rewriteRelay, stopReason: 'stop' }))
    ).toBeUndefined()
  })
})
