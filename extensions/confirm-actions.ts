/**
 * Confirm Actions Extension
 *
 * Prompts for confirmation before configured publish/mutate shell commands and
 * session actions that need explicit user approval.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  ExtensionAPI,
  SessionBeforeSwitchEvent,
  SessionMessageEntry
} from '@earendil-works/pi-coding-agent'
import { isToolCallEventType } from '@earendil-works/pi-coding-agent'
import { parse, type ParseEntry } from 'shell-quote'
import { parse as parseJsonc } from 'jsonc-parser'
import { notifyDesktop } from './shared/desktop-notify'
import { formatPiNotificationTitle } from './shared/project-name'

export type CommandRule = {
  argv: string[]
  label: string
  matches?: (argv: string[]) => boolean
}

export const DEFAULT_COMMAND_RULES: CommandRule[] = [
  { argv: ['gh', 'pr', 'create'], label: 'Publish GitHub PR' },
  { argv: ['gh', 'pr', 'edit'], label: 'Edit GitHub PR' },
  { argv: ['gh', 'pr', 'comment'], label: 'Publish GitHub PR comment' },
  { argv: ['gh', 'pr', 'review'], label: 'Publish GitHub PR review' },
  { argv: ['gh', 'issue', 'create'], label: 'Publish GitHub issue' },
  { argv: ['gh', 'issue', 'edit'], label: 'Edit GitHub issue' },
  { argv: ['gh', 'issue', 'comment'], label: 'Publish GitHub issue comment' },
  { argv: ['gh', 'repo', 'create'], label: 'Create GitHub repo' },
  { argv: ['gh', 'repo', 'delete'], label: 'Delete GitHub repo' },
  { argv: ['gh', 'repo', 'archive'], label: 'Archive GitHub repo' },
  { argv: ['gh', 'repo', 'edit'], label: 'Edit GitHub repo' },
  { argv: ['gh', 'repo', 'rename'], label: 'Rename GitHub repo' },
  { argv: ['gh', 'repo', 'transfer'], label: 'Transfer GitHub repo' },
  {
    argv: ['gh', 'repo', 'deploy-key'],
    label: 'Mutate GitHub repo deploy keys',
    matches: isMutatingGhSubcommand
  },
  { argv: ['gh', 'repo', 'set-default'], label: 'Change default GitHub repo' },
  { argv: ['gh', 'release', 'create'], label: 'Publish GitHub release' },
  { argv: ['gh', 'release', 'delete'], label: 'Delete GitHub release' },
  { argv: ['gh', 'release', 'edit'], label: 'Edit GitHub release' },
  { argv: ['gh', 'api'], label: 'Mutate via GitHub API', matches: isMutatingGhApi },
  { argv: ['gws', 'gmail'], label: 'Mutate Gmail', matches: isMutatingGmail },
  { argv: ['bird'], label: 'Mutate X/Twitter', matches: isMutatingBird },
  {
    argv: ['bunx', '@dannote/bird-premium'],
    label: 'Mutate X/Twitter',
    matches: isMutatingBird
  },
  { argv: ['glab', 'mr', 'create'], label: 'Publish GitLab MR' },
  { argv: ['glab', 'mr', 'update'], label: 'Edit GitLab MR' },
  { argv: ['glab', 'mr', 'note'], label: 'Publish GitLab MR comment' },
  { argv: ['glab', 'issue', 'create'], label: 'Publish GitLab issue' },
  { argv: ['glab', 'issue', 'update'], label: 'Edit GitLab issue' },
  { argv: ['glab', 'issue', 'note'], label: 'Publish GitLab issue comment' },
  { argv: ['glab', 'release', 'create'], label: 'Publish GitLab release' },
  { argv: ['git'], label: 'Force push', matches: isGitForcePush },
  { argv: ['git'], label: 'Delete remote branch', matches: isGitRemoteBranchDelete },
  { argv: ['git'], label: 'Push git commits', matches: isGitPush },
  { argv: ['git'], label: 'Hard reset', matches: isGitHardReset },
  { argv: ['git'], label: 'Clean working tree', matches: isGitForcedClean },
  { argv: ['git'], label: 'Delete local branch', matches: isGitBranchDelete },
  { argv: ['npm'], label: 'Publish npm package', matches: hasSubcommand('publish') },
  { argv: ['pnpm'], label: 'Publish npm package', matches: hasSubcommand('publish') },
  { argv: ['bun'], label: 'Publish package', matches: hasSubcommand('publish') },
  { argv: ['yarn'], label: 'Publish npm package', matches: hasSubcommand('npm', 'publish') },
  { argv: ['vercel'], label: 'Deploy with Vercel' },
  { argv: ['netlify'], label: 'Deploy with Netlify', matches: hasSubcommand('deploy') },
  { argv: ['firebase'], label: 'Deploy with Firebase', matches: hasSubcommand('deploy') },
  { argv: ['fly'], label: 'Deploy with Fly.io', matches: hasSubcommand('deploy') },
  {
    argv: ['wrangler'],
    label: 'Deploy with Wrangler',
    matches: hasAnySubcommand(['deploy', 'publish'])
  }
]

const CONTROL_OPERATORS = new Set(['&&', '||', ';', '|', '|&', '&'])
const PREFIX_WRAPPERS = new Set(['sudo', 'command', 'env', 'noglob'])

export default function (pi: ExtensionAPI) {
  let commandRules = DEFAULT_COMMAND_RULES

  pi.on('session_start', (_event, ctx) => {
    commandRules = loadCommandRules(ctx.cwd)
  })

  pi.on('tool_call', async (event, ctx) => {
    if (!ctx.hasUI) return
    if (!isToolCallEventType('bash', event)) return

    const command = event.input.command
    const match = matchCommandRule(command, commandRules)
    if (!match) return

    notifyDesktop(notificationTitle(ctx.cwd), `Approve: ${match.label}`)

    const confirmed = await ctx.ui.confirm(
      `${match.label}?`,
      'Review the command before submitting.'
    )

    if (!confirmed) {
      ctx.ui.notify(`${match.label} cancelled`, 'info')
      return { block: true, reason: `User cancelled: ${match.label}` }
    }
  })

  pi.on('session_before_switch', async (event: SessionBeforeSwitchEvent, ctx) => {
    if (!ctx.hasUI) return

    if (event.reason === 'new') {
      notifyDesktop(notificationTitle(ctx.cwd), 'Approve: clear current session')

      const confirmed = await ctx.ui.confirm(
        'Clear session?',
        'This will delete all messages in the current session.'
      )

      if (!confirmed) {
        ctx.ui.notify('Clear cancelled', 'info')
        return { cancel: true }
      }
      return
    }

    const entries = ctx.sessionManager.getEntries()
    const hasUnsavedWork = entries.some(
      (e): e is SessionMessageEntry => e.type === 'message' && e.message.role === 'user'
    )

    if (hasUnsavedWork) {
      notifyDesktop(notificationTitle(ctx.cwd), 'Approve: switch session')

      const confirmed = await ctx.ui.confirm(
        'Switch session?',
        'You have messages in the current session. Switch anyway?'
      )

      if (!confirmed) {
        ctx.ui.notify('Switch cancelled', 'info')
        return { cancel: true }
      }
    }
  })

  pi.on('session_before_fork', async (event, ctx) => {
    if (!ctx.hasUI) return

    notifyDesktop(notificationTitle(ctx.cwd), `Approve: fork from ${event.entryId.slice(0, 8)}`)

    const choice = await ctx.ui.select(`Fork from entry ${event.entryId.slice(0, 8)}?`, [
      'Yes, create fork',
      'No, stay in current session'
    ])

    if (choice !== 'Yes, create fork') {
      ctx.ui.notify('Fork cancelled', 'info')
      return { cancel: true }
    }
  })
}

export function matchCommandRule(command: string, rules: CommandRule[]): CommandRule | undefined {
  for (const invocation of parseInvocations(command)) {
    const normalized = normalizeInvocation(invocation)
    const match = rules.find(
      (rule) => startsWithArgv(normalized, rule.argv) && (rule.matches?.(normalized) ?? true)
    )
    if (match) return match
  }
}

export function parseInvocations(command: string): string[][] {
  let entries: ParseEntry[]
  try {
    entries = parse(command)
  } catch {
    return []
  }

  const invocations: string[][] = []
  let current: string[] = []

  for (const entry of entries) {
    if (typeof entry === 'string') {
      current.push(entry)
      continue
    }

    if ('op' in entry && CONTROL_OPERATORS.has(entry.op)) {
      if (current.length > 0) invocations.push(current)
      current = []
    }
  }

  if (current.length > 0) invocations.push(current)
  return invocations
}

function normalizeInvocation(argv: string[]): string[] {
  let rest = dropAssignments(argv)

  while (rest.length > 0 && PREFIX_WRAPPERS.has(rest[0] ?? '')) {
    const wrapper = rest[0]
    rest = rest.slice(1)

    if (wrapper === 'sudo' || wrapper === 'env') {
      rest = dropFlagsAndAssignments(rest)
    }
  }

  return rest
}

function dropAssignments(argv: string[]): string[] {
  const index = argv.findIndex((arg) => !isAssignment(arg))
  return index === -1 ? [] : argv.slice(index)
}

function dropFlagsAndAssignments(argv: string[]): string[] {
  let index = 0
  while (index < argv.length) {
    const arg = argv[index] ?? ''
    if (isAssignment(arg)) {
      index += 1
      continue
    }
    if (!isFlag(arg)) break

    index += flagConsumesValue(arg) ? 2 : 1
  }
  return argv.slice(index)
}

function flagConsumesValue(arg: string): boolean {
  return ['-u', '-g', '-h', '-p', '-C', '-c', '--user', '--group', '--host', '--prompt'].includes(
    arg
  )
}

function startsWithArgv(argv: string[], prefix: string[]): boolean {
  return prefix.length > 0 && prefix.every((part, index) => argv[index] === part)
}

function isMutatingGhApi(argv: string[]): boolean {
  const method = getOptionValue(argv, ['--method', '-X'])?.toUpperCase()
  if (method && method !== 'GET') return true
  if (method === 'GET') return false

  return argv.some((arg) => ['--field', '-f', '--raw-field', '-F'].includes(arg))
}

function isMutatingGhSubcommand(argv: string[]): boolean {
  return argv.some((arg) => ['add', 'delete', 'remove'].includes(arg))
}

function isMutatingGmail(argv: string[]): boolean {
  if (hasAnyFlag(argv, ['--dry-run'])) return false

  return argv.some((arg) =>
    [
      '+send',
      '+reply',
      '+reply-all',
      '+forward',
      'send',
      'import',
      'insert',
      'trash',
      'untrash',
      'delete',
      'batchDelete',
      'modify',
      'batchModify',
      'create',
      'update',
      'patch'
    ].includes(arg)
  )
}

function isMutatingBird(argv: string[]): boolean {
  return argv.some((arg) =>
    [
      'tweet',
      'reply',
      'delete',
      'like',
      'unlike',
      'retweet',
      'unretweet',
      'bookmark',
      'unbookmark',
      'follow',
      'unfollow'
    ].includes(arg)
  )
}

function isGitForcePush(argv: string[]): boolean {
  return (
    getGitSubcommand(argv) === 'push' && hasAnyFlag(argv, ['--force', '--force-with-lease', '-f'])
  )
}

function isGitRemoteBranchDelete(argv: string[]): boolean {
  return (
    getGitSubcommand(argv) === 'push' && (argv.includes('--delete') || argv.some(isDeleteRefspec))
  )
}

function isGitPush(argv: string[]): boolean {
  return getGitSubcommand(argv) === 'push'
}

function isGitHardReset(argv: string[]): boolean {
  return getGitSubcommand(argv) === 'reset' && hasAnyFlag(argv, ['--hard'])
}

function isGitForcedClean(argv: string[]): boolean {
  return getGitSubcommand(argv) === 'clean' && hasAnyFlag(argv, ['-f', '--force'])
}

function isGitBranchDelete(argv: string[]): boolean {
  return getGitSubcommand(argv) === 'branch' && hasAnyFlag(argv, ['-d', '-D', '--delete'])
}

function getGitSubcommand(argv: string[]): string | undefined {
  let index = 1
  while (index < argv.length) {
    const arg = argv[index] ?? ''
    if (isAssignment(arg)) {
      index += 1
      continue
    }
    if (!isFlag(arg)) return arg
    index += flagConsumesValue(arg) ? 2 : 1
  }
}

function hasSubcommand(...subcommand: string[]): (argv: string[]) => boolean {
  return (argv) => findSubcommandIndex(argv, subcommand) !== -1
}

function hasAnySubcommand(subcommands: string[]): (argv: string[]) => boolean {
  return (argv) => subcommands.some((subcommand) => findSubcommandIndex(argv, [subcommand]) !== -1)
}

function findSubcommandIndex(argv: string[], subcommand: string[]): number {
  for (let index = 1; index <= argv.length - subcommand.length; index += 1) {
    if (subcommand.every((part, offset) => argv[index + offset] === part)) return index
  }
  return -1
}

function hasAnyFlag(argv: string[], flags: string[]): boolean {
  return argv.some((arg) => flags.some((flag) => hasFlag(arg, flag)))
}

function hasFlag(arg: string, flag: string): boolean {
  if (arg === flag || arg.startsWith(`${flag}=`)) return true
  return /^-[A-Za-z]+$/.test(arg) && /^-[A-Za-z]$/.test(flag) && arg.includes(flag.slice(1))
}

function isDeleteRefspec(arg: string): boolean {
  return /^:[^:]+/.test(arg)
}

function getOptionValue(argv: string[], names: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    for (const name of names) {
      if (arg === name) return argv[index + 1]
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
    }
  }
}

function isAssignment(arg: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(arg)
}

function isFlag(arg: string): boolean {
  return arg.startsWith('-') && arg !== '-'
}

function loadCommandRules(cwd: string): CommandRule[] {
  const globalPath = process.env.PI_CODING_AGENT_DIR
    ? join(process.env.PI_CODING_AGENT_DIR, 'settings.json')
    : join(homedir(), '.pi', 'agent', 'settings.json')
  const projectPath = join(cwd, '.pi', 'settings.json')

  const customRules = [...readCommandRules(globalPath), ...readCommandRules(projectPath)]
  return [...DEFAULT_COMMAND_RULES, ...customRules]
}

function readCommandRules(path: string): CommandRule[] {
  if (!existsSync(path)) return []

  try {
    const settings = parseJsonc(readFileSync(path, 'utf8')) as Record<string, unknown>
    const value = settings.confirmCommands
    if (!Array.isArray(value)) return []

    return value.flatMap((item) => parseRule(item))
  } catch {
    return []
  }
}

function parseRule(item: unknown): CommandRule[] {
  if (!item || typeof item !== 'object') return []

  const rule = item as { argv?: unknown; command?: unknown; label?: unknown }
  const argv = Array.isArray(rule.argv)
    ? rule.argv.filter((part): part is string => typeof part === 'string' && part.length > 0)
    : typeof rule.command === 'string'
      ? rule.command.trim().split(/\s+/)
      : []

  if (argv.length === 0 || typeof rule.label !== 'string' || rule.label.length === 0) return []
  return [{ argv, label: rule.label }]
}

function notificationTitle(cwd: string): string {
  return formatPiNotificationTitle(cwd)
}
