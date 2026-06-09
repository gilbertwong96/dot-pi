/**
 * ast-grep Tool Extensions
 *
 * AST-based code search and rewrite using ast-grep (sg).
 * Patterns match syntax structure, not text.
 */

import {
  type ExtensionAPI,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateTail
} from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { diffLines } from 'diff'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import pathModule from 'path'
import { expandHint, firstText, renderLines } from './shared/render'
import { Type } from 'typebox'

const SEARCH_DESCRIPTION = `Search code by AST pattern.

Unlike grep, patterns match syntax structure. Use $NAME for single node, $$$NAME for multiple nodes.

Examples:
- 'console.log($MSG)' — find console.log calls
- '$OBJ.map($FN)' — find .map() calls  
- 'if ($COND) { return $VAL }' — find early returns
- 'function $NAME($$$ARGS) { $$$BODY }' — find function declarations

Supports: TypeScript, JavaScript, Python, Go, Rust, Java, C, C++, and more.`

const REWRITE_DESCRIPTION = `Rewrite code by AST pattern.

Find matches and replace them. Metavariables ($NAME, $$$NAME) capture values for use in replacement.

Examples:
- pattern: 'console.log($MSG)' → replacement: 'logger.debug($MSG)'
- pattern: 'var $X = $V' → replacement: 'const $X = $V'
- pattern: '$ARR.forEach(($ITEM) => { $$$BODY })' → replacement: 'for (const $ITEM of $ARR) { $$$BODY }'

Use dryRun:true to preview changes without applying.`

function generateDiffString(oldContent: string, newContent: string, contextLines = 4) {
  const parts = diffLines(oldContent, newContent)
  const output: string[] = []
  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')
  const maxLineNum = Math.max(oldLines.length, newLines.length)
  const lineNumWidth = String(maxLineNum).length
  let oldLineNum = 1
  let newLineNum = 1
  let lastWasChange = false

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!part) continue
    const raw = part.value.split('\n')
    if (raw[raw.length - 1] === '') raw.pop()

    if (part.added || part.removed) {
      for (const line of raw) {
        if (part.added) {
          output.push(`+${String(newLineNum).padStart(lineNumWidth, ' ')} ${line}`)
          newLineNum++
        } else {
          output.push(`-${String(oldLineNum).padStart(lineNumWidth, ' ')} ${line}`)
          oldLineNum++
        }
      }
      lastWasChange = true
      continue
    }

    const nextPart = parts[i + 1]
    const nextPartIsChange = Boolean(nextPart?.added || nextPart?.removed)
    const hasLeadingChange = lastWasChange
    const hasTrailingChange = nextPartIsChange

    if (hasLeadingChange && hasTrailingChange) {
      const shown =
        raw.length <= contextLines * 2
          ? raw
          : [...raw.slice(0, contextLines), '...', ...raw.slice(-contextLines)]
      const skipped = raw.length - shown.filter((line) => line !== '...').length
      for (const line of shown) {
        if (line === '...') {
          output.push(` ${''.padStart(lineNumWidth, ' ')} ...`)
          oldLineNum += skipped
          newLineNum += skipped
        } else {
          output.push(` ${String(oldLineNum).padStart(lineNumWidth, ' ')} ${line}`)
          oldLineNum++
          newLineNum++
        }
      }
    } else if (hasLeadingChange) {
      const shown = raw.slice(0, contextLines)
      for (const line of shown) {
        output.push(` ${String(oldLineNum).padStart(lineNumWidth, ' ')} ${line}`)
        oldLineNum++
        newLineNum++
      }
      const skipped = raw.length - shown.length
      if (skipped > 0) {
        output.push(` ${''.padStart(lineNumWidth, ' ')} ...`)
        oldLineNum += skipped
        newLineNum += skipped
      }
    } else if (hasTrailingChange) {
      const skipped = Math.max(0, raw.length - contextLines)
      if (skipped > 0) {
        output.push(` ${''.padStart(lineNumWidth, ' ')} ...`)
        oldLineNum += skipped
        newLineNum += skipped
      }
      for (const line of raw.slice(skipped)) {
        output.push(` ${String(oldLineNum).padStart(lineNumWidth, ' ')} ${line}`)
        oldLineNum++
        newLineNum++
      }
    } else {
      oldLineNum += raw.length
      newLineNum += raw.length
    }
    lastWasChange = false
  }

  return output.join('\n')
}

