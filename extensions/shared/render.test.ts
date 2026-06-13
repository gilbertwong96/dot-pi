import { describe, expect, test } from 'bun:test'
import type { Theme } from '@earendil-works/pi-coding-agent'
import { visibleWidth } from '@earendil-works/pi-tui'

import {
  clampRenderedLines,
  firstText,
  renderEmpty,
  renderEntryList,
  renderErrorOrPartial,
  renderLines,
  renderMarkdownPreview,
  renderToolCall,
  toolError,
  toolLoading
} from './render'

const theme = {
  fg: (_name: string, text: string) => String(text),
  bg: (_name: string, text: string) => String(text),
  bold: (text: string) => String(text),
  underline: (text: string) => String(text)
} as Theme

describe('renderEmpty', () => {
  test('renders no lines for partial tool output', () => {
    expect(renderEmpty().render(80)).toEqual([])
  })
})

describe('renderLines', () => {
  test('truncates long lines to viewport width', () => {
    const [, line] = renderLines(['abcdefghijklmnopqrstuvwxyz']).render(10)

    expect(visibleWidth(line)).toBeLessThanOrEqual(10)
    expect(line).toContain('…')
  })
})

describe('renderErrorOrPartial', () => {
  test('renders errors and partial empty states', () => {
    expect(
      renderErrorOrPartial(
        { content: [{ type: 'text', text: 'Error: Boom' }], details: { error: true } },
        { error: true },
        {},
        theme
      )?.render(120)
    ).toEqual(['', 'Error: Boom'])

    expect(
      renderErrorOrPartial({ content: [], details: {} }, {}, { isPartial: true }, theme)?.render(
        120
      )
    ).toEqual([])
  })
})

describe('toolError', () => {
  test('prefixes error messages once', () => {
    expect(firstText(toolError('Boom', { error: true }))).toBe('Error: Boom')
    expect(firstText(toolError('Error: Boom', { error: true }))).toBe('Error: Boom')
  })

  test('marks result as error', () => {
    expect(toolError('Boom', {}).isError).toBe(true)
  })
})

describe('toolLoading', () => {
  test('returns empty content with typed details', () => {
    expect(toolLoading({ loading: true })).toEqual({ content: [], details: { loading: true } })
  })
})

describe('renderToolCall', () => {
  test('skips empty segments and falsey tags', () => {
    const [line] = renderToolCall(theme, 'fetch', {
      segments: [{ text: undefined }, { text: '' }, { text: 'https://example.com' }],
      tags: [undefined, '', false, 'json'],
      suffix: undefined
    }).render(120)

    expect(line).toBe('fetch https://example.com [json]')
    expect(line).not.toContain('undefined')
    expect(line).not.toContain('false')
  })

  test('truncates long call lines', () => {
    const [line] = renderToolCall(theme, 'fetch', {
      segments: [{ text: 'abcdefghijklmnopqrstuvwxyz' }]
    }).render(12)

    expect(visibleWidth(line)).toBeLessThanOrEqual(12)
    expect(line).toContain('…')
  })
})

describe('renderMarkdownPreview', () => {
  test('renders compact markdown preview with metadata', () => {
    const lines = renderMarkdownPreview('one\ntwo\nthree', theme, {
      expanded: false,
      compactLines: 2,
      metadata: ['meta']
    }).render(120)

    expect(lines).toContain('meta')
    expect(lines).toContain('one')
    expect(lines).toContain('two')
    expect(lines).toContain('… 1 more lines')
  })
})

describe('renderEntryList', () => {
  test('renders compact entries with hidden footer', () => {
    const lines = renderEntryList(['one', 'two'], theme, {
      expanded: false,
      compactLimit: 1,
      renderEntry: (entry) => ({ header: entry }),
      hiddenLines: (hidden) => (hidden > 0 ? [`… ${hidden} more`] : [])
    }).render(120)

    expect(lines).toContain('one')
    expect(lines).toContain('… 1 more')
    expect(lines.join('\n')).toContain('ctrl+o')
    expect(lines).not.toContain('two')
  })
})

describe('clampRenderedLines', () => {
  test('truncates lines returned by wrapped components', () => {
    const component = clampRenderedLines({
      render: () => ['0123456789abcdef'],
      invalidate: () => undefined
    })

    const [line] = component.render(8)

    expect(visibleWidth(line)).toBeLessThanOrEqual(8)
    expect(line).toContain('…')
  })
})
