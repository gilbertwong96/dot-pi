/**
 * Native desktop notifications via terminal OSC escape sequences.
 * Supports OSC 777 (Ghostty, WezTerm, foot, urxvt) and OSC 9 (iTerm2-style).
 */
export function notifyDesktop(title: string, body: string): void {
  for (const sequence of buildDesktopNotificationSequences(title, body)) {
    process.stdout.write(sequence)
  }
}

export function buildDesktopNotificationSequences(
  title: string,
  body: string,
  env: Record<string, string | undefined> = process.env
): string[] {
  const safeTitle = sanitizeNotificationText(title)
  const safeBody = sanitizeNotificationText(body)
  const osc777 = `\x1b]777;notify;${safeTitle};${safeBody}\x1b\\`
  const osc9 = `\x1b]9;${safeTitle ? `${safeTitle}: ${safeBody}` : safeBody}\x1b\\`
  const osc99 = `\x1b]99;i=notify:${safeTitle}\x1b\\${safeBody}\x1b\\`

  switch (env.PI_NOTIFY_OSC?.toLowerCase()) {
    case '777':
      return [osc777]
    case '9':
      return [osc9]
    case '99':
      return [osc99]
    case 'both':
      return [osc777, osc9]
  }

  if (isKitty(env)) return [osc99]
  if (isITerm(env)) return [osc9]
  return [osc777]
}

function isKitty(env: Record<string, string | undefined>): boolean {
  return env.KITTY_WINDOW_ID !== undefined && env.KITTY_WINDOW_ID !== ''
}

function isITerm(env: Record<string, string | undefined>): boolean {
  return env.TERM_PROGRAM?.toLowerCase().includes('iterm') ?? false
}

function sanitizeNotificationText(text: string): string {
  return Array.from(text)
    .filter((char) => char !== ';' && char.charCodeAt(0) >= 32)
    .join('')
    .slice(0, 240)
}
