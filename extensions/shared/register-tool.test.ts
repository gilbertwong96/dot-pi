import { describe, expect, test } from 'vitest'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { registerTool } from './register-tool'
import { toolError, toolText } from './render'
import type { RegisteredTool } from './test-utils'

describe('native tool error channel', () => {
  test('returns structured failures with isError for Pi to report', async () => {
    let tool!: RegisteredTool
    const pi = {
      registerTool: (value: RegisteredTool) => {
        tool = value
      }
    } as unknown as ExtensionAPI
    registerTool(pi, {
      name: 'example',
      label: 'example',
      description: 'example',
      parameters: Type.Object({ fail: Type.Boolean() }),
      async execute(_id, { fail }) {
        return fail ? toolError('boom', { reason: 'structured' }) : toolText('ok', {})
      }
    })
    const failed = await tool.execute('failed', { fail: true }, undefined, undefined, {} as never)
    const succeeded = await tool.execute(
      'success',
      { fail: false },
      undefined,
      undefined,
      {} as never
    )
    expect(failed.isError).toBe(true)
    expect(failed.details).toEqual({ reason: 'structured' })
    expect(succeeded.isError).toBeUndefined()
  })
})
