import { describe, expect, test } from 'vitest'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import astGrep from './ast-grep'
import type { RegisteredTool } from './shared/test-utils'

describe('AST execution lifecycle', () => {
  test('forwards cancellation and throws command failures rather than reporting success', async () => {
    const tools: RegisteredTool[] = []
    const calls: unknown[] = []
    astGrep({
      registerTool: (tool: RegisteredTool) => tools.push(tool),
      exec: async (_command: string, _args: string[], options: unknown) => {
        calls.push(options)
        return { code: 2, stdout: '', stderr: 'Invalid pattern', killed: false }
      }
    } as unknown as ExtensionAPI)
    const signal = new AbortController().signal
    for (const tool of tools) {
      await expect(
        tool.execute('id', { pattern: 'bad', replacement: 'new' }, signal, undefined, {
          cwd: '/tmp'
        } as never)
      ).rejects.toThrow('Invalid pattern')
    }
    expect(calls).toEqual([
      { cwd: '/tmp', signal },
      { cwd: '/tmp', signal }
    ])
  })
})
