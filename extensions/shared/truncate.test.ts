import { describe, expect, test } from 'vitest'

import { truncateHeadText } from './truncate'

describe('truncateHeadText', () => {
  test('returns unchanged text when under limits', () => {
    expect(truncateHeadText('one\ntwo', { maxLines: 5, maxBytes: 1000 })).toEqual({
      text: 'one\ntwo'
    })
  })

  test('appends a default notice when truncated', () => {
    const result = truncateHeadText('one\ntwo\nthree', { maxLines: 2, maxBytes: 1000 })

    expect(result.text).toBe('one\ntwo\n\n[Output truncated: showing 2 of 3 lines (2 line limit)]')
    expect(result.truncation?.truncated).toBe(true)
  })

  test('supports custom notices', () => {
    const result = truncateHeadText('one\ntwo\nthree', {
      maxLines: 2,
      maxBytes: 1000,
      notice: (truncation) => `[continue after ${truncation.outputLines}]`
    })

    expect(result.text).toBe('one\ntwo\n\n[continue after 2]')
    expect(result.notice).toBe('[continue after 2]')
  })
})
