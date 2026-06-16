/**
 * Rules Extension
 *
 * Scans ~/.pi/agent/rules/ and installed packages' rules/ directories for rule files
 * and loads their content into the system prompt. User rules in ~/.pi/agent/rules/
 * take precedence over package rules with the same filename.
 *
 * Supports optional YAML frontmatter for filtering:
 *   - `models:` glob pattern(s) matching "provider/model-id" (e.g. "openai-codex/*", "llm-proxy/claude-*")
 *   - `paths:` (passthrough, handled by pi core)
 *
 * Rules without `models:` frontmatter apply to all models.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { parseFrontmatter } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { minimatch } from 'minimatch'

type RuleFrontmatter = {
  models?: string | string[]
  [key: string]: unknown
}

type RuleFile = {
  relativePath: string
  fullPath: string
  content: string
  frontmatter: RuleFrontmatter
  body: string
  source?: 'user' | 'package'
}

function matchesModel(patterns: string | string[], modelKey: string): boolean {
  const list = Array.isArray(patterns) ? patterns : [patterns]
  return list.some((p) => minimatch(modelKey, p))
}

function loadRuleFiles(dir: string, basePath: string = ''): RuleFile[] {
  const results: RuleFile[] = []

  if (!fs.existsSync(dir)) return results

  const entries = fs.readdirSync(dir, { withFileTypes: true })

  for (const entry of entries) {
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name
    const fullPath = path.join(dir, entry.name)

    let isDirectory = entry.isDirectory()
    let isFile = entry.isFile()

    if (entry.isSymbolicLink()) {
      try {
        const stats = fs.statSync(fullPath)
        isDirectory = stats.isDirectory()
        isFile = stats.isFile()
      } catch {
        continue
      }
    }

    if (isDirectory) {
      results.push(...loadRuleFiles(fullPath, relativePath))
    } else if (isFile && entry.name.endsWith('.md')) {
      try {
        const content = fs.readFileSync(fullPath, 'utf-8')
        const { frontmatter, body } = parseFrontmatter<RuleFrontmatter>(content)
        results.push({ relativePath, fullPath, content, frontmatter, body })
      } catch {
        // Skip files that can't be read
      }
    }
  }

  return results
}

const RULES_MESSAGE_TYPE = 'rules-list'

type RulesMessageDetails = {
  files: string[]
  userFiles: string[]
  packageFiles: string[]
}

function isRulesListMessage(message: AgentMessage): boolean {
  if (message.role !== 'custom') return false
  return (message as { customType?: string }).customType === RULES_MESSAGE_TYPE
}

function findPackageRulesDirs(agentDir: string): string[] {
  const dirs: string[] = []

  // Scan git packages: ~/.pi/agent/git/<host>/<owner>/<repo>/rules/
  const gitDir = path.join(agentDir, 'git')
  if (fs.existsSync(gitDir)) {
    for (const host of fs.readdirSync(gitDir)) {
      const hostPath = path.join(gitDir, host)
      try {
        if (!fs.statSync(hostPath).isDirectory()) continue
      } catch {
        continue
      }
      for (const owner of fs.readdirSync(hostPath)) {
        const ownerPath = path.join(hostPath, owner)
        try {
          if (!fs.statSync(ownerPath).isDirectory()) continue
        } catch {
          continue
        }
        for (const repo of fs.readdirSync(ownerPath)) {
          const repoPath = path.join(ownerPath, repo)
          try {
            if (!fs.statSync(repoPath).isDirectory()) continue
          } catch {
            continue
          }
          const rulesPath = path.join(repoPath, 'rules')
          try {
            if (fs.statSync(rulesPath).isDirectory()) {
              dirs.push(rulesPath)
            }
          } catch {
            // no rules dir in this package
          }
        }
      }
    }
  }

  // Scan npm packages: ~/.pi/agent/npm/<package>/rules/
  const npmDir = path.join(agentDir, 'npm')
  if (fs.existsSync(npmDir)) {
    for (const pkg of fs.readdirSync(npmDir)) {
      const pkgPath = path.join(npmDir, pkg)
      try {
        if (!fs.statSync(pkgPath).isDirectory()) continue
      } catch {
        continue
      }
      const rulesPath = path.join(pkgPath, 'rules')
      try {
        if (fs.statSync(rulesPath).isDirectory()) {
          dirs.push(rulesPath)
        }
      } catch {
        // no rules dir in this package
      }
    }
  }

  return dirs
}

export default function rulesExtension(pi: ExtensionAPI) {
  let ruleFiles: RuleFile[] = []
  const agentDir = path.join(os.homedir(), '.pi', 'agent')
  const rulesDir = path.join(agentDir, 'rules')

  pi.registerMessageRenderer<RulesMessageDetails>(
    RULES_MESSAGE_TYPE,
    (message, _options, theme) => {
      const details = message.details ?? { files: [], userFiles: [], packageFiles: [] }
      const lines: string[] = []
      lines.push(theme.fg('mdHeading', '[Rules]'))

      for (const { label, files } of [
        { label: 'user', files: details.userFiles },
        { label: 'packages', files: details.packageFiles }
      ]) {
        if (files.length === 0) continue
        lines.push(`  ${theme.fg('accent', label)}`)
        for (const file of files) {
          const shortPath = file.replace(os.homedir(), '~')
          lines.push(theme.fg('dim', `    ${shortPath}`))
        }
      }

      return new Text(lines.join('\n'), 0, 0)
    }
  )

  pi.on('context', async (event) => {
    return {
      messages: event.messages.filter((message) => !isRulesListMessage(message))
    }
  })

  pi.on('session_start', async (_event, ctx) => {
    // Load user rules from ~/.pi/agent/rules/
    const userRules = loadRuleFiles(rulesDir).map((r) => ({ ...r, source: 'user' as const }))

    // Load package rules from installed packages' rules/ directories
    const packageRulesDirs = findPackageRulesDirs(agentDir)
    const userRuleNames = new Set(userRules.map((r) => path.basename(r.relativePath)))
    const packageRules: RuleFile[] = []
    for (const dir of packageRulesDirs) {
      const rules = loadRuleFiles(dir)
      for (const rule of rules) {
        if (!userRuleNames.has(path.basename(rule.relativePath))) {
          packageRules.push({ ...rule, source: 'package' as const })
        }
      }
    }

    ruleFiles = [...userRules, ...packageRules]

    if (ruleFiles.length > 0) {
      if (ctx.hasUI) {
        const userFiles = userRules.map((r) => r.fullPath)
        const packageFiles = packageRules.map((r) => r.fullPath)
        pi.sendMessage({
          customType: RULES_MESSAGE_TYPE,
          content: 'Loaded rules',
          display: true,
          details: { files: [...userFiles, ...packageFiles], userFiles, packageFiles }
        })
      }

      const parts: string[] = []
      if (userRules.length > 0) parts.push(`${userRules.length} from ~/.pi/agent/rules/`)
      if (packageRules.length > 0) parts.push(`${packageRules.length} from packages`)
      ctx.ui.notify(`Loaded ${ruleFiles.length} rule(s) (${parts.join(', ')})`, 'info')
    }
  })

  pi.on('before_agent_start', async (event, ctx) => {
    if (ruleFiles.length === 0) return

    const model = ctx.model
    const modelKey = model ? `${model.provider}/${model.id}` : ''

    const activeRules = ruleFiles.filter((rule) => {
      if (!rule.frontmatter.models) return true
      if (!modelKey) return true
      return matchesModel(rule.frontmatter.models, modelKey)
    })

    if (activeRules.length === 0) return

    const rulesContent = activeRules
      .map((rule) => `Instructions from: ${rule.fullPath}\n${rule.body}`)
      .join('\n\n')

    return {
      systemPrompt: `${rulesContent}

${event.systemPrompt}`
    }
  })
}
