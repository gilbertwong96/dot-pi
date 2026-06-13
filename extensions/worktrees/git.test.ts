import { describe, expect, test } from 'vitest'

import {
  formatWorktreeList,
  formatWorktreeStatus,
  parseWorktreePorcelain,
  validateWorktreeName,
  worktreePathFor
} from './git'

describe('worktree git helpers', () => {
  test('validates safe worktree names', () => {
    expect(validateWorktreeName('feature-a')).toBeUndefined()
    expect(validateWorktreeName('../bad')).toContain('path separators')
    expect(validateWorktreeName('bad name')).toContain('may only contain')
    expect(validateWorktreeName('')).toContain('required')
  })

  test('builds worktree paths under the fixed directory', () => {
    expect(worktreePathFor('/repo', 'task-a')).toBe('/repo/.worktrees/task-a')
  })

  test('parses git worktree porcelain output', () => {
    const output = `worktree /repo\nHEAD abcdef123456\nbranch refs/heads/main\n\nworktree /repo/.worktrees/task-a\nHEAD 123456abcdef\nbranch refs/heads/task-a\n`

    expect(parseWorktreePorcelain(output)).toEqual([
      { path: '/repo', branch: 'main', head: 'abcdef123456', bare: false, isMain: true },
      {
        path: '/repo/.worktrees/task-a',
        branch: 'task-a',
        head: '123456abcdef',
        bare: false,
        isMain: false
      }
    ])
  })

  test('formats list and status output', () => {
    const worktrees = parseWorktreePorcelain(
      'worktree /repo\nHEAD abcdef123456\nbranch refs/heads/main\n\n'
    )

    expect(formatWorktreeList(worktrees)).toContain('• main (main)')
    expect(
      formatWorktreeStatus({
        name: 'task-a',
        branch: 'task-a',
        path: '/repo/.worktrees/task-a',
        status: ' M file.ts',
        diff: ' file.ts | 1 +'
      })
    ).toContain('Diff summary:')
  })
})
