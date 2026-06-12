import { rawKeyHint, type AgentToolResult, type Theme } from '@earendil-works/pi-coding-agent'
import { truncateToWidth, type Component, type MarkdownTheme } from '@earendil-works/pi-tui'

export function resultText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((content) => content.type === 'text')
    .map((content) => content.text)
    .join('\n')
}

export function firstText(result: AgentToolResult<unknown>, fallback = ''): string {
  const first = result.content[0]
  return first?.type === 'text' ? first.text : fallback
}

type TextToolResult<T> = AgentToolResult<T> & { isError?: boolean }

export function toolText<T>(
  text: string,
  details: T,
  options: { isError?: boolean } = {}
): TextToolResult<T> {
  return {
    content: [{ type: 'text', text }],
    details,
    ...(options.isError ? { isError: true } : {})
  }
}

export function toolError<T>(message: string, details: T): TextToolResult<T> {
  return toolText(message.startsWith('Error:') ? message : `Error: ${message}`, details, {
    isError: true
  })
}

export function toolLoading<T>(details: T): AgentToolResult<T> {
  return { content: [], details }
}

/**
 * Native pi-style tool result block.
 *
 * Rules:
 * - Leading blank line before result content.
 * - No blanket left padding; each renderer decides semantic indentation.
 * - Metadata is muted, primary content is toolOutput, titles may be bold/accent.
 * - Expand hints are standalone footers: insert a blank line before expandHint().
 */
export function renderLines(lines: string[]): Component {
  return {
    render: (width) => ['', ...lines.map((line) => truncateLine(line, width))],
    invalidate: () => undefined
  }
}

export function clampRenderedLines(component: Component): Component {
  return {
    render: (width) => component.render(width).map((line) => truncateLine(line, width)),
    invalidate: () => component.invalidate()
  }
}

export function meta(text: string, theme: Theme): string {
  return theme.fg('muted', text)
}

export function primary(text: string, theme: Theme): string {
  return theme.fg('toolOutput', text)
}

export function title(text: string, theme: Theme): string {
  return theme.fg('toolOutput', theme.bold(text))
}

export function nativeMarkdownTheme(theme: Theme): MarkdownTheme {
  return {
    heading: (text) => title(text, theme),
    link: (text) => primary(text, theme),
    linkUrl: (text) => meta(text, theme),
    code: (text) => theme.fg('accent', text),
    codeBlock: (text) => primary(text, theme),
    codeBlockBorder: (text) => meta(text, theme),
    quote: (text) => primary(text, theme),
    quoteBorder: (text) => meta(text, theme),
    hr: (text) => meta(text, theme),
    listBullet: (text) => meta(text, theme),
    bold: (text) => theme.bold(text),
    italic: (text) => text,
    strikethrough: (text) => text,
    underline: (text) => theme.underline(text),
    codeBlockIndent: ''
  }
}

export function renderExpandFooter(theme: Theme): string[] {
  return ['', expandHint(theme)]
}

export interface ResultEntryBlock {
  header: string
  metadata?: string
  body?: string[]
}

/**
 * Append a native-style multi-entry result block:
 *
 *   header
 *   metadata
 *
 *   body
 *
 * Multiple entries are separated by one blank line. Metadata and body are
 * separated by one blank line so content does not visually merge with paths.
 */
export function appendEntryBlock(lines: string[], entry: ResultEntryBlock): void {
  if (lines.length > 0) lines.push('')
  lines.push(entry.header)
  if (entry.metadata) lines.push(entry.metadata)
  if (entry.body?.length) lines.push('', ...entry.body)
}

export function appendFooter(lines: string[], footer: string[]): void {
  if (footer.length === 0) return
  const normalized = footer[0] === '' ? footer.slice(1) : footer
  if (normalized.length === 0) return
  if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('')
  lines.push(...normalized)
}

export function renderError(text: string, theme: Theme): Component {
  return renderLines([theme.fg('error', text || 'Error')])
}

export function renderMuted(text: string, theme: Theme): Component {
  return renderLines([theme.fg('muted', text)])
}

export function compactText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function truncateText(text: string, maxChars: number): string {
  const compact = compactText(text)
  return compact.length > maxChars ? compact.slice(0, Math.max(0, maxChars - 1)) + '…' : compact
}

export function truncateLine(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  return truncateToWidth(text, maxWidth, '…')
}

export function renderSingleLine(text: string): Component {
  return {
    render: (width) => [truncateLine(text, width)],
    invalidate: () => undefined
  }
}

type ToolCallSegmentColor = 'accent' | 'muted' | 'dim' | 'success'

interface ToolCallSegment {
  text?: string | number | boolean | null
  color?: ToolCallSegmentColor
  prefix?: string
}

interface ToolCallRenderOptions {
  segments?: ToolCallSegment[]
  tags?: Array<string | number | boolean | null | undefined>
  suffix?: string | number | boolean | null
}

export function renderToolCall(
  theme: Theme,
  titleText: string,
  options: ToolCallRenderOptions = {}
): Component {
  let text = theme.fg('toolTitle', theme.bold(titleText))

  for (const segment of options.segments ?? []) {
    if (segment.text === undefined || segment.text === null || segment.text === '') continue
    text += theme.fg(segment.color ?? 'accent', `${segment.prefix ?? ' '}${String(segment.text)}`)
  }

  const tags = (options.tags ?? [])
    .filter((tag) => tag !== undefined && tag !== null && tag !== false && tag !== '')
    .map(String)
  if (tags.length) text += theme.fg('dim', ` [${tags.join(', ')}]`)

  if (options.suffix !== undefined && options.suffix !== null && options.suffix !== '') {
    text += theme.fg('dim', ` (${String(options.suffix)})`)
  }

  return renderSingleLine(text)
}

export function expandHint(theme: Theme): string {
  return theme.fg('muted', '(') + rawKeyHint('ctrl+o', 'to expand') + theme.fg('muted', ')')
}

export function hiddenLine(count: number, theme: Theme, unit = 'more'): string | undefined {
  return count > 0 ? theme.fg('muted', `… ${count} ${unit}`) : undefined
}
