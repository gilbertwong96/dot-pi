import { describe, expect, test } from 'vitest'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { registerTool } from './register-tool'
import { toolError, toolText } from './render'
import type { RegisteredTool } from './test-utils'

describe('native tool error channel', () => {
  test('marks only the matching failed call and retains structured details', async () => {
    const hooks = new Map<string, (event: unknown) => unknown>()
    let tool!: RegisteredTool
    const pi = {
      on: (name: string, handler: (event: unknown) => unknown) => hooks.set(name, handler),
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
    await tool.execute('success', { fail: false }, undefined, undefined, {} as never)
    const result = hooks.get('tool_result')!
    expect(result({ toolName: 'other', toolCallId: 'failed' })).toBeUndefined()
    expect(result({ toolName: 'example', toolCallId: 'success' })).toBeUndefined()
    expect(result({ toolName: 'example', toolCallId: 'failed' })).toEqual({ isError: true })
    expect(failed.details).toEqual({ reason: 'structured' })
    expect(result({ toolName: 'example', toolCallId: 'failed' })).toBeUndefined()
    await tool.execute('pending', { fail: true }, undefined, undefined, {} as never)
    hooks.get('session_shutdown')!({})
    expect(result({ toolName: 'example', toolCallId: 'pending' })).toBeUndefined()
  })
})
