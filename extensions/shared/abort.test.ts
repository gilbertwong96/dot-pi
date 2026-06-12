import { describe, expect, test } from 'bun:test'

import { withTimeoutSignal } from './abort'

describe('withTimeoutSignal', () => {
  test('passes a live signal and returns callback result', async () => {
    const result = await withTimeoutSignal(undefined, 1000, async (signal) => {
      expect(signal.aborted).toBe(false)
      return 'ok'
    })

    expect(result).toBe('ok')
  })

  test('aborts when timeout elapses', async () => {
    const aborted = await withTimeoutSignal(undefined, 1, (signal) => {
      return new Promise<boolean>((resolve) => {
        signal.addEventListener('abort', () => resolve(signal.aborted), { once: true })
      })
    })

    expect(aborted).toBe(true)
  })

  test('forwards parent aborts', async () => {
    const controller = new AbortController()
    const aborted = withTimeoutSignal(controller.signal, 1000, (signal) => {
      return new Promise<boolean>((resolve) => {
        signal.addEventListener('abort', () => resolve(signal.aborted), { once: true })
      })
    })

    controller.abort()

    expect(await aborted).toBe(true)
  })
})
