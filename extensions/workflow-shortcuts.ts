import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

function parseNextArgs(args: string): { count: string; coarse: boolean } {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const coarseIndex = parts.findIndex((part) => ['big', 'b', 'coarse'].includes(part))
  const coarse = coarseIndex !== -1

  if (coarse) {
    parts.splice(coarseIndex, 1)
  }

  return { count: parts[0] || '7', coarse }
}

export function buildNextPrompt(args: string): string {
  const { count, coarse } = parseNextArgs(args)
  const granularity = coarse
    ? ' at coarse granularity. Each step should be a meaningful work chunk, not a micro-action. Avoid routine substeps unless they are the main work item.'
    : '.'

  return `State briefly. List exactly ${count} next steps${granularity} End with best action.`
}

export function buildDiscussPrompt(args: string): string {
  const topic = args.trim()

  return `Let's discuss before acting.

Do not edit files, run commands, commit, or push yet. Clarify tradeoffs, options, risks, and likely paths. Ask questions only if they materially change the decision. End with a concise recommendation.${topic ? ` Topic: ${topic}` : ''}`
}

export function buildRecapPrompt(args: string): string {
  const focus = args.trim()

  return `Reconstruct the global context from this conversation so you and I are both re-oriented. Do not over-focus on the last turn.

Cover:

1. Original goal / plan
2. Current state
3. Important decisions
4. Open threads
5. Drift or plan changes
6. Best next action

Keep it concise.${focus ? ` Focus on: ${focus}` : ''}`
}

export default function workflowShortcuts(pi: ExtensionAPI) {
  pi.registerCommand('next', {
    description: 'State briefly, list next steps, and pick the best action',
    async handler(args) {
      pi.sendUserMessage(buildNextPrompt(args))
    }
  })

  pi.registerCommand('discuss', {
    description: 'Discuss tradeoffs before acting; do not make changes yet',
    async handler(args) {
      pi.sendUserMessage(buildDiscussPrompt(args))
    }
  })

  pi.registerCommand('recap', {
    description: 'Reconstruct global context and identify the best next action',
    async handler(args) {
      pi.sendUserMessage(buildRecapPrompt(args))
    }
  })
}
