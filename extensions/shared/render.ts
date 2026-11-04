import {
  getMarkdownTheme,
  truncateToVisualLines,
  type AgentToolResult,
  type KeybindingHints,
  type Theme
} from '@earendil-works/pi-coding-agent'
import { compactText as compactTextValue } from './format'
import {
  Markdown,
  truncateToWidth,
  wrapTextWithAnsi,
  visibleWidth,
  type Component
} from '@earendil-works/pi-tui'

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
class CachedLines implements Component {
  private signature = ''
  private build: () => string[] = () => []
  private lines?: string[]
  private cachedWidth?: number
  private cached?: string[]

  update(signature: string, build: () => string[]): void {
    this.build = build
    if (signature === this.signature && this.lines) return
    this.signature = signature
    this.lines = build()
    this.cachedWidth = undefined
    this.cached = undefined
  }

  render(width: number): string[] {
    if (!this.lines) this.lines = this.build()
    if (this.cached && this.cachedWidth === width) return this.cached
    this.cachedWidth = width
    this.cached = renderLines(this.lines).render(width)
    return this.cached
  }

  invalidate(): void {
    this.cachedWidth = undefined
    this.cached = undefined
    this.lines = undefined
  }
}

export function reuseLines(
  previous: Component | undefined,
  signature: string,
  build: () => string[]
): Component {
  if (previous instanceof CachedLines) {
    previous.update(signature, build)
    return previous
  }
  const component = new CachedLines()
  component.update(signature, build)
  return component
}

export function renderEmpty(): Component {
  return {
    render: () => [],
    invalidate: () => undefined
  }
}

type RenderLine = string | ((width: number) => string)

export function renderLines(lines: string[]): Component {
  return renderLinesWithMarker(lines, '…')
}

export function renderLinesWithMarker(lines: RenderLine[], marker: string): Component {
  return {
    render: (width) => [
      '',
      ...lines.flatMap((line) => {
        const value = typeof line === 'function' ? line(width) : line
        return value
          .replace(/\r\n|\r|\n/gu, '\n')
          .split('\n')
          .map((part) => {
            return truncateLine(part, width, marker)
          })
      })
    ],
    invalidate: () => undefined
  }
}

export function clampRenderedLines(component: Component): Component {
  return {
    render: (width) =>
      component
        .render(width)
        .flatMap((line) => line.split(/\r\n|\r|\n/u).map((part) => truncateLine(part, width))),
    invalidate: () => component.invalidate()
  }
}

export function meta(text: string, theme: Theme): string {
  return theme.fg('muted', text)
}

export function primary(text: string, theme: Theme): string {
  return theme.fg('toolOutput', text)
}

function readAnsiSequence(text: string, start: number): string | undefined {
  const introducer = text[start + 1]

  if (introducer === '[') {
    for (let index = start + 2; index < text.length; index++) {
      const code = text.charCodeAt(index)
      if (code >= 0x40 && code <= 0x7e) return text.slice(start, index + 1)
    }
  }

  if (introducer === ']') {
    const bell = text.indexOf('\x07', start + 2)
    const st = text.indexOf('\x1b\\', start + 2)
    const end = bell === -1 ? st : st === -1 ? bell : Math.min(bell, st)
    if (end !== -1) return text.slice(start, end + (end === st ? 2 : 1))
  }

  if (introducer && 'PX^_'.includes(introducer)) {
    const end = text.indexOf('\x1b\\', start + 2)
    if (end !== -1) return text.slice(start, end + 2)
  }

  return start + 1 < text.length ? text.slice(start, start + 2) : text[start]
}

export function expandTabs(text: string, tabSize = 8): string {
  let column = 0
  let expanded = ''

  for (let index = 0; index < text.length; ) {
    if (text[index] === '\x1b') {
      const sequence = readAnsiSequence(text, index)
      if (sequence) {
        expanded += sequence
        index += sequence.length
        continue
      }
    }

    const codePoint = text.codePointAt(index)
    if (codePoint === undefined) break

    const char = String.fromCodePoint(codePoint)
    index += char.length

    if (char === '\t') {
      const spaces = tabSize - (column % tabSize)
      expanded += ' '.repeat(spaces)
      column += spaces
      continue
    }

    expanded += char
    column += visibleWidth(char)
  }

  return expanded
}

export function title(text: string, theme: Theme): string {
  return theme.fg('toolOutput', theme.bold(text))
}

