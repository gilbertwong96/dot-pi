/**
 * Code Search Tool Extension
 *
 * Searches public code on GitHub using grep.app MCP API.
 * Returns formatted code snippets with repository info.
 */

import { type AgentToolResult, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { fetchGitHubFile, type GitHubFileTargetParams } from './shared/github'
import { errorMessage } from './shared/errors'
import { apiErrorMessage, fetchText } from './shared/http'
import { parseSseJson } from './shared/sse'
import { toolParameters } from './shared/tool-schema'
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHeadText,
  type TruncationResult
} from './shared/truncate'
import {
  firstText,
  meta as renderMeta,
  primary,
  renderEmpty,
  renderExpandFooter,
  renderEntryList,
  renderError,
  renderLines,
  renderMuted,
  renderToolCall,
  title,
  toolError,
  toolLoading,
  toolText
} from './shared/render'
import { Type } from 'typebox'

const API_URL = 'https://mcp.grep.app/'
const DEFAULT_TIMEOUT = 30000
const PREVIEW_REPOS = 2
const CODEFETCH_PREVIEW_LINES = 40

interface McpResponse {
  result?: {
    content: Array<{ type: string; text: string }>
  }
  error?: {
    code: number
    message: string
  }
}

interface CodeSnippet {
  lineNumber: number
  code: string
}

interface SearchResult {
  repo: string
  path: string
  url: string
  license: string
  snippets: CodeSnippet[]
}

interface CodeFetchParams extends GitHubFileTargetParams {
  startLine?: number
  endLine?: number
}

interface CodeFetchDetails {
  repo: string
  path: string
  ref?: string
  startLine?: number
  endLine?: number
  lineCount: number
  totalLines: number
  truncation?: TruncationResult
  truncationNotice?: string
  error?: boolean
}

interface CodeSearchDetails {
  query: string
  results: SearchResult[]
  error?: boolean
}

type CodeSearchLoadingDetails = CodeSearchDetails & { loading: boolean }

function codeSearchDetails(query: string, results: SearchResult[] = []): CodeSearchDetails {
  return { query, results }
}

function codeSearchErrorDetails(query: string): CodeSearchDetails {
  return { query, results: [], error: true }
}

function codeSearchLoadingDetails(query: string): CodeSearchLoadingDetails {
  return { query, results: [], loading: true }
}

interface CodeSearchParams {
  query: string
  regex?: boolean
  caseSensitive?: boolean
  wholeWords?: boolean
  repo?: string
  path?: string
  lang?: string[]
}

const CODEFETCH_DESCRIPTION = `Fetch full file contents from GitHub after finding a result with codesearch.

Use this when a codesearch snippet is too small and you need surrounding context or the full file.
Pass either:
- url: a GitHub blob URL from codesearch output
- repo and path: e.g. repo:'facebook/react', path:'packages/react/index.js'

Optionally pass ref, startLine, and endLine to fetch a specific branch/tag/SHA or line range.
Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} by default; use startLine/endLine to fetch focused ranges.
Prefers the GitHub CLI (gh). Falls back to GitHub's public contents API for public files when gh is unavailable or fails.`

const DESCRIPTION = `Find real-world code examples from over a million public GitHub repositories.

**IMPORTANT: This tool searches for literal code patterns (like grep), not keywords.**
- ✅ Good: 'useState(', 'import React from', 'async function'
- ❌ Bad: 'react tutorial', 'best practices', 'how to use'

**When to use this tool:**
- When implementing unfamiliar APIs or libraries and need real usage patterns
- When unsure about correct syntax, parameters, or configuration
- When looking for production-ready examples and best practices
- When needing to understand how different libraries work together

**Perfect for questions like:**
- "How do developers handle auth in Next.js?" → query:'getServerSession' lang:['TypeScript', 'TSX']
- "What are common React error boundary patterns?" → query:'ErrorBoundary' lang:['TSX']
- "Show me useEffect cleanup examples" → query:'(?s)useEffect\\(\\(\\) => {.*removeEventListener' regex:true
- "How to handle CORS in Flask?" → query:'CORS(' caseSensitive:true lang:['Python']

Use regex:true for flexible patterns. Prefix with '(?s)' to match across multiple lines.
Filter by lang (array), repo (string), or path (string) to narrow results.`

