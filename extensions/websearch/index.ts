/**
 * Web Search Extension
 *
 * Searches the web using Exa AI API.
 * Requires EXA_API_KEY environment variable.
 */

import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { env } from '../shared/http'
import {
  firstText,
  meta as renderMeta,
  primary,
  renderEntryList,
  renderError,
  renderLines,
  renderMuted,
  renderToolCall,
  title,
  toolError,
  toolLoading,
  toolText,
  truncateText
} from '../shared/render'
import { Type } from 'typebox'
import Exa from 'exa-js'

function getApiKey(): string | undefined {
  return env('EXA_API_KEY')
}

function getBaseUrl(): string | undefined {
  return env('EXA_ENDPOINT_URL')
}

interface SearchResult {
  title: string
  url: string
  author?: string
  publishedDate?: string
  text: string
  highlights?: string[]
  summary?: string
}

interface WebSearchDetails {
  query: string
  results: SearchResult[]
  error?: boolean
}

type WebSearchLoadingDetails = WebSearchDetails & { loading: boolean }

function webSearchDetails(query: string, results: SearchResult[] = []): WebSearchDetails {
  return { query, results }
}

function webSearchErrorDetails(query: string): WebSearchDetails {
  return { query, results: [], error: true }
}

function webSearchLoadingDetails(query: string): WebSearchLoadingDetails {
  return { query, results: [], loading: true }
}

const RESTRICTED_CATEGORIES = new Set([
  'company',
  'people',
  'tweet',
  'news',
  'personal site',
  'financial report'
])

const DESCRIPTION = `Search the web using Exa AI - performs real-time web searches and returns content from relevant websites.

Usage notes:
- Provides up-to-date information beyond knowledge cutoff
- Search types: 'auto' (default, highest quality), 'instant' (sub-150ms), 'fast' (~500ms), 'deep' (~5s, comprehensive with query expansion)
- For deep search, provide additionalQueries with query variations for better results
- Use category to focus on specific content: 'company', 'research paper', 'news', 'tweet', 'people', 'personal site', 'financial report'
- IMPORTANT: categories company/people/tweet/news/personal site/financial report do NOT support these filters: includeText, excludeText, excludeDomains, startPublishedDate, endPublishedDate. For 'people', includeDomains only accepts LinkedIn domains.
- Filter by domains (includeDomains/excludeDomains), text content (includeText/excludeText), and date ranges — only for uncategorized or 'research paper' searches
- Control content freshness with maxAgeHours (0=always fresh, 24=accept 24h cache, omit=default)
- Request highlights (relevant snippets) or summary alongside full text for more efficient context`

const WebSearchParams = Type.Object({
  query: Type.String({ description: 'Web search query' }),
  additionalQueries: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Query variations for deep search. Only works with type='deep'. Provide 2-5 alternative phrasings for comprehensive results."
    })
  ),
  numResults: Type.Optional(
    Type.Number({ description: 'Number of search results to return (default: 8, max: 100)' })
  ),
  type: Type.Optional(
    Type.Union(
      [
        Type.Literal('auto'),
        Type.Literal('instant'),
        Type.Literal('fast'),
        Type.Literal('deep'),
        Type.Literal('neural')
      ],
      {
        description:
          "Search type - 'auto': highest quality (default), 'instant': sub-150ms, 'fast': ~500ms, 'deep': ~5s comprehensive, 'neural': embeddings-based"
      }
    )
  ),
  category: Type.Optional(
    Type.Union(
      [
        Type.Literal('company'),
        Type.Literal('research paper'),
        Type.Literal('news'),
        Type.Literal('tweet'),
        Type.Literal('people'),
        Type.Literal('personal site'),
        Type.Literal('financial report')
      ],
      {
        description: 'Focus on a specific content category for higher quality results'
      }
    )
  ),
  includeDomains: Type.Optional(
    Type.Array(Type.String(), {
      description: "Only return results from these domains (e.g. ['arxiv.org', 'github.com'])"
    })
  ),
  excludeDomains: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Exclude results from these domains'
    })
  ),
  includeText: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Strings that must appear in result text (1 string, up to 5 words)'
    })
  ),
  excludeText: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Strings that must not appear in result text (1 string, up to 5 words)'
    })
  ),
  startPublishedDate: Type.Optional(
    Type.String({
      description:
        "Only results published after this date (ISO 8601, e.g. '2025-01-01T00:00:00.000Z')"
    })
  ),
  endPublishedDate: Type.Optional(
    Type.String({ description: 'Only results published before this date (ISO 8601)' })
  ),
  maxAgeHours: Type.Optional(
    Type.Number({
      description:
        'Max age of cached content in hours. 0=always livecrawl, 24=accept 24h cache, -1=cache only, omit=default'
    })
  ),
  highlights: Type.Optional(
    Type.Boolean({
      description:
        'Return relevant text snippets from each page (default: false). Useful for quick context without full text.'
    })
  ),
  summary: Type.Optional(
    Type.Boolean({
      description: 'Return LLM-generated summary of each page (default: false)'
    })
  ),
  contextMaxCharacters: Type.Optional(
    Type.Number({ description: 'Maximum characters for full text per result (default: 10000)' })
  ),
  userLocation: Type.Optional(
    Type.String({
      description: "Two-letter ISO country code to bias results geographically (e.g. 'US')"
    })
  )
})

const PREVIEW_TEXT_LENGTH = 220
const PREVIEW_RESULTS = 2
const DEFAULT_NUM_RESULTS = 8
const DEFAULT_CONTEXT_MAX = 10000

