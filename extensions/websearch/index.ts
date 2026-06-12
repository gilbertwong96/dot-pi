/**
 * Web Search Extension
 *
 * Searches the web using Exa AI API.
 * Requires EXA_API_KEY environment variable.
 */

import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { apiErrorMessage, env, fetchText, requireEnv } from '../shared/http'
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHeadText,
  type TruncationResult
} from '../shared/truncate'
import {
  firstText,
  meta as renderMeta,
  primary,
  renderEmpty,
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

function getBaseUrl(): string {
  return env('EXA_ENDPOINT_URL') || 'https://api.exa.ai'
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
  output?: string
  truncation?: TruncationResult
  error?: boolean
}

interface ExaSearchResponse {
  results?: Array<Record<string, unknown>>
  output?: { content?: unknown }
}

type WebSearchLoadingDetails = WebSearchDetails & { loading: boolean }

function webSearchDetails(
  query: string,
  results: SearchResult[] = [],
  output?: string
): WebSearchDetails {
  return { query, results, output }
}

function webSearchErrorDetails(query: string): WebSearchDetails {
  return { query, results: [], error: true }
}

function webSearchLoadingDetails(query: string): WebSearchLoadingDetails {
  return { query, results: [], loading: true }
}

const DATE_UNSUPPORTED_CATEGORIES = new Set(['company', 'people'])
const EXCLUDE_DOMAINS_UNSUPPORTED_CATEGORIES = new Set(['company', 'people'])

const DESCRIPTION = `Search the web using Exa AI - performs real-time web searches and returns content from relevant websites.

Usage notes:
- Provides up-to-date information beyond knowledge cutoff
- Search types: 'auto' (default), 'instant' (lowest latency), 'fast' (low latency), 'deep-lite', 'deep', 'deep-reasoning'
- For deep search variants, provide additionalQueries with query variations for better results
- Use category to focus on specific content: 'company', 'research paper', 'news', 'people', 'personal site', 'financial report'
- IMPORTANT: company/people do not support date filters or excludeDomains; people includeDomains only accepts LinkedIn domains
- Filter by domains (includeDomains/excludeDomains), text content (includeText/excludeText), and date ranges where supported
- Control content freshness with maxAgeHours (0=always fresh, 24=accept 24h cache, -1=cache only, omit=default)
- Prefer highlights for agent workflows; use full text only when needed and cap contextMaxCharacters
- Tool output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}
- Use systemPrompt and outputSchema only when you need synthesized/structured output; they can increase latency and cost`

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
        Type.Literal('deep-lite'),
        Type.Literal('deep'),
        Type.Literal('deep-reasoning')
      ],
      {
        description:
          "Search type - 'auto' default, 'instant' lowest latency, 'fast' low latency, 'deep-lite' lightweight synthesis, 'deep' multi-step search, 'deep-reasoning' maximum reasoning"
      }
    )
  ),
  category: Type.Optional(
    Type.Union(
      [
        Type.Literal('company'),
        Type.Literal('research paper'),
        Type.Literal('news'),
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
    Type.Union([
      Type.Boolean({
        description:
          'Return relevant text snippets from each page. Prefer true for agent workflows.'
      }),
      Type.Object({
        query: Type.Optional(
          Type.String({ description: 'Custom query guiding highlight selection' })
        ),
        maxCharacters: Type.Optional(
          Type.Number({ description: 'Cap total highlight characters per result' })
        )
      })
    ])
  ),
  summary: Type.Optional(
    Type.Union([
      Type.Boolean({ description: 'Return LLM-generated summary for each page' }),
      Type.Object({
        query: Type.Optional(Type.String({ description: 'Custom query for summary generation' })),
        schema: Type.Optional(
          Type.Any({ description: 'JSON schema for structured summary output' })
        )
      })
    ])
  ),
  contextMaxCharacters: Type.Optional(
    Type.Number({ description: 'Maximum full-text characters per result (default: 10000)' })
  ),
  includeHtmlTags: Type.Optional(
    Type.Boolean({ description: 'Preserve HTML tags in returned full text (default: false)' })
  ),
  textVerbosity: Type.Optional(
    Type.Union([Type.Literal('compact'), Type.Literal('standard'), Type.Literal('full')], {
      description: 'Full-text verbosity. Use maxAgeHours: 0 for fresh section-aware content.'
    })
  ),
  includeSections: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Only include page sections such as header, body, footer, metadata'
    })
  ),
  excludeSections: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Exclude page sections such as navigation, sidebar, footer'
    })
  ),
  livecrawlTimeout: Type.Optional(
    Type.Number({
      description: 'Timeout for livecrawling in milliseconds (recommended 10000-15000)'
    })
  ),
  moderation: Type.Optional(Type.Boolean({ description: 'Filter unsafe content from results' })),
  systemPrompt: Type.Optional(
    Type.String({ description: 'Instructions guiding synthesized output and deep-search planning' })
  ),
  outputSchema: Type.Optional(
    Type.Any({ description: 'JSON schema for synthesized output.content; increases latency/cost' })
  ),
  userLocation: Type.Optional(
    Type.String({
      description: "Two-letter ISO country code to bias results geographically (e.g. 'US')"
    })
  )
})

