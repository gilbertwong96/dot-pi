/**
 * Webfetch Tool Extension
 *
 * Fetches content from URLs and converts to markdown/text/html.
 * Supports CSS selector extraction, PDF parsing, JSON formatting,
 * custom headers, and redirect tracking.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { withTimeoutSignal } from '../shared/abort'
import {
  firstText,
  meta as renderMeta,
  primary,
  renderError,
  renderLines,
  renderMarkdownPreview,
  renderToolCall,
  title,
  toolError,
  toolLoading,
  toolText
} from '../shared/render'
import { Type } from 'typebox'
import * as cheerio from 'cheerio'
import TurndownService from 'turndown'
import { extractText as extractPdfText } from 'unpdf'

interface FetchDetails {
  url?: string
  finalUrl?: string
  contentType?: string
  format?: string
  size?: number
  totalChars?: number
  truncated?: boolean
  error?: boolean
  loading?: boolean
  status?: number
  redirected?: boolean
  selector?: string
}

interface FetchParams {
  url: string
  format?: 'markdown' | 'text' | 'html' | 'json'
  selector?: string
  timeout?: number
  headers?: Record<string, string>
}

function stylePreviewLine(line: string, theme: Parameters<typeof title>[1]): string {
  const knownHeading = line.match(/^(Example Domain)(\s+This domain\b.*)$/)
  if (knownHeading) return title(knownHeading[1], theme) + primary(knownHeading[2], theme)

  const markdownHeading = line.match(/^#\s+(.+)$/)
  if (markdownHeading) return title(markdownHeading[1], theme)

  return primary(line, theme)
}

function dedupeRepeatedHeading(line: string): string {
  const words = line.trim().split(/\s+/)
  for (let size = 1; size <= Math.min(6, Math.floor(words.length / 2)); size++) {
    const first = words.slice(0, size).join(' ')
    const second = words.slice(size, size * 2).join(' ')
    if (first === second) return words.slice(size).join(' ')
  }
  return line
}

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024
const MAX_OUTPUT_CHARS = 20000
const DEFAULT_TIMEOUT = 30 * 1000
const MAX_TIMEOUT = 120 * 1000

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const DESCRIPTION = `Fetches content from a specified URL and converts to requested format.

Usage notes:
- URL must be fully-formed and valid (http:// or https://)
- Format options: "markdown" (default), "text", "html", or "json"
- HTML content is automatically converted to markdown by default
- PDFs are automatically detected and extracted as text
- JSON responses are pretty-printed with "json" format
- Use 'selector' to extract specific parts of a page (CSS selector, e.g. "article", ".content", "#main")
- Use 'headers' for custom HTTP headers (e.g. Authorization, Cookie)
- Shows final URL after redirects
- Results may be truncated if content is very large (5MB limit)
- Output is capped at 20,000 characters to keep responses manageable`

function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*'
  })
  turndownService.remove(['script', 'style', 'meta', 'link', 'noscript'])
  return turndownService.turndown(html)
}

function extractTextFromHTML(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function applySelector(html: string, selector: string): string {
  const $ = cheerio.load(html)
  const selected = $(selector)
  if (selected.length === 0) return ''
  if (selected.length === 1) return selected.html() ?? ''
  return selected
    .map((_, el) => $(el).html())
    .get()
    .join('\n\n')
}

function truncateOutput(text: string) {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return { output: text, truncated: false, totalChars: text.length }
  }

  return {
    output: `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[Truncated: ${text.length - MAX_OUTPUT_CHARS} chars omitted]`,
    truncated: true,
    totalChars: text.length
  }
}

function isPdf(contentType: string, url: string): boolean {
  return contentType.includes('application/pdf') || url.toLowerCase().endsWith('.pdf')
}

function isJson(contentType: string): boolean {
  return contentType.includes('application/json') || contentType.includes('+json')
}

function normalizedContentType(contentType: string): string {
  return contentType.split(';')[0]?.trim().toLowerCase() ?? ''
}

function isTextualContentType(contentType: string): boolean {
  const mime = normalizedContentType(contentType)
  if (!mime) return false
  if (mime.startsWith('text/')) return true
  if (mime.endsWith('+json') || mime.endsWith('+xml')) return true

  return [
    'application/ecmascript',
    'application/javascript',
    'application/json',
    'application/ld+json',
    'application/markdown',
    'application/rss+xml',
    'application/xhtml+xml',
    'application/xml',
    'application/x-www-form-urlencoded',
    'application/yaml'
  ].includes(mime)
}

function isKnownBinaryContentType(contentType: string): boolean {
  const mime = normalizedContentType(contentType)
  if (!mime) return false
  if (
    mime.startsWith('audio/') ||
    mime.startsWith('video/') ||
    mime.startsWith('image/') ||
    mime.startsWith('font/')
  ) {
    return true
  }

  return [
    'application/gzip',
    'application/octet-stream',
    'application/wasm',
    'application/x-7z-compressed',
    'application/x-bzip2',
    'application/x-gzip',
    'application/x-rar-compressed',
    'application/x-tar',
    'application/zip'
  ].includes(mime)
}

function looksBinary(arrayBuffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(arrayBuffer.slice(0, Math.min(arrayBuffer.byteLength, 4096)))
  if (bytes.length === 0) return false

  if (
    (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
    (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) ||
    (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) ||
    (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)
  ) {
    return true
  }

  let controlChars = 0
  for (const byte of bytes) {
    if (byte === 0) return true
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x1b) {
      controlChars++
    }
  }

  if (controlChars / bytes.length > 0.3) return true

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return false
  } catch {
    return true
  }
}

function binaryContentMessage(contentType: string, size: number): string {
  const type = normalizedContentType(contentType) || 'unknown binary content'
  return `Binary content not displayed: ${type} · ${formatSize(size)}`
}

const FetchParamsSchema = Type.Object({
  url: Type.String({ description: 'The URL to fetch content from' }),
  format: Type.Optional(
    Type.Union(
      [Type.Literal('markdown'), Type.Literal('text'), Type.Literal('html'), Type.Literal('json')],
      { description: 'Output format (default: "markdown"). Use "json" for API endpoints.' }
    )
  ),
  selector: Type.Optional(
    Type.String({
      description:
        'CSS selector to extract specific page content (e.g. "article", ".main-content", "#post-body"). Applied before format conversion.'
    })
  ),
  timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds (max 120)' })),
  headers: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        'Custom HTTP headers (e.g. {"Authorization": "Bearer xxx", "Cookie": "session=abc"})'
    })
  )
})

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'fetch',
    label: 'Fetch URL',
    description: DESCRIPTION,
    parameters: FetchParamsSchema as any,

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const {
        url,
        format = 'markdown',
        selector,
        timeout: timeoutSec,
        headers: customHeaders
      } = params as FetchParams

      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return toolError('URL must start with http:// or https://', { error: true })
      }

      const timeout = Math.min((timeoutSec ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT)

      onUpdate?.(toolLoading({ loading: true } satisfies FetchDetails))

      let acceptHeader = '*/*'
      switch (format) {
        case 'markdown':
          acceptHeader =
            'text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1'
          break
        case 'text':
          acceptHeader = 'text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1'
          break
        case 'html':
          acceptHeader = 'text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1'
          break
        case 'json':
          acceptHeader = 'application/json;q=1.0, */*;q=0.1'
          break
      }

      try {
        const response = await withTimeoutSignal(signal, timeout, (requestSignal) =>
          fetch(url, {
            signal: requestSignal,
            redirect: 'follow',
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              Accept: acceptHeader,
              'Accept-Language': 'en-US,en;q=0.9',
              ...customHeaders
            }
          })
        )

        if (!response.ok) {
          return toolError(`Request failed with status ${response.status}`, {
            error: true,
            status: response.status
          } satisfies FetchDetails)
        }

        const contentLength = response.headers.get('content-length')
        if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
          return toolError('Response too large (exceeds 5MB limit)', { error: true })
        }

        const arrayBuffer = await response.arrayBuffer()
        if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
          return toolError('Response too large (exceeds 5MB limit)', { error: true })
        }

        const contentType = response.headers.get('content-type') || ''
        const finalUrl = response.url
        const redirected = response.redirected || finalUrl !== url

        // PDF handling
        if (isPdf(contentType, url)) {
          try {
            const { text: pdfText } = await extractPdfText(new Uint8Array(arrayBuffer), {
              mergePages: true
            })
            const { output, truncated, totalChars } = truncateOutput(pdfText)
            return toolText(output, {
              url,
              finalUrl: redirected ? finalUrl : undefined,
              contentType,
              format: 'pdf→text',
              size: arrayBuffer.byteLength,
              totalChars,
              truncated,
              redirected
            } satisfies FetchDetails)
          } catch {
            return toolError('Failed to extract text from PDF', {
              url,
              error: true,
              contentType
            } satisfies FetchDetails)
          }
        }

        if (
          isKnownBinaryContentType(contentType) ||
          (!isTextualContentType(contentType) && looksBinary(arrayBuffer))
        ) {
          const message = binaryContentMessage(contentType, arrayBuffer.byteLength)
          return toolText(message, {
            url,
            finalUrl: redirected ? finalUrl : undefined,
            contentType,
            format: 'binary',
            size: arrayBuffer.byteLength,
            redirected
          } satisfies FetchDetails)
        }

        const content = new TextDecoder().decode(arrayBuffer)

        // JSON handling
        if (format === 'json' || (format === 'markdown' && isJson(contentType))) {
          try {
            const parsed = JSON.parse(content)
            const formatted = JSON.stringify(parsed, null, 2)
            const { output, truncated, totalChars } = truncateOutput(formatted)
            return toolText(output, {
              url,
              finalUrl: redirected ? finalUrl : undefined,
              contentType,
              format: 'json',
              size: arrayBuffer.byteLength,
              totalChars,
              truncated,
              redirected
            } satisfies FetchDetails)
          } catch {
            // Not valid JSON, fall through to regular handling
          }
        }

        let html = content

        // Apply CSS selector if provided
        if (selector && contentType.includes('text/html')) {
          const extracted = applySelector(html, selector)
          if (!extracted) {
            return toolError(`No content found matching selector: ${selector}`, {
              url,
              selector,
              error: true
            } satisfies FetchDetails)
          }
          html = extracted
        }

        let output: string

        switch (format) {
          case 'markdown':
            output = contentType.includes('text/html') ? convertHTMLToMarkdown(html) : html
            break
          case 'text':
            output = contentType.includes('text/html') ? extractTextFromHTML(html) : html
            break
          case 'html':
          case 'json':
          default:
            output = html
            break
        }

        const { output: finalOutput, truncated, totalChars } = truncateOutput(output)

        return toolText(finalOutput, {
          url,
          finalUrl: redirected ? finalUrl : undefined,
          contentType,
          format,
          size: arrayBuffer.byteLength,
          totalChars,
          truncated,
          redirected,
          selector: selector || undefined
        } satisfies FetchDetails)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return toolError(message, { url, error: true } satisfies FetchDetails)
      }
    },

    renderCall(params, theme) {
      const args = (params ?? {}) as Partial<FetchParams>
      return renderToolCall(theme, 'fetch', {
        segments: [{ text: args.url }],
        tags: [args.format && args.format !== 'markdown' ? args.format : undefined, args.selector]
      })
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as FetchDetails | undefined

      if (details?.error) return renderError(firstText(result, 'Error'), theme)
      if (isPartial) return renderLines([])

      const content = result.content[0]
      const fullText = content?.type === 'text' ? content.text : ''

      const finalUrl = details?.finalUrl ?? details?.url
      const meta = [
        finalUrl,
        details?.size ? formatSize(details.size) : undefined,
        details?.truncated ? 'truncated' : undefined,
        details?.selector
      ]
        .filter(Boolean)
        .join(' · ')

      return renderMarkdownPreview(fullText, theme, {
        expanded,
        expandedY: 0,
        metadata: meta ? [renderMeta(meta, theme)] : [],
        preview: (markdown) => {
          const lines = markdown.split('\n').filter(Boolean)
          return {
            lines: lines.slice(0, 4).map(dedupeRepeatedHeading),
            hidden: Math.max(0, lines.length - 4)
          }
        },
        styleLine: stylePreviewLine
      })
    }
  })
}