async function dryRunFileRewrite(
  pi: Pick<ExtensionAPI, 'exec'>,
  sourcePath: string,
  args: string[],
  cwd: string
): Promise<{ cancelled?: boolean; diff?: string }> {
  const absolutePath = pathModule.isAbsolute(sourcePath)
    ? sourcePath
    : pathModule.join(cwd, sourcePath)
  const oldContent = await readFile(absolutePath, 'utf8')
  const tempDir = await mkdtemp(pathModule.join(tmpdir(), 'dot-pi-ast-rewrite-'))
  const tempFile = pathModule.join(tempDir, pathModule.basename(sourcePath))

  try {
    await writeFile(tempFile, oldContent)
    const tempArgs = args.slice(0, -1).concat('-U', tempFile)
    const result = await pi.exec('sg', tempArgs, { cwd })
    if (result.killed) return { cancelled: true }

    const newContent = await readFile(tempFile, 'utf8')
    if (oldContent === newContent) return {}
    return { diff: generateDiffString(oldContent, newContent) }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'ast-search',
    label: 'AST Search',
    description: SEARCH_DESCRIPTION,
    parameters: Type.Object({
      pattern: Type.String({ description: 'AST pattern to match' }),
      lang: Type.Optional(
        Type.String({ description: 'Language (typescript, python, go, rust, etc.)' })
      ),
      path: Type.Optional(
        Type.String({ description: 'Path to search (default: current directory)' })
      )
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { pattern, lang, path } = params as { pattern: string; lang?: string; path?: string }

      const args = ['run', '-p', pattern, '--color=never']
      if (lang) args.push('-l', lang)
      args.push(path || '.')

      const result = await pi.exec('sg', args, { cwd: ctx.cwd })

      if (result.killed) {
        return { content: [{ type: 'text', text: 'Search cancelled' }], details: {} }
      }

      const output = result.stdout || result.stderr
      if (!output.trim()) {
        return { content: [{ type: 'text', text: 'No matches found' }], details: {} }
      }

      const truncation = truncateTail(output, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES
      })
      let text = truncation.content
      if (truncation.truncated) {
        text += `\n\n[Truncated: showing last ${truncation.outputLines} of ${truncation.totalLines} lines]`
      }

      return { content: [{ type: 'text', text }], details: {} }
    },

    renderCall(params, theme) {
      const { pattern, lang, path } = params as { pattern: string; lang?: string; path?: string }
      let text = theme.fg('toolTitle', theme.bold('ast grep '))
      text += theme.fg('accent', `'${pattern}'`)
      if (lang) text += theme.fg('dim', ` -l ${lang}`)
      if (path) text += theme.fg('muted', ` ${path}`)
      return new Text(text, 0, 0)
    },

    renderResult(result, _options, theme) {
      const text = firstText(result).trimEnd()
      const matches = text
        .split('\n')
        .map((line) => line.match(/^(.*?):(\d+):(.*)$/))
        .filter((match): match is RegExpMatchArray => Boolean(match))

      if (matches.length > 0) {
        return renderLines([
          theme.fg('muted', `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`),
          ...matches.map((match) => {
            const [, file, line, source] = match
            return `${theme.fg('muted', `${file}:${line}`)}  ${source.trim()}`
          })
        ])
      }

      return renderLines(text.split('\n'))
    }
  })

  pi.registerTool({
    name: 'ast-rewrite',
    label: 'AST Rewrite',
    description: REWRITE_DESCRIPTION,
    parameters: Type.Object({
      pattern: Type.String({ description: 'AST pattern to match' }),
      replacement: Type.String({
        description: 'Replacement pattern (use captured $NAME variables)'
      }),
      lang: Type.Optional(
        Type.String({ description: 'Language (typescript, python, go, rust, etc.)' })
      ),
      path: Type.Optional(
        Type.String({ description: 'Path to rewrite (default: current directory)' })
      ),
      dryRun: Type.Optional(
        Type.Boolean({ description: 'Preview changes without applying (default: false)' })
      )
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { pattern, replacement, lang, path, dryRun } = params as {
        pattern: string
        replacement: string
        lang?: string
        path?: string
        dryRun?: boolean
      }

      const args = ['run', '-p', pattern, '-r', replacement, '--color=never']
      if (lang) args.push('-l', lang)
      if (!dryRun) args.push('-U') // --update-all: apply changes in place
      args.push(path || '.')

      if (dryRun && path) {
        try {
          const preview = await dryRunFileRewrite(pi, path, args, ctx.cwd)
          if (preview.cancelled) {
            return { content: [{ type: 'text', text: 'Rewrite cancelled' }], details: {} }
          }
          if (preview.diff) return { content: [{ type: 'text', text: preview.diff }], details: {} }
          return { content: [{ type: 'text', text: 'No matches found' }], details: {} }
        } catch {
          // Fall back to ast-grep's own dry-run output for non-file paths or unexpected failures.
        }
      }

      const result = await pi.exec('sg', args, { cwd: ctx.cwd })

      if (result.killed) {
        return { content: [{ type: 'text', text: 'Rewrite cancelled' }], details: {} }
      }

      const output = result.stdout || result.stderr
      if (!output.trim()) {
        return {
          content: [
            {
              type: 'text',
              text: dryRun ? 'No matches found' : 'No matches found (nothing to rewrite)'
            }
          ],
          details: {}
        }
      }

      const truncation = truncateTail(output, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES
      })
      let text = truncation.content

      if (truncation.truncated) {
        text += `\n\n[Truncated: showing last ${truncation.outputLines} of ${truncation.totalLines} lines]`
      }

      return { content: [{ type: 'text', text }], details: {} }
    },

    renderCall(params, theme) {
      const { pattern, replacement, lang, path, dryRun } = params as {
        pattern: string
        replacement: string
        lang?: string
        path?: string
        dryRun?: boolean
      }
      let text = theme.fg('toolTitle', theme.bold('ast edit '))
      text += theme.fg('accent', `'${pattern}'`)
      text += theme.fg('dim', ' → ')
      text += theme.fg('success', `'${replacement}'`)
      if (lang) text += theme.fg('dim', ` -l ${lang}`)
      if (path) text += theme.fg('muted', ` ${path}`)
      if (dryRun) text += theme.fg('muted', ' dry-run')
      return new Text(text, 0, 0)
    },

    renderResult(result, { expanded }, theme) {
      const text = firstText(result).trimEnd()
      if (!expanded && /^[-+]\d+ /m.test(text)) {
        const file = text
          .split('\n')
          .map((line) => line.trim())
          .find((line) => line.startsWith('/'))
        return renderLines([
          theme.fg('muted', 'changes preview'),
          ...(file ? [file] : []),
          '',
          expandHint(theme)
        ])
      }
      return renderLines(text.split('\n'))
    }
  })
}
