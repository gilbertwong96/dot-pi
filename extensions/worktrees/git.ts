import { join } from 'node:path'

export const WORKTREES_DIR = '.worktrees'

export interface WorktreeInfo {
  path: string
  branch: string
  created: number
  setupCompleted: boolean
}

export interface WorktreeDetails {
  name: string
  path: string
  branch: string
}

export interface WorktreeEntry {
  path: string
  branch: string
  head: string
  bare: boolean
  isMain: boolean
}

export interface WorktreeListDetails {
  worktrees: WorktreeEntry[]
}

export function validateWorktreeName(name: string): string | undefined {
  if (!name.trim()) return 'Worktree name is required'
  if (name.includes('/') || name.includes('\\'))
    return 'Worktree name cannot contain path separators'
  if (name === '.' || name === '..') return 'Worktree name cannot be . or ..'
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return 'Worktree name may only contain letters, numbers, dot, underscore, and dash'
  }
  return undefined
}

export function worktreePathFor(cwd: string, name: string): string {
  return join(cwd, WORKTREES_DIR, name)
}

export function parseWorktreePorcelain(output: string): WorktreeEntry[] {
  const worktrees: WorktreeEntry[] = []
  let current: Partial<WorktreeEntry> = {}

  const flush = () => {
    if (!current.path) return
    worktrees.push({
      path: current.path,
      branch: current.branch || '(unknown)',
      head: current.head || '',
      bare: Boolean(current.bare),
      isMain: !current.path.includes(WORKTREES_DIR)
    })
    current = {}
  }

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      current.path = line.slice(9)
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice(5)
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7).replace('refs/heads/', '')
    } else if (line === 'bare') {
      current.bare = true
    } else if (line === 'detached') {
      current.branch = '(detached)'
    } else if (line === '') {
      flush()
    }
  }

  flush()
  return worktrees
}

export function formatWorktreeList(worktrees: WorktreeEntry[]): string {
  let output = `Found ${worktrees.length} worktree${worktrees.length !== 1 ? 's' : ''}:\n\n`
  for (const wt of worktrees) {
    const marker = wt.isMain ? ' (main)' : ''
    output += `• ${wt.branch}${marker}\n`
    output += `  Path: ${wt.path}\n`
    output += `  HEAD: ${wt.head.slice(0, 8)}\n\n`
  }
  return output.trim()
}

export function formatWorktreeStatus(options: {
  name?: string
  branch: string
  path: string
  status: string
  diff: string
  diffLabel?: string
}): string {
  let output = options.name ? `Worktree: ${options.name}\n` : ''
  output += `Branch: ${options.branch}\n`
  output += `Path: ${options.path}\n\n`

  if (options.status) {
    output += `Changes:\n${options.status}\n\n`
  } else {
    output += 'No uncommitted changes\n\n'
  }

  if (options.diff) {
    output += `${options.diffLabel ?? 'Diff summary'}:\n${options.diff}`
  }

  return output.trim()
}

export function isDirtyWorktreeRemovalError(error: string): boolean {
  return error.includes('uncommitted changes') || error.includes('untracked files')
}
