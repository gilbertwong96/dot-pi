import { afterEach, describe, expect, test } from 'bun:test'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import { firstText } from '../shared/render'
import webfetchExtension from './index'

const originalFetch = globalThis.fetch
const context = {} as ExtensionContext

afterEach(() => {
  globalThis.fetch = originalFetch
})

type RegisteredTool = Parameters<ExtensionAPI['registerTool']>[0]

function registeredFetchTool(): RegisteredTool {
  let tool: RegisteredTool | undefined
  const pi = {
    registerTool: (registered: RegisteredTool) => {
      tool = registered
    }
  } as ExtensionAPI

  webfetchExtension(pi)
  if (!tool) throw new Error('fetch tool was not registered')
  return tool
}

function mockFetch(response: Response) {
  globalThis.fetch = Object.assign(async () => response, {
    preconnect: originalFetch.preconnect
  })
}

describe('webfetch truncation', () => {
  test('uses shared native-style output truncation', async () => {
    const body = Array.from({ length: 2100 }, (_, index) => `line ${index + 1}`).join('\n')
    mockFetch(
      new Response(body, {
        headers: { 'content-type': 'text/plain' }
      })
    )

    const result = await registeredFetchTool().execute(
      'test',
      { url: 'https://example.com/large.txt', format: 'text' },
      undefined,
      undefined,
      context
    )

    expect(firstText(result)).toContain('[Output truncated: showing 2000 of 2100 lines')
    expect((result.details as { truncation?: { truncated: boolean } }).truncation?.truncated).toBe(
      true
    )
  })
})

describe('webfetch binary handling', () => {
  test('does not decode audio responses as text', async () => {
    mockFetch(
      new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0xff]), {
        headers: { 'content-type': 'audio/mpeg' }
      })
    )

    const result = await registeredFetchTool().execute(
      'test',
      { url: 'https://example.com/preview.mp3', format: 'text' },
      undefined,
      undefined,
      context
    )

    expect(firstText(result)).toBe('Binary content not displayed: audio/mpeg · 6 B')
    expect((result.details as { format?: string }).format).toBe('binary')
  })

  test('sniffs binary content when content type is generic', async () => {
    mockFetch(
      new Response(new Uint8Array([0x00, 0x01, 0x02, 0x03]), {
        headers: { 'content-type': 'application/octet-stream' }
      })
    )

    const result = await registeredFetchTool().execute(
      'test',
      { url: 'https://example.com/blob', format: 'text' },
      undefined,
      undefined,
      context
    )

    expect(firstText(result)).toBe('Binary content not displayed: application/octet-stream · 4 B')
    expect((result.details as { format?: string }).format).toBe('binary')
  })
})
