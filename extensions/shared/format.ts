export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

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

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
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
  return stripCarriageReturnProgress(stripAnsi(text))
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
