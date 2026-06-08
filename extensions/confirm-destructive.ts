/**
 * Confirm Destructive Actions Extension
 *
 * Prompts for confirmation before configured high-impact shell commands and
 * destructive session actions.
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

export type CommandRule = {
  argv: string[]
  label: string
}

const DEFAULT_COMMAND_RULES: CommandRule[] = [
  { argv: ['gh', 'pr', 'create'], label: 'Create GitHub PR' },
  { argv: ['gh', 'issue', 'create'], label: 'Create GitHub issue' },
  { argv: ['gh', 'pr', 'comment'], label: 'Comment on GitHub PR' },
  { argv: ['gh', 'issue', 'comment'], label: 'Comment on GitHub issue' },
  { argv: ['gh', 'pr', 'review'], label: 'Submit GitHub PR review' },
  { argv: ['glab', 'mr', 'create'], label: 'Create GitLab MR' },
  { argv: ['glab', 'issue', 'create'], label: 'Create GitLab issue' },
  { argv: ['glab', 'mr', 'note'], label: 'Comment on GitLab MR' },
  { argv: ['glab', 'issue', 'note'], label: 'Comment on GitLab issue' }
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

    notifyDesktop('Pi needs approval', `${match.label}: ${summarize(command)}`)

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
      notifyDesktop('Pi needs approval', 'Clear current session?')

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
      notifyDesktop('Pi needs approval', 'Switch session with unsaved messages?')

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

    notifyDesktop('Pi needs approval', `Fork from entry ${event.entryId.slice(0, 8)}?`)

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
    const match = rules.find((rule) => startsWithArgv(normalized, rule.argv))
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
  return ['-u', '-g', '-h', '-p', '-C', '--user', '--group', '--host', '--prompt'].includes(arg)
}

function startsWithArgv(argv: string[], prefix: string[]): boolean {
  return prefix.length > 0 && prefix.every((part, index) => argv[index] === part)
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
    const value = settings.confirmDestructiveCommands ?? settings.destructiveCommandRules
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

function summarize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 120)
}
