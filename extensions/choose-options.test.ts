import { describe, expect, test } from 'vitest'
import { formatChoiceResult } from './choose-options'

describe('formatChoiceResult', () => {
  test('formats selected options for the model', () => {
    expect(
      formatChoiceResult({
        question: 'What next?',
        action: 'Do selected',
        options: [{ label: 'Fix API' }, { label: 'Write docs' }],
        selectedIndexes: [0, 1],
        cancelled: false
      })
    ).toContain('1. Fix API\n2. Write docs')
  })

  test('formats cancellation', () => {
    expect(
      formatChoiceResult({
        question: 'What next?',
        action: 'Do selected',
        options: [],
        selectedIndexes: [],
        cancelled: true
      })
    ).toBe('User cancelled option selection.')
  })
})
