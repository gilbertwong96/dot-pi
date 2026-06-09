import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const agentDir = process.env.PI_CODING_AGENT_DIR ?? `${process.env.HOME}/.pi/agent`
const tutorRoot = join(agentDir, 'cache', 'pi-workflow-tutor')

export function tutorWorkspaceFor(cwd: string): string {
  const name = basename(cwd) || 'workspace'
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 10)
  return join(tutorRoot, `${name}-${hash}`)
}

export function buildTutorPrompt(args: string, cwd = process.cwd()): string {
  const focus = args.trim()
  tutorWorkspaceFor(cwd)

  return `Give me an in-place Dan-style workflow hint for this exact session.${focus ? `\nFocus: ${focus}` : ''}

Assume I am stuck, drifting, over-planning, under-verifying, or unsure what to do next. Use the current conversation as evidence. Do not give a generic lesson.

Dan-style lens: Pi is a thinking framework; use it hardest in uncertainty; do not delegate decisions; ask it for options, tradeoffs, critique, evidence, smallest useful slice, and focused verification.

Stay advisory/read-only. Do not edit files, run commands, commit, push, or implement.

Return exactly:
1. What Dan would notice
2. What he would think
3. What he would do next
4. What he would ask Pi
5. What to avoid`
}

export function isTutorSmokeMode(): boolean {
  return process.env.PI_TUTOR_SMOKE === '1'
}

export default function tutor(pi: ExtensionAPI) {
  pi.registerCommand('tutor', {
    description: 'Get an in-place Dan-style workflow hint for the current session',
    async handler(args, ctx) {
      if (isTutorSmokeMode()) {
        ctx.ui.notify(`Tutor smoke OK: ${args.trim() || 'default'}`, 'info')
        return
      }

      ctx.ui.notify('Running tutor…', 'info')
      pi.sendUserMessage(buildTutorPrompt(args, ctx.cwd))
    }
  })
}
