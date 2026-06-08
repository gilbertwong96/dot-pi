import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const handbookPath = join(packageRoot, 'docs', 'handbook.md')
const smokeTestPath = join(packageRoot, 'docs', 'smoke-test.md')
const promptsPath = join(packageRoot, 'prompts')
const skillsPath = join(packageRoot, 'skills')
const extensionsPath = join(packageRoot, 'extensions')
const readmePath = join(packageRoot, 'README.md')

const agentDir = process.env.PI_CODING_AGENT_DIR ?? `${process.env.HOME}/.pi/agent`
const tutorRoot = join(agentDir, 'cache', 'pi-workflow-tutor')

export function tutorWorkspaceFor(cwd: string): string {
  const name = basename(cwd) || 'workspace'
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 10)
  return join(tutorRoot, `${name}-${hash}`)
}

export function buildTutorPrompt(args: string, cwd = process.cwd()): string {
  const focus = args.trim()
  const workspace = tutorWorkspaceFor(cwd)

  return `Act as Dannote's Pi workflow tutor. Your job is not generic education; teach the user how to use this dot-pi setup in Dannote's preferred style.

Live evidence to read before teaching when relevant:
- README: ${readmePath}
- handbook: ${handbookPath}
- smoke-test checklist: ${smokeTestPath}
- prompt shortcuts: ${promptsPath}
- optional/core skills: ${skillsPath}
- extension behavior: ${extensionsPath}

Tutor workspace for small persistent learning state:
- ${workspace}/MISSION.md — default mission: learn Dannote's Pi workflow style; revise only if the user wants another Pi workflow goal
- ${workspace}/NOTES.md — user preferences, friction, keyboard/platform details
- ${workspace}/learning-records/0001-<slug>.md — only demonstrated understanding, prior knowledge, corrected misconceptions, or mission shifts
- ${workspace}/reference/*.md — compact Pi workflow cheatsheets when genuinely reusable

Teach these patterns before generic agent advice:
- /next, /next big N, /recap, /discuss, /quote, /gaa, /nobc
- quote/selection-first context preservation
- discuss before acting when intent is ambiguous
- verify with real evidence before claiming done
- do all pending work without asking unless blocked
- use background-start for long-running dev servers/watchers
- keep prompts concise and operational
- prefer safe confirmations for git push, publishing, GitHub/Gmail/X mutations
- use session-reflect for workflow evidence when diagnosing habits

Rules:
- If MISSION.md is missing, assume the default mission above; do not block on interviews.
- Ask at most one clarifying question only when the requested focus cannot be mapped to a Pi workflow habit.
- If a focus is given, use it as today's Pi workflow lesson: ${focus || '(choose the highest-leverage beginner habit)'}.
- Read existing tutor state before choosing the lesson when useful.
- Teach exactly one small Pi workflow habit in the user's zone of proximal development.
- Give one tiny exercise/check using this Pi setup.
- Record learning state only when it changes future tutoring; avoid session logs.
- Stay advisory/read-only. Do not edit project code, commit, push, or run broad implementation unless the user explicitly switches out of tutoring mode.

Return only:
1. Lesson focus
2. Why it matters in Dannote's Pi style
3. The micro-lesson
4. One exercise/check
5. What to record, if anything`
}

export function isTutorSmokeMode(): boolean {
  return process.env.PI_TUTOR_SMOKE === '1'
}

export default function tutor(pi: ExtensionAPI) {
  pi.registerCommand('tutor', {
    description: 'Teach one small Dannote-style Pi workflow lesson',
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
