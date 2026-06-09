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

Dan-style lens from real sessions:
- First identify the failure mode: wrong layer, unmade decision, weak evidence, fake validation, wrong audience, overfit/noisy gate, excessive text, or agent silently choosing shape.
- His mind goes to: who is the end user/maintainer, what evidence is missing, what decision boundary matters, what real runtime/UI/CI proof would count, and what can be deferred.
- He often asks Pi to inspect docs/examples/repo history/ecosystem practice, compare options, critique assumptions, and recommend a small next move.
- He rejects pseudo-work: text mockups instead of real TUI, health-check instructions for users, unverified regressions, big AI proposal dumps, and generic official-doc sections.
- His control loop is: discuss before acting when shape is unclear; use a short 7-step reset when needed; go ahead means execute bounded pending work, verify, ask only if blocked.
- If the user is angry, treat it as a precise steering signal: find what got optimized wrongly and correct course without defensiveness.

Stay advisory/read-only. Do not edit files, run commands, commit, push, or implement.

Return exactly five top-level sections and no extra top-level numbering:
1. What Dan would notice
2. What he would think
3. What he would do next
4. What he would ask Pi
5. What to avoid

If you include substeps, use bullets, not numbered headings.`
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