export function renderExpandFooter(theme: Theme, hints?: KeybindingHints): string[] {
  return ['', expandHint(theme, hints)]
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

interface EntryListOptions<T> {
  expanded: boolean
  compactLimit: number
  renderEntry: (entry: T, index: number) => ResultEntryBlock | undefined
  hiddenLines?: (hiddenEntries: number, visibleEntries: number) => string[]
}

export function renderEntryList<T>(
  entries: T[],
  theme: Theme,
  options: EntryListOptions<T>
): Component {
  const lines: string[] = []
  const visibleCount = options.expanded
    ? entries.length
    : Math.min(options.compactLimit, entries.length)

  for (let index = 0; index < visibleCount; index++) {
    const entry = entries[index]
    if (entry === undefined) continue
    const block = options.renderEntry(entry, index)
    if (block) appendEntryBlock(lines, block)
  }

  if (!options.expanded) {
    const hidden = options.hiddenLines?.(entries.length - visibleCount, visibleCount) ?? []
    if (hidden.length > 0) appendFooter(lines, [...hidden, ...renderExpandFooter(theme)])
  }

  return renderLines(lines)
}

interface MarkdownPreviewOptions {
  expanded: boolean
  compactLines?: number
  expandedY?: number
  metadata?: string[]
  preview?: (markdown: string) => { lines: string[]; hidden: number }
  styleLine?: (line: string, theme: Theme) => string
  hints?: KeybindingHints
  previous?: Component
}

function defaultMarkdownPreview(
  markdown: string,
  compactLines: number
): { lines: string[]; hidden: number } {
  const lines = markdown.split('\n').filter(Boolean)
  return { lines: lines.slice(0, compactLines), hidden: Math.max(0, lines.length - compactLines) }
}

interface TextLinesPreviewOptions {
  expanded: boolean
  compactLimit: number
  expandedLimit?: number
  header?: string[]
  mode?: 'head' | 'tail'
  hiddenUnit?: string
  inlineHidden?: boolean
  styleLine?: (line: string, theme: Theme) => string
  truncationMarker?: string
  hints?: KeybindingHints
}

export function renderTextLinesPreview(
  lines: string[],
  theme: Theme,
  options: TextLinesPreviewOptions
): Component {
  const styleLine = options.styleLine ?? ((line: string) => primary(line, theme))
  const mode = options.mode ?? 'head'
  const limit = options.expanded ? options.expandedLimit : options.compactLimit
  const visibleLines =
    limit === undefined ? lines : mode === 'tail' ? lines.slice(-limit) : lines.slice(0, limit)
  const hidden = Math.max(0, lines.length - visibleLines.length)
  const hiddenText = hiddenLine(hidden, theme, options.hiddenUnit ?? 'more lines')
  const inlineHidden =
    !options.expanded && options.inlineHidden && hiddenText && visibleLines.length > 0

  if (options.expanded || inlineHidden || options.truncationMarker) {
    const renderedLines = [
      ...(options.header ?? []),
      ...visibleLines.map((line, index) => {
        const styledLine = styleLine(line, theme)
        if (!inlineHidden || index !== visibleLines.length - 1) return styledLine
        return appendWidthAwareSuffix(
          styledLine,
          ` ${hiddenText} ${expandHint(theme, options.hints)}`,
          options.truncationMarker
        )
      })
    ]
    if (!options.expanded && hiddenText && !inlineHidden) {
      renderedLines.push('', hiddenText, ...renderExpandFooter(theme, options.hints))
    }
    return renderLinesWithMarker(renderedLines, options.truncationMarker ?? '…')
  }

  return {
    render(width) {
      const styled = visibleLines.map((line) => styleLine(line, theme)).join('\n')
      const preview = truncateToVisualLines(
        styled,
        limit ?? Number.MAX_SAFE_INTEGER,
        width,
        0,
        mode === 'tail' ? 'end' : 'start'
      )
      const rendered = [
        ...(options.header ?? []),
        ...preview.visualLines.map((line) => line.trimEnd())
      ]
      if (!options.expanded && hiddenText) {
        rendered.push('', hiddenText, ...renderExpandFooter(theme, options.hints))
      } else if (!options.expanded && preview.skippedCount > 0) {
        rendered.push(
          '',
          meta(`… ${preview.skippedCount} more lines`, theme),
          ...renderExpandFooter(theme, options.hints)
        )
      }
      return renderLines(rendered).render(width)
    },
    invalidate() {}
  }
}

function appendWidthAwareSuffix(
  line: string,
  suffix: string,
  marker = '…'
): (width: number) => string {
  return (width) => {
    const suffixWidth = visibleWidth(suffix)
    if (suffixWidth >= width) return truncateLine(suffix, width, marker)
    return truncateLine(line, width - suffixWidth, marker) + suffix
  }
}

class ExpandedMarkdownPreview implements Component {
  private markdown: Markdown
  private metadata: string[]
  private markdownText: string

  constructor(markdown: string, metadata: string[], expandedY: number, theme: Theme) {
    this.metadata = metadata
    this.markdownText = markdown.trim()
    this.markdown = new Markdown(this.markdownText, 0, expandedY, getMarkdownTheme(), {
      color: (text) => theme.fg('toolOutput', text)
    })
  }

  update(markdown: string, metadata: string[]): void {
    this.metadata = metadata
    const next = markdown.trim()
    if (next === this.markdownText) return
    this.markdownText = next
    this.markdown.setText(next)
  }

  render(width: number): string[] {
    return clampRenderedLines({
      render: (innerWidth) => [
        '',
        ...this.metadata,
        ...(this.metadata.length ? [''] : []),
        ...this.markdown.render(innerWidth)
      ],
      invalidate: () => this.markdown.invalidate()
    }).render(width)
  }

  invalidate(): void {
    this.markdown.invalidate()
  }
}

export function renderMarkdownPreview(
  markdown: string,
  theme: Theme,
  options: MarkdownPreviewOptions
): Component {
  if (options.expanded) {
    const metadata = options.metadata ?? []
    const previous = options.previous
    if (previous instanceof ExpandedMarkdownPreview) {
      previous.update(markdown, metadata)
      return previous
    }
    const preview = new ExpandedMarkdownPreview(markdown, metadata, options.expandedY ?? 1, theme)
    preview.update(markdown, metadata)
    return preview
  }

  const preview =
    options.preview?.(markdown) ?? defaultMarkdownPreview(markdown, options.compactLines ?? 4)
  const styleLine = options.styleLine ?? ((line: string) => primary(line, theme))
  const lines = [
    ...(options.metadata ?? []),
    ...preview.lines.map((line) => styleLine(line, theme))
  ]

  if (preview.hidden > 0) {
    lines.push(
      meta(`… ${preview.hidden} more lines`, theme),
      ...renderExpandFooter(theme, options.hints)
    )
  }

  return renderLines(lines)
}

export function renderError(text: string, theme: Theme): Component {
  return {
    render: (width) => [
      '',
      ...wrapTextWithAnsi(theme.fg('error', text || 'Error'), Math.max(1, width))
    ],
    invalidate() {}
  }
}

export function renderErrorOrPartial(
  result: AgentToolResult<unknown>,
  details: { error?: boolean } | undefined,
  options: { isPartial?: boolean },
  theme: Theme
): Component | undefined {
  if (details?.error) return renderError(firstText(result, 'Error'), theme)
  if (options.isPartial) return renderEmpty()
  return undefined
}

export function renderMuted(text: string, theme: Theme): Component {
  return renderLines([theme.fg('muted', text)])
}

export function compactText(text: string): string {
  return compactTextValue(text, Number.MAX_SAFE_INTEGER)
}

export function truncateText(text: string, maxChars: number): string {
  return compactTextValue(text, maxChars)
}

export function truncateLine(text: string, maxWidth: number, marker = '…'): string {
  if (maxWidth <= 0) return ''
  return truncateToWidth(expandTabs(text), maxWidth, marker)
}

export function renderSingleLine(text: string): Component {
  return {
    render: (width) => [truncateLine(text.replace(/\r\n|\r|\n/gu, ' '), width)],
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

  return {
    render: (width) => wrapTextWithAnsi(text.replace(/\r\n|\r|\n/gu, ' '), Math.max(1, width)),
    invalidate() {}
  }
}

export function expandHint(theme: Theme, hints?: KeybindingHints): string {
  const hint =
    typeof hints?.keyHint === 'function'
      ? hints.keyHint('app.tools.expand', 'to expand')
      : undefined
  if (hint) return theme.fg('muted', '(') + hint + theme.fg('muted', ')')
  return theme.fg('muted', '(ctrl+o to expand)')
}

export function hiddenLine(count: number, theme: Theme, unit = 'more'): string | undefined {
  return count > 0 ? theme.fg('muted', `… ${count} ${unit}`) : undefined
}
