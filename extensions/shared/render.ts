import { rawKeyHint, type AgentToolResult, type Theme } from '@earendil-works/pi-coding-agent'
import { Text, visibleWidth, type Component } from '@earendil-works/pi-tui'

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

export function renderLines(lines: string[]): Component {
  return new Text(['', ...lines].join('\n'), 0, 0)
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
  if (visibleWidth(text) <= maxWidth) return text

  const target = Math.max(0, maxWidth - 1)
  let out = ''
  let width = 0
  for (const char of text) {
    const charWidth = visibleWidth(char)
    if (width + charWidth > target) return out + '…'
    out += char
    width += charWidth
  }
  return out
}

export function renderSingleLine(text: string): Component {
  return {
    render: (width) => [truncateLine(text, width)],
    invalidate: () => undefined
  }
}

export function expandHint(theme: Theme): string {
  return theme.fg('muted', '(') + rawKeyHint('ctrl+o', 'to expand') + theme.fg('muted', ')')
}

export function hiddenLine(count: number, theme: Theme, unit = 'more'): string | undefined {
  return count > 0 ? theme.fg('muted', `… ${count} ${unit}`) : undefined
}
