import { describe, expect, test } from 'bun:test'
import type { Theme } from '@earendil-works/pi-coding-agent'

import { registeredTool, type RegisteredTool } from './shared/test-utils'
import codesearch, { parseResults, parseSseJson, sliceLines } from './codesearch'

const theme = {
  fg: (_name: string, text: string) => String(text),
  bg: (_name: string, text: string) => String(text),
  bold: (text: string) => String(text),
  underline: (text: string) => String(text)
} as Theme

function codefetchTool(): RegisteredTool {
  return registeredTool(codesearch, 'codefetch')
}

function renderCodefetch(details: Record<string, unknown>, text: string, expanded = false): string {
  const tool = codefetchTool()
  const component = tool.renderResult?.(
    { content: [{ type: 'text', text }], details },
    { expanded, isPartial: false },
    theme,
    {} as never
  )
  return component?.render(120).join('\n') ?? ''
}

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

describe('codefetch renderer', () => {
  test('shows an expand footer only when compact output hides lines', () => {
    const text = Array.from({ length: 45 }, (_, index) => `line ${index + 1}`).join('\n')
    const rendered = renderCodefetch(
      {
        repo: 'owner/repo',
        path: 'src/index.ts',
        startLine: 1,
        endLine: 45,
        lineCount: 45,
        totalLines: 45
      },
      text
    )

    expect(rendered).toContain('… 5 more lines')
    expect(rendered).toContain('(ctrl+o to expand)')
  })

  test('omits expand footer for compact line ranges that fit', () => {
    const rendered = renderCodefetch(
      {
        repo: 'owner/repo',
        path: 'src/index.ts',
        startLine: 10,
        endLine: 12,
        lineCount: 3,
        totalLines: 100
      },
      'alpha\nbeta\ngamma'
    )

    expect(rendered).toContain('lines:10-12')
    expect(rendered).not.toContain('(ctrl+o to expand)')
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