const PREVIEW_TEXT_LENGTH = 220
const DEFAULT_NUM_RESULTS = 8
const DEFAULT_CONTEXT_MAX = 10000

function formatSynthesis(output: unknown): string | undefined {
  if (typeof output === 'string') return output
  if (output === undefined || output === null) return undefined
  return JSON.stringify(output, null, 2)
}

function formatResultsAsText(results: SearchResult[], output?: string): string {
  const resultText = results
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

  return output ? `Synthesized output:\n${output}\n\n---\n\n${resultText}` : resultText
}

function cleanObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}

export function buildExaSearchRequest(params: Record<string, unknown>): Record<string, unknown> {
  const contents = cleanObject({
    text: cleanObject({
      maxCharacters: params.contextMaxCharacters ?? DEFAULT_CONTEXT_MAX,
      includeHtmlTags: params.includeHtmlTags,
      verbosity: params.textVerbosity,
      includeSections: params.includeSections,
      excludeSections: params.excludeSections
    }),
    highlights:
      params.highlights === true ? true : params.highlights ? params.highlights : undefined,
    summary: params.summary,
    maxAgeHours: params.maxAgeHours,
    livecrawlTimeout: params.livecrawlTimeout
  })

  const category = params.category as string | undefined
  const request = cleanObject({
    query: params.query,
    numResults: params.numResults ?? DEFAULT_NUM_RESULTS,
    type: params.type ?? 'auto',
    category,
    userLocation: params.userLocation,
    includeDomains: params.includeDomains,
    includeText: params.includeText,
    excludeText: params.excludeText,
    moderation: params.moderation,
    additionalQueries: params.additionalQueries,
    systemPrompt: params.systemPrompt,
    outputSchema: params.outputSchema,
    contents
  })

  if (!category || !EXCLUDE_DOMAINS_UNSUPPORTED_CATEGORIES.has(category)) {
    request.excludeDomains = params.excludeDomains
  }
  if (!category || !DATE_UNSUPPORTED_CATEGORIES.has(category)) {
    request.startPublishedDate = params.startPublishedDate
    request.endPublishedDate = params.endPublishedDate
  }

  return cleanObject(request)
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'websearch',
    label: 'Web Search',
    description: DESCRIPTION,
    parameters: WebSearchParams,

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const apiKey = requireEnv('EXA_API_KEY')
      if (!apiKey.ok) {
        return toolError(apiKey.message, webSearchErrorDetails(params.query))
      }

      const { query } = params

      onUpdate?.(toolLoading(webSearchLoadingDetails(query)))

      try {
        const response = await fetchText(
          `${getBaseUrl()}/search`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey.value
            },
            body: JSON.stringify(buildExaSearchRequest(params))
          },
          { signal, timeoutMs: 60_000 }
        )

        if (!response.ok) {
          return toolError(
            apiErrorMessage(response.status, response.text),
            webSearchErrorDetails(query)
          )
        }

        if (signal?.aborted) {
          return toolText('Search cancelled', webSearchDetails(query))
        }

        const data = JSON.parse(response.text) as ExaSearchResponse
        const output = formatSynthesis(data.output?.content)
        const results: SearchResult[] = (data.results ?? []).map((r) => ({
          title: (r.title as string) || 'Untitled',
          url: r.url as string,
          author: (r.author as string) || undefined,
          publishedDate: (r.publishedDate as string) || undefined,
          text: (r.text as string) || '',
          highlights: (r.highlights as string[]) || undefined,
          summary: (r.summary as string) || undefined
        }))

        if (results.length === 0 && !output) {
          return toolText(
            'No search results found. Try a different query.',
            webSearchDetails(query)
          )
        }

        const formatted = formatResultsAsText(results, output)
        const truncated = truncateHeadText(formatted, {
          notice: (truncation) => {
            if (truncation.firstLineExceedsLimit) {
              return `[First result line exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use highlights or lower contextMaxCharacters.]`
            }
            return `[Search output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines. Use fewer results, highlights, or lower contextMaxCharacters.]`
          }
        })

        return toolText(truncated.text, {
          ...webSearchDetails(query, results, output),
          truncation: truncated.truncation
        } satisfies WebSearchDetails)
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
        if (isPartial) return renderEmpty()
        return details?.output
          ? renderLines([primary(details.output, theme)])
          : renderMuted('No results found.', theme)
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
