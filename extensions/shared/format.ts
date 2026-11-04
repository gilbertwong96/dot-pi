import { formatSize } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences } from '@earendil-works/pi-tui'

export { formatSize as formatBytes, stripTerminalSequences as stripAnsi }

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
}

export function compactText(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/gu, ' ').trim()
  return compact.length > maxChars ? `${compact.slice(0, Math.max(0, maxChars - 1))}…` : compact
}

export function stripCarriageReturnProgress(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line
      const parts = line.split('\r')
      return parts[parts.length - 1] ?? ''
    })
    .join('\n')
}

export function normalizeTerminalOutput(text: string): string {
  return stripCarriageReturnProgress(stripTerminalSequences(text))
}

export function compactLines(
  text: string,
  maxChars = Number.MAX_SAFE_INTEGER,
  options: { normalizeTerminal?: boolean } = {}
): string[] {
  const content = options.normalizeTerminal === false ? text : normalizeTerminalOutput(text)
  return content
    .split('\n')
    .map((line) => compactText(line, maxChars))
    .filter(Boolean)
}