const CodeFetchParamsSchema = Type.Object({
  repo: Type.Optional(Type.String({ description: "Repository name, e.g. 'facebook/react'" })),
  path: Type.Optional(Type.String({ description: "File path, e.g. 'src/index.ts'" })),
  ref: Type.Optional(
    Type.String({ description: "Branch, tag, or commit SHA. Defaults to GitHub's default branch" })
  ),
  url: Type.Optional(
    Type.String({ description: 'GitHub blob URL from codesearch output. Overrides repo/path/ref.' })
  ),
  startLine: Type.Optional(Type.Number({ description: '1-based first line to return' })),
  endLine: Type.Optional(Type.Number({ description: '1-based last line to return' }))
})

const CodeSearchParamsSchema = Type.Object({
  query: Type.String({
    description: "Code pattern to search for (e.g., 'useState(', 'export function')"
  }),
  regex: Type.Optional(
    Type.Boolean({
      description: 'Treat query as regular expression. Prefix with (?s) to match across lines'
    })
  ),
  caseSensitive: Type.Optional(Type.Boolean({ description: 'Case-sensitive search' })),
  wholeWords: Type.Optional(Type.Boolean({ description: 'Match whole words only' })),
  repo: Type.Optional(
    Type.String({ description: "Filter by repository (e.g., 'facebook/react', 'vercel/')" })
  ),
  path: Type.Optional(
    Type.String({ description: "Filter by file path (e.g., 'src/components/', '/route.ts')" })
  ),
  lang: Type.Optional(
    Type.Array(Type.String(), { description: "Filter by languages (e.g., ['TypeScript', 'TSX'])" })
  )
})

const FIELD_PATTERN = /^(Repository|Path|URL|License):\s*(.*)$/
const SNIPPET_HEADER = /^--- Snippet \d+ \(Line (\d+)\) ---$/

export function sliceLines(
  text: string,
  startLine?: number,
  endLine?: number
): { text: string; startLine: number; endLine: number; totalLines: number } {
  const lines = text.split('\n')
  const totalLines = lines.length
  const start = Math.max(1, Math.floor(startLine ?? 1))

  if (start > totalLines) {
    return { text: '', startLine: start, endLine: start - 1, totalLines }
  }

  const end = Math.min(totalLines, Math.floor(endLine ?? totalLines))
  const normalizedEnd = Math.max(start, end)

  return {
    text: lines.slice(start - 1, normalizedEnd).join('\n'),
    startLine: start,
    endLine: normalizedEnd,
    totalLines
  }
}

export function parseResults(rawText: string): SearchResult[] {
  const results: SearchResult[] = []

  let record: Partial<SearchResult> & { snippets: CodeSnippet[] } = { snippets: [] }
  let snippet: number | null = null
  let snippetLines: string[] = []

  const flushSnippet = () => {
    if (snippet !== null) {
      record.snippets.push({
        lineNumber: snippet,
        code: snippetLines.join('\n').trim()
      })
      snippet = null
      snippetLines = []
    }
  }

  const emit = () => {
    flushSnippet()
    if (record.repo && record.path) {
      results.push({
        repo: record.repo,
        path: record.path,
        url: record.url || '',
        license: record.license || 'Unknown',
        snippets: record.snippets
      })
    }
    record = { snippets: [] }
  }

  for (const line of rawText.split('\n')) {
    const snippetMatch = line.match(SNIPPET_HEADER)
    if (snippetMatch) {
      flushSnippet()
      snippet = parseInt(snippetMatch[1]!, 10)
      continue
    }

    const fieldMatch = line.match(FIELD_PATTERN)
    if (fieldMatch) {
      const [, name, value] = fieldMatch

      if (name === 'Repository') {
        emit()
      } else {
        flushSnippet()
      }

      if (name === 'Repository') record.repo = value!.trim()
      else if (name === 'Path') record.path = value!.trim()
      else if (name === 'URL') record.url = value!.trim()
      else if (name === 'License') record.license = value!.trim()
      continue
    }

    if (snippet !== null) {
      snippetLines.push(line)
    }
  }

  emit()
  return results
}

/**
 * Format results as plain text for LLM consumption
 */
