/**
 * Context7 Documentation Search
 *
 * Search up-to-date library documentation via Context7 API.
 * Provides two tools: resolve library ID and query documentation.
 *
 * Requires CONTEXT7_API_KEY environment variable.
 */

import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Markdown, Text } from '@earendil-works/pi-tui'
import {
  firstText,
  meta as renderMeta,
  primary,
  renderError,
  renderExpandFooter,
  renderLines,
  renderMuted,
  title,
  nativeMarkdownTheme
} from '../shared/render'
import { Type } from 'typebox'

const DEFAULT_API_BASE = 'https://context7.com/api'

function getApiKey(): string | undefined {
  return process.env.CONTEXT7_API_KEY
}

function getApiBase(): string {
  return process.env.CONTEXT7_ENDPOINT_URL || DEFAULT_API_BASE
}

interface Library {
  id: string
  title: string
  description?: string
  totalSnippets?: number
  trustScore?: number
  benchmarkScore?: number
  stars?: number
}

interface SearchResult {
  libraries: Library[]
  error?: string
}

interface DocsResult {
  docs: string
  error?: string
}

interface DocsDetails {
  libraryId: string
  error?: boolean
  empty?: boolean
}

function compactDocsPreview(markdown: string): { lines: string[]; hidden: number } {
  const lines: string[] = []
  let inFence = false

  for (const rawLine of markdown.split('\n')) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed === '--------------------------------') continue

    if (trimmed.startsWith('```')) {
      inFence = !inFence
      continue
    }

    const cleaned = trimmed.replace(/^###\s+/, '').replace(/^Source:\s+/, 'Source: ')
    lines.push(inFence ? rawLine.replace(/\s+$/u, '') : cleaned)
    if (lines.length >= 8) break
  }

  const totalMeaningful = markdown.split('\n').filter((line) => {
    const trimmed = line.trim()
    return trimmed && trimmed !== '--------------------------------' && !trimmed.startsWith('```')
  }).length

  return { lines, hidden: Math.max(0, totalMeaningful - lines.length) }
}

async function searchLibrary(
  apiKey: string,
  query: string,
  libraryName: string
): Promise<SearchResult> {
  const params = new URLSearchParams({ query, libraryName })
  const response = await fetch(`${getApiBase()}/v2/libs/search?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  })

  if (!response.ok) {
    return { libraries: [], error: `API error: ${response.status}` }
  }

  const data = await response.json()
  // API returns { results: [...] }
  const results = (data as { results?: Library[] }).results || []
  return { libraries: results }
}

async function getContext(apiKey: string, query: string, libraryId: string): Promise<DocsResult> {
  // Remove leading slash if present (API expects "org/repo" not "/org/repo")
  const cleanId = libraryId.startsWith('/') ? libraryId.slice(1) : libraryId
  const params = new URLSearchParams({ query, libraryId: cleanId, type: 'txt' })
  const response = await fetch(`${getApiBase()}/v2/context?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  })

  if (!response.ok) {
    return { docs: '', error: `API error: ${response.status}` }
  }

  const text = await response.text()
  return { docs: text }
}

const RESOLVE_DESCRIPTION = `Find the Context7 library ID for a package/framework.

Call this FIRST before using context7-docs to get the correct library ID.

Examples:
- libraryName: "react", query: "hooks" → finds /reactjs/react.dev
- libraryName: "next.js", query: "routing" → finds /vercel/next.js
- libraryName: "vueuse", query: "useDark" → finds /vueuse/vueuse

Returns matching libraries ranked by relevance. Pick the best match based on:
- Official sources (higher reputation)
- Code snippet coverage
- Benchmark score`

