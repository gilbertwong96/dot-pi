import { describe, expect, test } from 'bun:test'
import { shouldNotifyAgentEnd } from './notify'

describe('shouldNotifyAgentEnd', () => {
  test('skips empty internal turns', () => {
    expect(shouldNotifyAgentEnd(new Set(), '')).toBe(false)
  })

  test('notifies when there is a user prompt', () => {
    expect(shouldNotifyAgentEnd(new Set(), 'Go ahead')).toBe(true)
  })

  test('notifies when tools were used', () => {
    expect(shouldNotifyAgentEnd(new Set(['bash']), '')).toBe(true)
  })
})
