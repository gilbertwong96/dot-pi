import { afterEach, describe, expect, test } from 'bun:test'

import { env, fetchJson, fetchText } from './http'

const originalFetch = globalThis.fetch
const originalEnv = process.env.DOT_PI_HTTP_TEST_KEY

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalEnv === undefined) delete process.env.DOT_PI_HTTP_TEST_KEY
  else process.env.DOT_PI_HTTP_TEST_KEY = originalEnv
})

function mockFetch(response: Response) {
  globalThis.fetch = Object.assign(async () => response, {
    preconnect: originalFetch.preconnect
  })
}

describe('env', () => {
  test('returns non-empty environment values only', () => {
    process.env.DOT_PI_HTTP_TEST_KEY = 'value'
    expect(env('DOT_PI_HTTP_TEST_KEY')).toBe('value')

    process.env.DOT_PI_HTTP_TEST_KEY = ''
    expect(env('DOT_PI_HTTP_TEST_KEY')).toBeUndefined()
  })
})

describe('fetchText', () => {
  test('returns status and text body', async () => {
    mockFetch(new Response('hello', { status: 201 }))

    const result = await fetchText('https://example.com')

    expect(result.ok).toBe(true)
    expect(result.status).toBe(201)
    expect(result.text).toBe('hello')
  })
})

describe('fetchJson', () => {
  test('parses json only for ok responses', async () => {
    mockFetch(new Response('{"ok":true}', { status: 200 }))
    expect((await fetchJson<{ ok: boolean }>('https://example.com')).data).toEqual({ ok: true })

    mockFetch(new Response('not json', { status: 500 }))
    const error = await fetchJson<{ ok: boolean }>('https://example.com')
    expect(error.ok).toBe(false)
    expect(error.data).toBeUndefined()
  })
})
