import { describe, expect, test } from 'vitest'

import { parseSseJson } from './sse'

describe('parseSseJson', () => {
  test('parses plain JSON responses', () => {
    expect(parseSseJson<{ ok: boolean }>(JSON.stringify({ ok: true }))).toEqual({ ok: true })
  })

  test('skips SSE metadata and parses data events', () => {
    const body = [
      ': keepalive',
      'event: message',
      'id: 1',
      'data: {"result":{"content":[]}}',
      '',
      'data: [DONE]',
      ''
    ].join('\n')

    expect(parseSseJson<Record<string, unknown>>(body)).toEqual({ result: { content: [] } })
  })

  test('joins multi-line SSE data payloads', () => {
    const body = ['data: {', 'data: "result": {"content": []}', 'data: }', ''].join('\n')

    expect(parseSseJson<Record<string, unknown>>(body)).toEqual({ result: { content: [] } })
  })

  test('continues past malformed events', () => {
    const body = ['data: not json', '', 'data: {"error":{"code":-1,"message":"bad"}}', ''].join(
      '\n'
    )

    expect(parseSseJson<Record<string, unknown>>(body)).toEqual({
      error: { code: -1, message: 'bad' }
    })
  })
})
