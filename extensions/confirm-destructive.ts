/**
 * Confirm Destructive Actions Extension
 *
 * Prompts for confirmation before:
 * - Destructive session actions (clear, switch, branch)
 * - Creating PRs/MRs and issues
 * - Writing review comments
 */

import type {
  ExtensionAPI,
  SessionBeforeSwitchEvent,
  SessionMessageEntry
} from '@earendil-works/pi-coding-agent'
import { isToolCallEventType } from '@earendil-works/pi-coding-agent'

const DESTRUCTIVE_BASH_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bgh\s+pr\s+create\b/, label: 'Create GitHub PR' },
  { pattern: /\bgh\s+issue\s+create\b/, label: 'Create GitHub issue' },
  { pattern: /\bgh\s+pr\s+comment\b/, label: 'Comment on GitHub PR' },
  { pattern: /\bgh\s+issue\s+comment\b/, label: 'Comment on GitHub issue' },
  { pattern: /\bgh\s+pr\s+review\b/, label: 'Submit GitHub PR review' },
  { pattern: /\bglab\s+mr\s+create\b/, label: 'Create GitLab MR' },
  { pattern: /\bglab\s+issue\s+create\b/, label: 'Create GitLab issue' },
  { pattern: /\bglab\s+mr\s+note\b/, label: 'Comment on GitLab MR' },
  { pattern: /\bglab\s+issue\s+note\b/, label: 'Comment on GitLab issue' }
]

export default function (pi: ExtensionAPI) {
  pi.on('tool_call', async (event, ctx) => {
    if (!ctx.hasUI) return
    if (!isToolCallEventType('bash', event)) return

    const command = event.input.command
    const match = DESTRUCTIVE_BASH_PATTERNS.find((p) => p.pattern.test(command))
    if (!match) return

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

    // reason === "resume" - check if there are unsaved changes (messages since last assistant response)
    const entries = ctx.sessionManager.getEntries()
    const hasUnsavedWork = entries.some(
      (e): e is SessionMessageEntry => e.type === 'message' && e.message.role === 'user'
    )

    if (hasUnsavedWork) {
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
