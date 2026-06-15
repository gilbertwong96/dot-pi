import { describe, expect, test } from 'vitest'

import {
  compactLines,
  compactText,
  formatBytes,
  formatDuration,
  normalizeTerminalOutput,
  stripAnsi,
  stripCarriageReturnProgress
} from './format'

describe('formatBytes', () => {
  test('formats byte counts for human metadata', () => {
    expect(formatBytes(6)).toBe('6 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB')
  })
})

describe('formatDuration', () => {
  test('formats mm:ss durations', () => {
    expect(formatDuration(65_400)).toBe('01:05')
  })
})

describe('compactText', () => {
  test('normalizes whitespace and truncates with ellipsis', () => {
    expect(compactText('hello\n  world', 20)).toBe('hello world')
    expect(compactText('hello world', 6)).toBe('hello…')
  })
})

describe('terminal output helpers', () => {
  test('strips ansi escape sequences', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red')
  })

  test('keeps the final carriage-return progress frame', () => {
    expect(stripCarriageReturnProgress('10%\r20%\ndone')).toBe('20%\ndone')
  })

  test('normalizes terminal output', () => {
    expect(normalizeTerminalOutput('\u001b[32m10%\r20%\u001b[0m')).toBe('20%')
  })

  test('compacts non-empty terminal lines', () => {
    expect(compactLines('one\n\n two\t three ', 20)).toEqual(['one', 'two three'])
  })
})
