/**
 * Context7 Documentation Search
 *
 * Search up-to-date library documentation via Context7 API.
 * Provides two tools: resolve library ID and query documentation.
 *
 * Requires CONTEXT7_API_KEY environment variable.
 */

import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Markdown } from '@earendil-works/pi-tui'
import { env, fetchJson, fetchText } from '../shared/http'
import {
  firstText,
  meta as renderMeta,
  primary,
  renderEntryList,
  renderError,
  renderExpandFooter,
  renderLines,
  renderMuted,
  renderToolCall,
  title,
  toolError,
  toolText,
  nativeMarkdownTheme
} from '../shared/render'
import { Type } from 'typebox'

const DEFAULT_API_BASE = 'https://context7.com/api'

function getApiKey(): string | undefined {
  return env('CONTEXT7_API_KEY')
}

function getApiBase(): string {
  return env('CONTEXT7_ENDPOINT_URL') || DEFAULT_API_BASE
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

interface ResolveDetails {
  libraries?: Library[]
  error?: boolean
}

interface DocsDetails {
  libraryId: string
  error?: boolean
  empty?: boolean
}

function docsErrorDetails(libraryId: string): DocsDetails {
  return { libraryId, error: true }
}

function docsEmptyDetails(libraryId: string): DocsDetails {
  return { libraryId, empty: true }
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
  const response = await fetchJson<{ results?: Library[] }>(
    `${getApiBase()}/v2/libs/search?${params}`,
    {
      headers: { Authorization: `Bearer ${apiKey}` }
    }
  )

  if (!response.ok) {
    return { libraries: [], error: `API error: ${response.status}` }
  }

  const results = response.data?.results || []
  return { libraries: results }
}

async function getContext(apiKey: string, query: string, libraryId: string): Promise<DocsResult> {
  // Remove leading slash if present (API expects "org/repo" not "/org/repo")
  const cleanId = libraryId.startsWith('/') ? libraryId.slice(1) : libraryId
  const params = new URLSearchParams({ query, libraryId: cleanId, type: 'txt' })
  const response = await fetchText(`${getApiBase()}/v2/context?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  })

  if (!response.ok) {
    return { docs: '', error: `API error: ${response.status}` }
  }

  return { docs: response.text }
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
        return toolError('CONTEXT7_API_KEY not set', { error: true } satisfies ResolveDetails)
      }

      const result = await searchLibrary(apiKey, params.query, params.libraryName)

      if (result.error) {
        return toolError(result.error, { error: true } satisfies ResolveDetails)
      }

      if (result.libraries.length === 0) {
        return toolText(`No libraries found for "${params.libraryName}"`, {
          libraries: []
        } satisfies ResolveDetails)
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

      return toolText(lines.join('\n\n'), {
        libraries: result.libraries.slice(0, 5)
      } satisfies ResolveDetails)
    },

    renderCall(params, theme) {
      const { libraryName, query } = (params ?? {}) as Partial<{
        libraryName: string
        query: string
      }>
      return renderToolCall(theme, 'docs find', {
        segments: [{ text: libraryName }, { text: query ? `"${query}"` : undefined, color: 'dim' }]
      })
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as { libraries?: Library[]; error?: boolean }
      if (details.error) return renderError(firstText(result, 'Error'), theme)
      const libraries = details.libraries ?? []
      if (libraries.length === 0) return renderMuted('No libraries found', theme)

      return renderEntryList(libraries, theme, {
        expanded,
        compactLimit: 1,
        renderEntry: (lib) => ({
          header: title(lib.id, theme) + renderMeta(` — ${lib.title}`, theme),
          body: expanded && lib.description ? [primary(lib.description, theme)] : undefined
        }),
        hiddenLines: (hiddenLibraries) =>
          hiddenLibraries > 0 ? [renderMeta(`… ${hiddenLibraries} more libraries`, theme)] : []
      })
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
        return toolError('CONTEXT7_API_KEY not set', docsErrorDetails(params.libraryId))
      }

      const result = await getContext(apiKey, params.query, params.libraryId)

      if (result.error) {
        return toolError(result.error, docsErrorDetails(params.libraryId))
      }

      if (!result.docs.trim()) {
        return toolText(
          `No documentation found for "${params.libraryId}"`,
          docsEmptyDetails(params.libraryId)
        )
      }

      return toolText(result.docs, { libraryId: params.libraryId })
    },

    renderCall(params, theme) {
      const { libraryId, query } = (params ?? {}) as Partial<{
        libraryId: string
        query: string
      }>
      return renderToolCall(theme, 'docs', {
        segments: [{ text: libraryId }, { text: query ? `"${query}"` : undefined, color: 'dim' }]
      })
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
