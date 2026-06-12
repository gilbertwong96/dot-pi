import { describe, expect, test } from 'bun:test'

import {
  parseGitHubBlobUrl,
  parseResults,
  parseSseJson,
  resolveCodeFetchTarget,
  sliceLines
} from './codesearch'

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

describe('parseGitHubBlobUrl', () => {
  test('parses GitHub blob URLs from codesearch output', () => {
    expect(
      parseGitHubBlobUrl('https://github.com/facebook/react/blob/main/packages/react/index.js')
    ).toEqual({
      repo: 'facebook/react',
      ref: 'main',
      path: 'packages/react/index.js'
    })
  })

  test('rejects non-blob URLs', () => {
    expect(parseGitHubBlobUrl('https://github.com/facebook/react')).toBeUndefined()
  })
})

describe('resolveCodeFetchTarget', () => {
  test('prefers GitHub URL target over explicit fields', () => {
    expect(
      resolveCodeFetchTarget({
        repo: 'wrong/repo',
        path: 'wrong.ts',
        url: 'https://github.com/facebook/react/blob/main/packages/react/index.js'
      })
    ).toEqual({
      ok: true,
      repo: 'facebook/react',
      ref: 'main',
      path: 'packages/react/index.js'
    })
  })

  test('requires a URL or repo and path', () => {
    expect(resolveCodeFetchTarget({ repo: 'facebook/react' })).toEqual({
      ok: false,
      message: 'Provide either url or both repo and path'
    })
  })
})

describe('sliceLines', () => {
  test('returns a normalized 1-based line range', () => {
    expect(sliceLines('one\ntwo\nthree', 2, 3)).toEqual({
      text: 'two\nthree',
      startLine: 2,
      endLine: 3,
      totalLines: 3
    })
  })

  test('returns an empty range when start is past EOF', () => {
    expect(sliceLines('one\ntwo', 9)).toEqual({
      text: '',
      startLine: 9,
      endLine: 8,
      totalLines: 2
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