function formatResultsAsText(results: SearchResult[]): string {
  return results
    .map((r) => {
      const snippetsText = r.snippets.map((s) => `Line ${s.lineNumber}:\n${s.code}`).join('\n\n')
      return `Repository: ${r.repo}\nPath: ${r.path}\nURL: ${r.url}\nLicense: ${r.license}\n\n${snippetsText}`
    })
    .join('\n\n---\n\n')
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'codesearch',
    label: 'Code Search',
    description: DESCRIPTION,
    parameters: toolParameters(CodeSearchParamsSchema),

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const { query, regex, caseSensitive, wholeWords, repo, path, lang } =
        params as CodeSearchParams

      onUpdate?.(toolLoading(codeSearchLoadingDetails(query)))

      const mcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'searchGitHub',
          arguments: {
            query,
            useRegexp: regex ?? false,
            matchCase: caseSensitive ?? false,
            matchWholeWords: wholeWords ?? false,
            ...(repo && { repo }),
            ...(path && { path }),
            ...(lang && { language: lang })
          }
        }
      }

      try {
        const response = await fetchText(
          API_URL,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream'
            },
            body: JSON.stringify(mcpRequest)
          },
          { signal, timeoutMs: DEFAULT_TIMEOUT }
        )

        if (!response.ok) {
          return toolError(
            apiErrorMessage(response.status, response.text),
            codeSearchErrorDetails(query)
          )
        }

        const data = parseSseJson<McpResponse>(response.text)

        if (!data) {
          return toolError('No data in response', codeSearchErrorDetails(query))
        }

        if (data.error) {
          return toolError(data.error.message, codeSearchErrorDetails(query))
        }

        if (!data.result?.content?.length) {
          return toolText('No results found.', codeSearchDetails(query))
        }

        // Combine all text content and parse
        const rawOutput = data.result.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n\n')

        const results = parseResults(rawOutput)

        return toolText(formatResultsAsText(results), codeSearchDetails(query, results))
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          return toolError('Search request timed out', codeSearchErrorDetails(query))
        }

        return toolError(errorMessage(err), codeSearchErrorDetails(query))
      }
    },

    renderCall(params, theme) {
      const args = (params ?? {}) as Partial<CodeSearchParams>
      return renderToolCall(theme, 'code search', {
        segments: [{ text: args.query }],
        tags: [
          args.repo ? `repo:${args.repo}` : undefined,
          args.path ? `path:${args.path}` : undefined,
          args.lang?.length ? `lang:${args.lang.join(',')}` : undefined,
          args.regex ? 'regex' : undefined,
          args.caseSensitive ? 'case' : undefined
        ]
      })
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as CodeSearchDetails | undefined

      if (details?.error) return renderError(firstText(result, 'Error'), theme)

      const results = details?.results ?? []

      if (results.length === 0) {
        if (isPartial) return renderEmpty()
        return renderMuted('No results found.', theme)
      }

      const totalSnippets = results.reduce((sum, r) => sum + r.snippets.length, 0)
      return renderEntryList(results, theme, {
        expanded,
        compactLimit: PREVIEW_REPOS,
        renderEntry: (r) => {
          const firstSnippet = r.snippets[0]
          const location = firstSnippet ? `${r.path}:${firstSnippet.lineNumber}` : r.path

          const header =
            theme.fg('accent', r.repo) +
            theme.fg('dim', ' · ') +
            theme.fg('muted', expanded ? r.path : location) +
            (r.license !== 'Unknown' ? theme.fg('dim', ` [${r.license}]`) : '')

          const body: string[] = []
          const maxSnippets = expanded ? r.snippets.length : 0
          for (let j = 0; j < Math.min(maxSnippets, r.snippets.length); j++) {
            const snippet = r.snippets[j]
            if (!snippet) continue
            if (j > 0) body.push('')

            const codeLines = snippet.code.split('\n')
            const lineNumberWidth = String(snippet.lineNumber + codeLines.length - 1).length
            body.push(
              ...codeLines.map((line, offset) => {
                const lineNumber = String(snippet.lineNumber + offset).padStart(
                  lineNumberWidth,
                  ' '
                )
                return theme.fg('muted', `${lineNumber} `) + primary(line, theme)
              })
            )
          }

          return { header, body }
        },
        hiddenLines: (hiddenResults) => {
          const hiddenSnippets = totalSnippets
          if (hiddenResults <= 0 && hiddenSnippets <= 0) return []
          const pieces = []
          if (hiddenResults > 0) pieces.push(`${hiddenResults} more repos`)
          if (hiddenSnippets > 0) pieces.push(`${hiddenSnippets} more snippets`)
          return [theme.fg('dim', `… ${pieces.join(' · ')}`)]
        }
      })
    }
  })

  pi.registerTool({
    name: 'codefetch',
    label: 'Code Fetch',
    description: CODEFETCH_DESCRIPTION,
    parameters: toolParameters(CodeFetchParamsSchema),

    async execute(_toolCallId, params): Promise<AgentToolResult<CodeFetchDetails>> {
      const args = params as CodeFetchParams
      const fetched = await fetchGitHubFile(args)

      if (!fetched.ok) {
        return toolError(fetched.message, {
          repo: fetched.repo ?? args.repo ?? '',
          path: fetched.path ?? args.path ?? '',
          ref: fetched.ref ?? args.ref,
          lineCount: 0,
          totalLines: 0,
          error: true
        } satisfies CodeFetchDetails)
      }

      const sliced = sliceLines(fetched.text, args.startLine, args.endLine)
      const requestedLineCount = Math.max(0, sliced.endLine - sliced.startLine + 1)
      const truncated = truncateHeadText(sliced.text, {
        notice: (truncation) => {
          if (truncation.firstLineExceedsLimit) {
            return `[Line ${sliced.startLine} exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use a narrower startLine/endLine range.]`
          }

          const endLine = sliced.startLine + truncation.outputLines - 1
          const nextLine = endLine + 1
          const limit =
            truncation.truncatedBy === 'lines'
              ? `${DEFAULT_MAX_LINES} line limit`
              : `${formatSize(DEFAULT_MAX_BYTES)} limit`
          return `[Showing lines ${sliced.startLine}-${endLine} of requested ${sliced.startLine}-${sliced.endLine} (${limit}). Use startLine=${nextLine} to continue.]`
        }
      })

      return toolText(truncated.text, {
        repo: fetched.repo,
        path: fetched.path,
        ref: fetched.ref,
        startLine: sliced.startLine,
        endLine: sliced.endLine,
        lineCount: requestedLineCount,
        totalLines: sliced.totalLines,
        truncation: truncated.truncation,
        truncationNotice: truncated.notice
      } satisfies CodeFetchDetails)
    },

    renderCall(params, theme) {
      const args = (params ?? {}) as Partial<CodeFetchParams>
      const target = args.url ?? [args.repo, args.path].filter(Boolean).join(' · ')
      const range =
        args.startLine || args.endLine ? `${args.startLine ?? 1}-${args.endLine ?? ''}` : undefined
      return renderToolCall(theme, 'code fetch', {
        segments: [{ text: target }],
        tags: [args.ref ? `ref:${args.ref}` : undefined, range ? `lines:${range}` : undefined]
      })
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as CodeFetchDetails | undefined
      if (details?.error) return renderError(firstText(result, 'Error'), theme)

      const text = firstText(result)
      const codeText =
        details?.truncationNotice && text.endsWith(`\n\n${details.truncationNotice}`)
          ? text.slice(0, -`\n\n${details.truncationNotice}`.length)
          : text
      const startLine = details?.startLine ?? 1
      const codeLines = codeText.split('\n')
      const visibleLines = expanded ? codeLines : codeLines.slice(0, CODEFETCH_PREVIEW_LINES)
      const lineNumberWidth = String(startLine + visibleLines.length - 1).length
      const renderedCode = visibleLines.map((line, offset) => {
        const lineNumber = String(startLine + offset).padStart(lineNumberWidth, ' ')
        return theme.fg('muted', `${lineNumber} `) + primary(line, theme)
      })

      const header = details
        ? title(details.repo, theme) + renderMeta(` · ${details.path}`, theme)
        : title('Fetched code', theme)
      const metaParts: string[] = []
      if (details?.ref) metaParts.push(`ref:${details.ref}`)
      if (details?.startLine && details?.endLine) {
        metaParts.push(`lines:${details.startLine}-${details.endLine}`)
      }
      if (details) {
        const shownLines = details.truncation?.outputLines ?? details.lineCount
        metaParts.push(
          `${shownLines}/${details.lineCount} requested lines · ${details.totalLines} total`
        )
      }

      const lines = [
        header,
        ...(metaParts.length ? [renderMeta(metaParts.join(' · '), theme)] : []),
        '',
        ...renderedCode
      ]
      const hidden = codeLines.length - visibleLines.length
      if (!expanded && hidden > 0) {
        lines.push('', renderMeta(`… ${hidden} more lines`, theme), ...renderExpandFooter(theme))
      }

      if (expanded && details?.truncationNotice) {
        lines.push('', renderMeta(details.truncationNotice, theme))
      }

      return renderLines(lines)
    }
  })
}
