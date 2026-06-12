import { describe, expect, test } from 'bun:test'

import { compactText, formatBytes, formatDuration } from './format'

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
