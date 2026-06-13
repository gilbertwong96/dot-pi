import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import { DynamicBorder, getMarkdownTheme } from '@earendil-works/pi-coding-agent'
import type { Theme } from '@earendil-works/pi-coding-agent'
import { Container, Markdown, Spacer, Text } from '@earendil-works/pi-tui'

import type { CriticDetails } from './types'

export function renderCriticReview(
  message: { content: string | Array<TextContent | ImageContent>; details?: CriticDetails },
  expanded: boolean,
  theme: Theme
): Container {
  const details = message.details
  const result = details?.result

  const container = new Container()

  const hasError = !!result?.error
  const status = result?.status || (result?.approved ? 'APPROVED' : 'NEEDS_WORK')

  let borderColor: 'error' | 'success' | 'warning'
  let icon: string

  if (hasError) {
    borderColor = 'error'
    icon = '✗'
  } else if (status === 'APPROVED') {
    borderColor = 'success'
    icon = '✓'
  } else if (status === 'BLOCKED') {
    borderColor = 'error'
    icon = '⛔'
  } else {
    borderColor = 'warning'
    icon = '⚠'
  }

  container.addChild(new DynamicBorder((s: string) => theme.fg(borderColor, s)))

  let header = `${theme.fg(borderColor, icon)} ${theme.fg(borderColor, theme.bold('Critic Review'))}`
  if (result?.model) {
    header += ` ${theme.fg('muted', `(${result.model})`)}`
  }
  if (result?.timedOut) {
    header += ` ${theme.fg('error', '[TIMEOUT]')}`
  }
  container.addChild(new Text(header, 1, 0))

  if (hasError) {
    container.addChild(new Text(theme.fg('error', `Error: ${result.error}`), 1, 0))
  }

  const contentText = criticContentText(message.content)
  if (contentText && !contentText.startsWith('(')) {
    container.addChild(new Markdown(contentText, 1, 0, getMarkdownTheme()))
  }

  const statsParts = criticStats(result)
  if (statsParts.length > 0) {
    container.addChild(new Text(theme.fg('dim', statsParts.join(' · ')), 1, 0))
  }

  if (expanded && details?.context) {
    container.addChild(new Spacer(1))
    container.addChild(new Text(theme.fg('muted', '─── Context ───'), 1, 0))
    container.addChild(new Text(theme.fg('dim', details.context), 1, 0))
  }

  container.addChild(new DynamicBorder((s: string) => theme.fg(borderColor, s)))

  return container
}

function criticContentText(content: string | Array<TextContent | ImageContent>): string {
  if (typeof content === 'string') return content
  return content
    .filter((part): part is TextContent => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

function criticStats(result: CriticDetails['result'] | undefined): string[] {
  const statsParts: string[] = []
  if (result?.usage) {
    statsParts.push(
      `↑${result.usage.input} ↓${result.usage.output} $${result.usage.cost.toFixed(4)}`
    )
  }
  if (result?.durationMs) {
    statsParts.push(`${(result.durationMs / 1000).toFixed(1)}s`)
  }
  return statsParts
}
