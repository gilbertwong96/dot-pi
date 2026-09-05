import { describe, expect, test, vi } from 'vitest'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import bashCompletion from './bash-completion'
import voice from './voice-input'

vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
  spawnSync: () => ({ status: 0 })
}))

describe('optional terminal-only extensions', () => {
  test.each([
    ['bash completion', bashCompletion],
    ['voice input', voice]
  ] as const)(
    '%s does not install a custom editor in RPC or headless sessions',
    async (_name, extension) => {
      const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>()
      extension({
        on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
          handlers.set(name, [...(handlers.get(name) ?? []), handler])
        },
        registerShortcut: () => undefined
      } as unknown as ExtensionAPI)
      for (const mode of ['rpc', 'print', 'json']) {
        const setEditorComponent = vi.fn()
        const ctx = {
          mode,
          hasUI: mode === 'rpc',
          ui: { setEditorComponent, notify: vi.fn() }
        } as unknown as ExtensionContext
        for (const handler of handlers.get('session_start') ?? []) await handler({}, ctx)
        expect(setEditorComponent).not.toHaveBeenCalled()
      }
      for (const handler of handlers.get('session_shutdown') ?? [])
        await handler({}, {} as ExtensionContext)
    }
  )
})
