/**
 * ast-grep Tool Extensions
 *
 * AST-based code search and rewrite using ast-grep (sg).
 * Patterns match syntax structure, not text.
 */

import {
  type ExtensionAPI,
  type ExecResult,
  type Theme,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  generateDiffString,
  renderDiff,
  truncateTail
} from '@earendil-works/pi-coding-agent'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import pathModule from 'path'
import {
  expandHint,
  firstText,
  renderLines,
  renderToolCall,
  toolText,
  renderTextLinesPreview,
  renderEmpty,
  renderError
} from './shared/render'
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

function colorDiff(text: string, theme: Theme): string[] {
  try {
    return renderDiff(text).split('\n')
  } catch {
    return text.split('\n').map((line) => {
      if (line.startsWith('+')) return theme.fg('success', line)
      if (line.startsWith('-')) return theme.fg('error', line)
      return theme.fg('toolOutput', line)
    })
  }
}

function execFailure(result: ExecResult, action: string): string | undefined {
  if (result.truncated) return `${action}: output exceeded the limit and was truncated`
  if (result.killed) return `${action} cancelled`
  if (result.code !== 0 && result.code !== 1) {
    return result.stderr || result.stdout || `ast-grep exited with code ${result.code}`
  }
}

async function dryRunFileRewrite(
  pi: Pick<ExtensionAPI, 'exec'>,
  sourcePath: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal
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
    const result = await pi.exec('sg', tempArgs, { cwd, signal })
    if (result.killed) return { cancelled: true }
    const failure = execFailure(result, 'Rewrite')
    if (failure) throw new Error(failure)

    const newContent = await readFile(tempFile, 'utf8')
    if (oldContent === newContent) return {}
    return { diff: generateDiffString(oldContent, newContent).diff }
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

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { pattern, lang, path } = params as { pattern: string; lang?: string; path?: string }

      const args = ['run', '-p', pattern, '--color=never']
      if (lang) args.push('-l', lang)
      args.push(path || '.')

      const result = await pi.exec('sg', args, { cwd: ctx.cwd, signal })
      const failure = execFailure(result, 'Search')
      if (failure) throw new Error(failure)

      const output = result.stdout || result.stderr
      if (!output.trim()) {
        return toolText('No matches found', {})
      }

      const truncation = truncateTail(output, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES
      })
      let text = truncation.content
      if (truncation.truncated) {
        text += `\n\n[Truncated: showing last ${truncation.outputLines} of ${truncation.totalLines} lines]`
      }

      return toolText(text, {})
    },

    renderCall(params, theme) {
      const { pattern, lang, path } = (params ?? {}) as Partial<{
        pattern: string
        lang?: string
        path?: string
      }>
      return renderToolCall(theme, 'ast grep', {
        segments: [
          { text: pattern ? `'${pattern}'` : undefined },
          { text: lang ? `-l ${lang}` : undefined, color: 'dim' },
          { text: path, color: 'muted' }
        ]
      })
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      if (context.isError) return renderError(firstText(result), theme)
      if (isPartial) return renderEmpty()
      const text = firstText(result).trimEnd()
      const matches = text
        .split('\n')
        .map((line) => line.match(/^(.*?):(\d+):(.*)$/))
        .filter((match): match is RegExpMatchArray => Boolean(match))

      if (matches.length > 0) {
        return renderTextLinesPreview(
          matches.map((match) => {
            const [, file, line, source] = match
            return `${theme.fg('muted', `${file}:${line}:`)} ${theme.fg('toolOutput', source.trim())}`
          }),
          theme,
          { expanded, compactLimit: 5, styleLine: (line) => line, hints: context }
        )
      }

      return renderTextLinesPreview(text.split('\n'), theme, {
        expanded,
        compactLimit: 5,
        hints: context
      })
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

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
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
          const preview = await dryRunFileRewrite(pi, path, args, ctx.cwd, signal)
          if (preview.cancelled) throw new Error('Rewrite cancelled')
          if (preview.diff) return toolText(preview.diff, {})
          return toolText('No matches found', {})
        } catch {
          signal?.throwIfAborted()
          // Fall back to ast-grep's own dry-run output for non-file paths or unexpected failures.
        }
      }

      const result = await pi.exec('sg', args, { cwd: ctx.cwd, signal })
      const failure = execFailure(result, 'Rewrite')
      if (failure) throw new Error(failure)

      const output = result.stdout || result.stderr
      if (!output.trim()) {
        return toolText(dryRun ? 'No matches found' : 'No matches found (nothing to rewrite)', {})
      }

      const truncation = truncateTail(output, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES
      })
      let text = truncation.content

      if (truncation.truncated) {
        text += `\n\n[Truncated: showing last ${truncation.outputLines} of ${truncation.totalLines} lines]`
      }

      return toolText(text, {})
    },

    renderCall(params, theme) {
      const { pattern, replacement, lang, path, dryRun } = (params ?? {}) as Partial<{
        pattern: string
        replacement: string
        lang?: string
        path?: string
        dryRun?: boolean
      }>
      return renderToolCall(theme, 'ast edit', {
        segments: [
          { text: pattern ? `'${pattern}'` : undefined },
          { text: replacement ? '→' : undefined, color: 'dim' },
          { text: replacement ? `'${replacement}'` : undefined, color: 'success' },
          { text: lang ? `-l ${lang}` : undefined, color: 'dim' },
          { text: path, color: 'muted' },
          { text: dryRun ? 'dry-run' : undefined, color: 'muted' }
        ]
      })
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      if (context.isError) return renderError(firstText(result), theme)
      if (isPartial) return renderEmpty()
      const text = firstText(result).trimEnd()
      const diffLines = text.split('\n')
      const shown = !expanded && /^[-+]\d+ /m.test(text) ? diffLines.slice(0, 8) : diffLines
      const hidden = diffLines.length - shown.length
      return renderLines([
        ...colorDiff(shown.join('\n'), theme),
        ...(hidden > 0
          ? [theme.fg('muted', `… ${hidden} more lines`), '', expandHint(theme, context)]
          : [])
      ])
    }
  })
}
