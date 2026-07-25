/**
 * Native desktop notifications via terminal OSC escape sequences.
 * Supports OSC 777 (Ghostty, WezTerm, foot, urxvt), OSC 9 (iTerm2-style),
 * and OSC 99 (Kitty). On macOS, falls back to a native notification:
 *
 *   - terminal-notifier with `-activate <bundle-id>` is used when available
 *     and the host terminal's bundle ID can be detected. Click brings the
 *     terminal to the foreground without running any script, so it cannot
 *     open Script Editor or any default-app handler.
 *   - osascript `display notification ... sound name "default"` is the
 *     built-in fallback when terminal-notifier is missing.
 *
 * PI_NOTIFY_OSC forces the OSC path regardless of platform.
 */
import { spawn, spawnSync } from 'node:child_process'

export function notifyDesktop(title: string, body: string): void {
  const oscOverride = process.env.PI_NOTIFY_OSC?.toLowerCase()
  if (oscOverride || process.platform !== 'darwin') {
    for (const sequence of buildDesktopNotificationSequences(title, body)) {
      process.stdout.write(sequence)
    }
    return
  }
  notifyMacOS(title, body)
}

function notifyMacOS(title: string, body: string): void {
  const bundleId = getTerminalBundleId(process.env)
  if (bundleId && hasTerminalNotifier()) {
    spawnTerminalNotifier(title, body, bundleId)
  } else {
    spawnOsascript(title, body)
  }
}

export function getTerminalBundleId(env: Record<string, string | undefined>): string | undefined {
  if (isKitty(env)) return 'net.kovidgoyal.kitty'
  if (isITerm(env)) return 'com.googlecode.iterm2'
  const program = env.TERM_PROGRAM
  if (program === 'Apple_Terminal') return 'com.apple.Terminal'
  if (program === 'ghostty') return 'com.mitchellh.ghostty'
  if (program === 'WezTerm') return 'com.github.wez.wezterm'
  return undefined
}

function hasTerminalNotifier(): boolean {
  try {
    const result = spawnSync('which', ['terminal-notifier'], { stdio: 'ignore' })
    return result.status === 0
  } catch {
    return false
  }
}

function spawnTerminalNotifier(title: string, body: string, bundleId: string): void {
  const child = spawn(
    'terminal-notifier',
    ['-title', title, '-message', body, '-group', 'dot-pi', '-activate', bundleId],
    { stdio: 'ignore', detached: true }
  )
  child.unref()
}

function spawnOsascript(title: string, body: string): void {
  const child = spawn('osascript', ['-e', buildMacOSNotifyScript(title, body)], {
    stdio: 'ignore',
    detached: true
  })
  child.unref()
}

export function buildMacOSNotifyScript(title: string, body: string): string {
  return `display notification "${escapeForAppleScript(body)}" with title "${escapeForAppleScript(title)}" sound name "default"`
}

export function escapeForAppleScript(text: string): string {
  return sanitizeNotificationText(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
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
