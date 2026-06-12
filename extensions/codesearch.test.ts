import { describe, expect, test } from 'bun:test'

import { parseResults, parseSseJson } from './codesearch'

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

describe('parseResults', () => {
  test('parses grep.app text records into snippets', () => {
    const raw = [
      'Repository: owner/repo',
      'Path: src/index.ts',
      'URL: https://github.com/owner/repo/blob/main/src/index.ts',
      'License: MIT',
      '--- Snippet 1 (Line 7) ---',
      'export function example() {',
      '  return true',
      '}',
      '',
      'Repository: owner/other',
      'Path: lib/main.ts',
      '--- Snippet 1 (Line 3) ---',
      'const value = 1'
    ].join('\n')

    expect(parseResults(raw)).toEqual([
      {
        repo: 'owner/repo',
        path: 'src/index.ts',
        url: 'https://github.com/owner/repo/blob/main/src/index.ts',
        license: 'MIT',
        snippets: [{ lineNumber: 7, code: 'export function example() {\n  return true\n}' }]
      },
      {
        repo: 'owner/other',
        path: 'lib/main.ts',
        url: '',
        license: 'Unknown',
        snippets: [{ lineNumber: 3, code: 'const value = 1' }]
      }
    ])
  })
})
