import { describe, expect, test } from 'bun:test'

import context7 from './context7'
import lsp from './lsp'
import { formatWorktreeList, parseWorktreePorcelain } from './worktrees/git'
import websearch from './websearch'
import { registeredTool, renderComponentText, testTheme } from './shared/test-utils'

function renderResult(
  extension: Parameters<typeof registeredTool>[0],
  toolName: string,
  details: object,
  text: string
) {
  const tool = registeredTool(extension, toolName)
  return renderComponentText(
    tool.renderResult?.(
      { content: [{ type: 'text', text }], details },
      { expanded: false, isPartial: false },
      testTheme,
      {} as never
    )
  )
}

describe('renderer smoke snapshots', () => {
  test('websearch compact result stays semantic', () => {
    const rendered = renderResult(
      websearch,
      'websearch',
      {
        query: 'pi tools',
        results: [
          {
            title: 'Pi Tools',
            url: 'https://example.com/pi',
            text: 'Tooling overview',
            highlights: ['Fast tools']
          }
        ]
      },
      'Found 1 result'
    )

    expect(rendered).toContain('Pi Tools')
    expect(rendered).toContain('https://example.com/pi')
  })

  test('context7 docs compact result exposes library metadata', () => {
    const rendered = renderResult(
      context7,
      'context7-docs',
      { libraryId: '/reactjs/react.dev' },
      'useState lets you add state to a component.'
    )

    expect(rendered).toContain('useState lets you add state')
  })

  test('lsp compact result renders status output', () => {
    const rendered = renderResult(
      lsp,
      'lsp',
      { action: 'status', success: true },
      'Active language servers: typescript'
    )

    expect(rendered).toContain('Active language servers')
    expect(rendered).toContain('typescript')
  })

  test('worktree compact formatting keeps path and main marker', () => {
    const rendered = formatWorktreeList(
      parseWorktreePorcelain('worktree /repo\nHEAD abcdef123456\nbranch refs/heads/main\n\n')
    )

    expect(rendered).toContain('main (main)')
    expect(rendered).toContain('/repo')
  })
})
