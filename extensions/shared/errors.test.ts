import { describe, expect, test } from 'bun:test'

import { errorMessage } from './errors'

describe('errorMessage', () => {
  test('formats Error instances and unknown values', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('bad')).toBe('bad')
  })

  test('includes nested error causes', () => {
    expect(
      errorMessage(new Error('fetch failed', { cause: new Error('connection timed out') }))
    ).toBe('fetch failed: connection timed out')
  })

  test('includes structured cause codes', () => {
    expect(errorMessage(new Error('fetch failed', { cause: { code: 'ENOTFOUND' } }))).toBe(
      'fetch failed: ENOTFOUND'
    )
  })
})
