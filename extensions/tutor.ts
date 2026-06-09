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
  const workspace = tutorWorkspaceFor(cwd)
  const playbook = buildPlaybookHint(focus)

  return `Teach me one small lesson for using this Pi setup in Dan's style.

Focus: ${focus}${playbook ? `\n\nDan-style playbook to teach:\n${playbook}` : ''}

Use these references only if needed:
- ${readmePath}
- ${handbookPath}
- ${promptsPath}

Tutor notes, only if worth recording later: ${workspace}

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

  return `1. Discuss the shape, user value, and ecosystem fit before coding.
2. Inspect real docs, examples, conventions, and repo history instead of guessing.
3. Choose the smallest coherent package/API/product shape and name it clearly.
4. Build the smallest useful slice, then align tests with source structure.
5. Keep docs focused on the end user: purpose, install/use, examples, limits.
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