const DOCS_DESCRIPTION = `Get up-to-date documentation for a library from Context7.

You MUST call context7-resolve first to get the libraryId.

Examples:
- libraryId: "/vercel/next.js", query: "app router"
- libraryId: "/vueuse/vueuse", query: "useDark dark mode"
- libraryId: "/tanstack/query", query: "useQuery cache"

Returns relevant documentation snippets with code examples.`

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'context7-resolve',
    label: 'Context7 Resolve',
    description: RESOLVE_DESCRIPTION,
    parameters: Type.Object({
      libraryName: Type.String({
        description: "Library/framework name (e.g., 'react', 'next.js', 'vue')"
      }),
      query: Type.String({ description: "What you're trying to do (helps rank results)" })
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const apiKey = getApiKey()
      if (!apiKey) {
        return {
          content: [{ type: 'text' as const, text: 'Error: CONTEXT7_API_KEY not set' }],
          details: { error: true }
        }
      }

      const result = await searchLibrary(apiKey, params.query, params.libraryName)

      if (result.error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
          details: { error: true }
        }
      }

      if (result.libraries.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: `No libraries found for "${params.libraryName}"` }
          ],
          details: { libraries: [] }
        }
      }

      const lines = result.libraries.slice(0, 5).map((lib) => {
        const parts = [`${lib.id} — ${lib.title}`]
        if (lib.description) parts.push(`  ${lib.description}`)
        const meta: string[] = []
        if (lib.trustScore) meta.push(`trust: ${lib.trustScore}`)
        if (lib.benchmarkScore) meta.push(`benchmark: ${lib.benchmarkScore}`)
        if (lib.totalSnippets) meta.push(`snippets: ${lib.totalSnippets}`)
        if (lib.stars && lib.stars > 0) meta.push(`★${lib.stars}`)
        if (meta.length) parts.push(`  ${meta.join(' | ')}`)
        return parts.join('\n')
      })

      return {
        content: [{ type: 'text' as const, text: lines.join('\n\n') }],
        details: { libraries: result.libraries.slice(0, 5) }
      }
    },

    renderCall(params, theme) {
      const { libraryName, query } = params as { libraryName: string; query: string }
      return new Text(
        theme.fg('toolTitle', theme.bold('docs find ')) +
          theme.fg('accent', libraryName) +
          theme.fg('dim', ` "${query}"`),
        0,
        0
      )
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as { libraries?: Library[]; error?: boolean }
      if (details.error) return renderError(firstText(result, 'Error'), theme)
      const libraries = details.libraries ?? []
      if (libraries.length === 0) return renderMuted('No libraries found', theme)

      const lines: string[] = []
      const maxItems = expanded ? libraries.length : 1
      for (let i = 0; i < maxItems; i++) {
        const lib = libraries[i]
        if (!lib) continue
        if (lines.length > 0) lines.push('')
        lines.push(title(lib.id, theme) + renderMeta(` — ${lib.title}`, theme))
        if (expanded && lib.description) lines.push(primary(lib.description, theme))
      }

      if (!expanded && libraries.length > 1) {
        lines.push(
          renderMeta(`… ${libraries.length - 1} more libraries`, theme),
          ...renderExpandFooter(theme)
        )
      }

      return renderLines(lines)
    }
  })

  pi.registerTool({
    name: 'context7-docs',
    label: 'Context7 Docs',
    description: DOCS_DESCRIPTION,
    parameters: Type.Object({
      libraryId: Type.String({ description: "Context7 library ID (e.g., '/vercel/next.js')" }),
      query: Type.String({ description: 'What you want to learn about' })
    }),

    async execute(_toolCallId, params, _signal, _onUpdate) {
      const apiKey = getApiKey()
      if (!apiKey) {
        return {
          content: [{ type: 'text' as const, text: 'Error: CONTEXT7_API_KEY not set' }],
          details: { libraryId: params.libraryId, error: true } as DocsDetails
        }
      }

      const result = await getContext(apiKey, params.query, params.libraryId)

      if (result.error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
          details: { libraryId: params.libraryId, error: true } as DocsDetails
        }
      }

      if (!result.docs.trim()) {
        return {
          content: [
            { type: 'text' as const, text: `No documentation found for "${params.libraryId}"` }
          ],
          details: { libraryId: params.libraryId, empty: true } as DocsDetails
        }
      }

      return {
        content: [{ type: 'text' as const, text: result.docs }],
        details: { libraryId: params.libraryId } as DocsDetails
      }
    },

    renderCall(params, theme) {
      const { libraryId, query } = params as { libraryId: string; query: string }
      return new Text(
        theme.fg('toolTitle', theme.bold('docs ')) +
          theme.fg('accent', libraryId) +
          theme.fg('dim', ` "${query}"`),
        0,
        0
      )
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as { libraryId?: string; error?: boolean; empty?: boolean }
      if (details.error) return renderError(firstText(result, 'Error'), theme)
      if (details.empty) return renderMuted('No docs found', theme)
      const text = result.content[0]
      const docs = text?.type === 'text' ? text.text : ''
      if (expanded) {
        return new Markdown(docs.trim(), 0, 1, nativeMarkdownTheme(theme), {
          color: (text) => theme.fg('toolOutput', text)
        })
      }

      const preview = compactDocsPreview(docs)
      const lines = preview.lines.map((line) => {
        if (line.startsWith('Source: ')) return renderMeta(line, theme)
        return primary(line, theme)
      })
      if (preview.hidden > 0) {
        lines.push(
          renderMeta(`… ${preview.hidden} more lines`, theme),
          ...renderExpandFooter(theme)
        )
      }
      return renderLines(lines)
    }
  })
}
