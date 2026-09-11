import { afterEach, describe, expect, test } from 'vitest'

import { fetchOpenAIModels, type NormalizedOpenAIModel } from './openai-models'

const originalFetch = globalThis.fetch

function mockFetch(response: Response | (() => Response | Promise<Response>)) {
  const impl =
    typeof response === 'function'
      ? (response as () => Response | Promise<Response>)
      : () => response
  globalThis.fetch = Object.assign(async () => impl(), {
    preconnect: originalFetch.preconnect
  }) as typeof fetch
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('fetchOpenAIModels', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('fetches <baseUrl>/models with Bearer auth and returns normalized entries', async () => {
    mockFetch(() => {
      return jsonResponse({
        object: 'list',
        data: [
          {
            id: 'deepseek/deepseek-v4-flash',
            object: 'model',
            created: 1789117012,
            owned_by: 'command-code',
            name: 'DeepSeek V4 Flash',
            context_length: 1000000
          },
          {
            id: 'zai-org/GLM-5',
            object: 'model',
            created: 1789117000,
            owned_by: 'command-code',
            name: 'GLM-5',
            context_length: 200000
          }
        ]
      })
    })

    const result = await fetchOpenAIModels('https://api.example.com/v1', 'test-key')

    expect(result).toEqual<NormalizedOpenAIModel[]>([
      { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', context_length: 1000000 },
      { id: 'zai-org/GLM-5', name: 'GLM-5', context_length: 200000 }
    ])
  })

  test('normalizes a baseUrl with a trailing slash', async () => {
    let capturedUrl = ''
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === 'string' ? input : input.toString()
        return jsonResponse({ data: [] })
      },
      { preconnect: originalFetch.preconnect }
    ) as typeof fetch

    await fetchOpenAIModels('https://api.example.com/v1/', 'k')

    expect(capturedUrl).toBe('https://api.example.com/v1/models')
  })

  test('sends Authorization header with the provided key', async () => {
    let captured: Request | undefined
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        captured = new Request(input, init)
        return jsonResponse({ data: [] })
      },
      { preconnect: originalFetch.preconnect }
    ) as typeof fetch

    await fetchOpenAIModels('https://api.example.com/v1', 'secret-token')

    expect(captured?.url).toBe('https://api.example.com/v1/models')
    expect(captured?.headers.get('Authorization')).toBe('Bearer secret-token')
  })

  test('falls back to id when name is missing or empty', async () => {
    mockFetch(() =>
      jsonResponse({
        data: [{ id: 'model-a', name: '' }, { id: 'model-b' }]
      })
    )

    const result = await fetchOpenAIModels('https://api.example.com/v1', 'k')

    expect(result.map((m) => m.name)).toEqual(['model-a', 'model-b'])
  })

  test('drops entries without a string id', async () => {
    mockFetch(() =>
      jsonResponse({
        data: [
          { id: 'keep', name: 'Keep' },
          { id: '', name: 'No id' },
          { id: 42, name: 'Numeric id' },
          { name: 'Missing id' }
        ]
      })
    )

    const result = await fetchOpenAIModels('https://api.example.com/v1', 'k')

    expect(result.map((m) => m.id)).toEqual(['keep'])
  })

  test('omits context_length when upstream does not provide it', async () => {
    mockFetch(() => jsonResponse({ data: [{ id: 'no-ctx', name: 'No Ctx' }] }))

    const result = await fetchOpenAIModels('https://api.example.com/v1', 'k')

    expect(result).toEqual([{ id: 'no-ctx', name: 'No Ctx' }])
    expect(Object.prototype.hasOwnProperty.call(result[0]!, 'context_length')).toBe(false)
  })

  test('returns an empty list when data is missing or not an array', async () => {
    mockFetch(() => jsonResponse({}))

    const empty = await fetchOpenAIModels('https://api.example.com/v1', 'k')
    expect(empty).toEqual([])

    mockFetch(() => jsonResponse({ data: 'not-an-array' }))
    const bad = await fetchOpenAIModels('https://api.example.com/v1', 'k')
    expect(bad).toEqual([])
  })

  test('throws when the upstream returns a non-ok status', async () => {
    mockFetch(() => jsonResponse({ error: 'unauthorized' }, 401))

    await expect(fetchOpenAIModels('https://api.example.com/v1', 'k')).rejects.toThrow(/401/)
  })

  test('throws when the upstream returns invalid JSON', async () => {
    mockFetch(() => new Response('not-json', { status: 200 }))

    await expect(fetchOpenAIModels('https://api.example.com/v1', 'k')).rejects.toThrow()
  })

  test('honors an external abort signal', async () => {
    const controller = new AbortController()
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (signal?.aborted) {
            reject(new DOMException('aborted', 'AbortError'))
            return
          }
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      },
      { preconnect: originalFetch.preconnect }
    ) as typeof fetch

    const promise = fetchOpenAIModels('https://api.example.com/v1', 'k', {
      signal: controller.signal
    })
    controller.abort()

    await expect(promise).rejects.toThrow()
  })

  test('aborts when the timeout elapses', async () => {
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      },
      { preconnect: originalFetch.preconnect }
    ) as typeof fetch

    await expect(
      fetchOpenAIModels('https://api.example.com/v1', 'k', { timeoutMs: 25 })
    ).rejects.toThrow()
  })
})
