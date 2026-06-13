import { describe, expect, test } from 'vitest'

import { commandFailure, commandOutput } from './process'

describe('process helpers', () => {
  test('prefers stderr over stdout', () => {
    expect(commandOutput({ stdout: 'out', stderr: 'err' })).toBe('err')
  })

  test('formats command failures with exit code', () => {
    expect(commandFailure({ code: 2, stderr: 'bad' }, 'Failed')).toBe('Failed (exit 2): bad')
  })
})
