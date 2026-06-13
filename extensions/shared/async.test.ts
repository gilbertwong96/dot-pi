import { describe, expect, test } from 'vitest'

import { waitForValue } from './async'

describe('waitForValue', () => {
  test('returns immediately when a value is available', async () => {
    await expect(waitForValue(() => 'ready', { timeoutMs: 100 })).resolves.toBe('ready')
  })

  test('polls until a value appears', async () => {
    let attempts = 0
    const value = await waitForValue(
      () => {
        attempts += 1
        return attempts >= 2 ? 'ready' : undefined
      },
      { timeoutMs: 100, intervalMs: 1 }
    )

    expect(value).toBe('ready')
  })
})
