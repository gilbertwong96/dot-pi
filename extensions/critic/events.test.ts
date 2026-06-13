import { describe, expect, test } from 'vitest'

import {
  errorMessageFromEvent,
  isThinkingContent,
  textContentFromUnknown,
  usageFromUnknown
} from './events'

describe('critic event helpers', () => {
  test('detects thinking content without broad casts', () => {
    expect(isThinkingContent({ type: 'thinking', thinking: 'hmm' })).toBe(true)
    expect(isThinkingContent({ type: 'text', text: 'hello' })).toBe(false)
  })

  test('extracts text content from unknown arrays', () => {
    expect(textContentFromUnknown([{ type: 'text', text: 'hello' }])?.text).toBe('hello')
    expect(textContentFromUnknown('hello')).toBeUndefined()
  })

  test('normalizes usage objects', () => {
    expect(usageFromUnknown({ input: 10, output: 20, cost: { total: 0.03 } })).toEqual({
      input: 10,
      output: 20,
      cost: 0.03
    })
    expect(usageFromUnknown(undefined)).toBeUndefined()
  })

  test('formats unknown error event messages', () => {
    expect(errorMessageFromEvent({ type: 'error', message: 'bad' })).toBe('bad')
    expect(errorMessageFromEvent({ type: 'error' })).toBe('unknown error')
  })
})
