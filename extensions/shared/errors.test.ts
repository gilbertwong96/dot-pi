import { describe, expect, test } from 'bun:test'

import { errorMessage } from './errors'

describe('errorMessage', () => {
  test('formats Error instances and unknown values', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('bad')).toBe('bad')
  })
})
