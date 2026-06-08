/**
 * Native desktop notifications via terminal OSC escape sequences.
 * Supports OSC 777 (Ghostty, iTerm2, WezTerm, foot, urxvt) and OSC 9 (iTerm2-style).
 */
export function notifyDesktop(title: string, body: string): void {
  const safeTitle = sanitizeNotificationText(title)
  const safeBody = sanitizeNotificationText(body)

  process.stdout.write(`\x1b]777;notify;${safeTitle};${safeBody}\x1b\\`)

  const message = safeTitle ? `${safeTitle}: ${safeBody}` : safeBody
  process.stdout.write(`\x1b]9;${message}\x1b\\`)
}

function sanitizeNotificationText(text: string): string {
  return text.replace(/[;\x00-\x1f]/g, '').slice(0, 240)
}