function formatResultsAsText(results: SearchResult[]): string {
  return results
    .map((r) => {
      let header = `Title: ${r.title}\nURL: ${r.url}`
      if (r.author) header += `\nAuthor: ${r.author}`
      if (r.publishedDate) header += `\nDate: ${r.publishedDate}`

      let body = ''
      if (r.summary) body += `\nSummary: ${r.summary}`
      if (r.highlights?.length)
        body += `\nHighlights:\n${r.highlights.map((h) => `- ${h}`).join('\n')}`
      if (r.text) body += `\n\n${r.text}`

      return `${header}${body}`
    })
    .join('\n\n---\n\n')
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'websearch',
    label: 'Web Search',
    description: DESCRIPTION,
    parameters: WebSearchParams,

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const apiKey = getApiKey()
      if (!apiKey) {
        return toolError('EXA_API_KEY not set', webSearchErrorDetails(params.query))
      }

      const {
        query,
        additionalQueries,
        numResults = DEFAULT_NUM_RESULTS,
        type = 'auto',
        category,
        includeDomains,
        excludeDomains,
        includeText,
        excludeText,
        startPublishedDate,
        endPublishedDate,
        maxAgeHours,
        highlights: wantHighlights,
        summary: wantSummary,
        contextMaxCharacters = DEFAULT_CONTEXT_MAX,
        userLocation
      } = params

      onUpdate?.(toolLoading(webSearchLoadingDetails(query)))

      try {
        const baseUrl = getBaseUrl()
        const exa = baseUrl ? new Exa(apiKey, baseUrl) : new Exa(apiKey)

        // Build contents options
        const contentsOptions: Record<string, unknown> = {
          text: { maxCharacters: contextMaxCharacters }
        }
        if (wantHighlights) contentsOptions.highlights = { maxCharacters: 2000 }
        if (wantSummary) contentsOptions.summary = true
        if (maxAgeHours !== undefined) contentsOptions.maxAgeHours = maxAgeHours

        // Build search options
        const searchOptions: Record<string, unknown> = {
          numResults,
          type,
          ...contentsOptions
        }

        if (additionalQueries?.length) searchOptions.additionalQueries = additionalQueries
        if (category) searchOptions.category = category
        if (userLocation) searchOptions.userLocation = userLocation

        const restricted = category ? RESTRICTED_CATEGORIES.has(category) : false
        if (!restricted) {
          if (includeDomains?.length) searchOptions.includeDomains = includeDomains
          if (excludeDomains?.length) searchOptions.excludeDomains = excludeDomains
          if (includeText?.length) searchOptions.includeText = includeText
          if (excludeText?.length) searchOptions.excludeText = excludeText
          if (startPublishedDate) searchOptions.startPublishedDate = startPublishedDate
          if (endPublishedDate) searchOptions.endPublishedDate = endPublishedDate
        } else {
          if (includeDomains?.length) searchOptions.includeDomains = includeDomains
        }

        const response = await exa.searchAndContents(query, searchOptions)

        if (signal?.aborted) {
          return toolText('Search cancelled', webSearchDetails(query))
        }

        const results: SearchResult[] = response.results.map((r: Record<string, unknown>) => ({
          title: (r.title as string) || 'Untitled',
          url: r.url as string,
          author: (r.author as string) || undefined,
          publishedDate: (r.publishedDate as string) || undefined,
          text: (r.text as string) || '',
          highlights: (r.highlights as string[]) || undefined,
          summary: (r.summary as string) || undefined
        }))

        if (results.length === 0) {
          return toolText(
            'No search results found. Try a different query.',
            webSearchDetails(query)
          )
        }

        return toolText(formatResultsAsText(results), webSearchDetails(query, results))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return toolError(message, webSearchErrorDetails(query))
      }
    },

    renderCall(params, theme) {
      const args = params ?? {}
      return renderToolCall(theme, 'web', {
        segments: [{ text: args.query }],
        tags: [args.type && args.type !== 'auto' ? args.type : undefined, args.category],
        suffix: args.numResults ? `${args.numResults} results` : undefined
      })
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as WebSearchDetails | undefined

      if (details?.error) return renderError(firstText(result, 'Error'), theme)

      const results = details?.results ?? []

      if (results.length === 0) {
        if (isPartial) return renderLines([])
        return renderMuted('No results found.', theme)
      }

      let textHidden = false

      return renderEntryList(results, theme, {
        expanded,
        compactLimit: 1,
        renderEntry: (r) => {
          let metadata = renderMeta(theme.underline(r.url), theme)
          if (r.author) metadata += renderMeta(` · ${r.author}`, theme)
          if (r.publishedDate) metadata += renderMeta(` · ${r.publishedDate.split('T')[0]}`, theme)

          const body: string[] = []
          const previewText = r.summary || r.highlights?.[0]
          if (expanded) {
            if (r.summary) body.push(renderMeta('Summary: ', theme) + primary(r.summary, theme))
            if (r.text) body.push(primary(r.text, theme))
          } else if (previewText) {
            textHidden = previewText.length > PREVIEW_TEXT_LENGTH || Boolean(r.text)
            body.push(primary(truncateText(previewText, PREVIEW_TEXT_LENGTH), theme))
          } else if (r.text) {
            textHidden = true
          }

          return { header: title(r.title, theme), metadata, body }
        },
        hiddenLines: (hiddenResults) => {
          if (hiddenResults > 0) return [renderMeta(`… ${hiddenResults} more results`, theme)]
          return textHidden ? [renderMeta('… more text', theme)] : []
        }
      })
    }
  })
}
