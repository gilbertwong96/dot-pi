import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const handbookPath = join(packageRoot, 'docs', 'handbook.md')
const promptsPath = join(packageRoot, 'prompts')
const readmePath = join(packageRoot, 'README.md')

const agentDir = process.env.PI_CODING_AGENT_DIR ?? `${process.env.HOME}/.pi/agent`
const tutorRoot = join(agentDir, 'cache', 'pi-workflow-tutor')

export function tutorWorkspaceFor(cwd: string): string {
  const name = basename(cwd) || 'workspace'
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 10)
  return join(tutorRoot, `${name}-${hash}`)
}

export function buildTutorPrompt(args: string, cwd = process.cwd()): string {
  const focus = args.trim() || '/next'
  const playbook = buildPlaybookHint(focus)

  return `Teach me one small lesson for using this Pi setup in Dan's style.

Dan-style philosophy:
- Pi is a thinking framework, not just a coding harness.
- Optimize the workflow intentionally instead of maintaining long plans or TODO lists.
- Use LLM leverage especially in uncertainty: docs, architecture options, unfamiliar domains.
- Do not delegate decisions; use the agent as a critical thinking partner.
- Accelerate research, exploration, and judgment work, not only typing code.
- Keep the loop mentally sustainable: short lessons, concrete next moves, no giant brainstorm dumps.

Focus: ${focus}${playbook ? `\n\nFor workflow-imitation topics, cover this pattern:\n${playbook}` : ''}

Use these references only if needed:
- ${readmePath}
- ${handbookPath}
- ${promptsPath}

Keep it newcomer-friendly. Do not show internal scaffolding. Do not edit files, run commands, commit, or push.

Return exactly:
1. Lesson focus
2. Why it matters
3. Micro-lesson
4. Try this now
5. What to remember`
}

export function buildPlaybookHint(focus: string): string {
  const normalized = focus.toLowerCase()
  if (!/(vibe|package|workflow|imitat|ship|release|style|playbook)/.test(normalized)) return ''

  return `1. Use Pi as a thinking partner before coding: clarify uncertainty and options.
2. Inspect real docs, examples, conventions, and repo history instead of guessing.
3. Discuss shape, user value, ecosystem fit, and the smallest coherent direction.
4. Decide explicitly; do not let the agent silently choose the product/API shape.
5. Build the smallest useful slice, then align tests, docs, and naming.
6. Run focused checks, reject noisy overfit gates, and verify with real output.
7. Use the cadence: list 7 next steps → go ahead → verify → confirm risky publish/push/release actions.`
}

export function isTutorSmokeMode(): boolean {
  return process.env.PI_TUTOR_SMOKE === '1'
}

export default function tutor(pi: ExtensionAPI) {
  pi.registerCommand('tutor', {
    description: 'Teach one small Dan-style Pi workflow lesson',
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
