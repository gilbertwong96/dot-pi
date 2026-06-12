import { describe, expect, test } from 'bun:test'

import { parseCriticVerdict } from './verdict'

describe('parseCriticVerdict', () => {
  test('extracts approved verdict and strips block', () => {
    expect(
      parseCriticVerdict('Looks good\n<critic_verdict>status: APPROVED</critic_verdict>')
    ).toEqual({
      critique: 'Looks good',
      status: 'APPROVED',
      approved: true,
      hasVerdictBlock: true
    })
  })

  test('defaults to needs work when verdict is missing', () => {
    expect(parseCriticVerdict('Please fix this')).toEqual({
      critique: 'Please fix this',
      status: 'NEEDS_WORK',
      approved: false,
      hasVerdictBlock: false
    })
  })
})
