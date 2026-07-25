import { describe, expect, test } from 'vitest'
import {
  buildDesktopNotificationSequences,
  buildMacOSNotifyScript,
  escapeForAppleScript,
  getTerminalBundleId
} from './desktop-notify'

describe('buildDesktopNotificationSequences', () => {
  test('uses only OSC 777 in Ghostty to avoid duplicate notifications', () => {
    const sequences = buildDesktopNotificationSequences('π · dot-pi', 'Task completed', {
      TERM_PROGRAM: 'ghostty'
    })

    expect(sequences).toHaveLength(1)
    expect(sequences[0]).toContain(']777;notify;')
    expect(sequences[0]).not.toContain(']9;')
  })

  test('uses only OSC 9 in iTerm', () => {
    const sequences = buildDesktopNotificationSequences('π · dot-pi', 'Task completed', {
      TERM_PROGRAM: 'iTerm.app'
    })

    expect(sequences).toHaveLength(1)
    expect(sequences[0]).toContain(']9;π · dot-pi: Task completed')
  })

  test('supports explicit both-mode override', () => {
    const sequences = buildDesktopNotificationSequences('π · dot-pi', 'Task completed', {
      PI_NOTIFY_OSC: 'both'
    })

    expect(sequences).toHaveLength(2)
  })

  test('uses OSC 99 in Kitty', () => {
    const sequences = buildDesktopNotificationSequences('π · dot-pi', 'Task completed', {
      KITTY_WINDOW_ID: '1'
    })

    expect(sequences).toHaveLength(1)
    expect(sequences[0]).toContain(']99;i=notify:')
    expect(sequences[0]).toContain('π · dot-pi')
    expect(sequences[0]).toContain('Task completed')
    expect(sequences[0]).not.toContain(']777;')
    expect(sequences[0]).not.toContain(']9;')
  })

  test('PI_NOTIFY_OSC=99 forces OSC 99 even outside Kitty', () => {
    const sequences = buildDesktopNotificationSequences('π · dot-pi', 'Task completed', {
      PI_NOTIFY_OSC: '99'
    })

    expect(sequences).toHaveLength(1)
    expect(sequences[0]).toContain(']99;i=notify:')
  })

  test('sanitizes semicolons out of title before OSC 99', () => {
    const sequences = buildDesktopNotificationSequences('a;b', 'body', {
      KITTY_WINDOW_ID: '1'
    })

    expect(sequences).toHaveLength(1)
    expect(sequences[0]).not.toContain(';b')
  })
})

describe('buildMacOSNotifyScript', () => {
  test('emits AppleScript with title, body, and default sound', () => {
    expect(buildMacOSNotifyScript('π · dot-pi', 'Task completed')).toBe(
      'display notification "Task completed" with title "π · dot-pi" sound name "default"'
    )
  })

  test('escapes embedded quotes and backslashes', () => {
    expect(buildMacOSNotifyScript('a"b', 'c\\d')).toBe(
      'display notification "c\\\\d" with title "a\\"b" sound name "default"'
    )
  })
})

describe('escapeForAppleScript', () => {
  test('escapes backslashes and double quotes', () => {
    expect(escapeForAppleScript('a"b\\c')).toBe('a\\"b\\\\c')
  })

  test('preserves sanitization: drops semicolons, control chars, caps length', () => {
    expect(escapeForAppleScript('a;b\x00c')).toBe('abc')
    expect(escapeForAppleScript('x'.repeat(300)).length).toBe(240)
  })
})

describe('getTerminalBundleId', () => {
  test('returns Kitty bundle ID when KITTY_WINDOW_ID is set', () => {
    expect(getTerminalBundleId({ KITTY_WINDOW_ID: '1' })).toBe('net.kovidgoyal.kitty')
  })

  test('returns iTerm2 bundle ID for iTerm', () => {
    expect(getTerminalBundleId({ TERM_PROGRAM: 'iTerm.app' })).toBe('com.googlecode.iterm2')
  })

  test('returns Apple Terminal bundle ID', () => {
    expect(getTerminalBundleId({ TERM_PROGRAM: 'Apple_Terminal' })).toBe('com.apple.Terminal')
  })

  test('returns Ghostty bundle ID', () => {
    expect(getTerminalBundleId({ TERM_PROGRAM: 'ghostty' })).toBe('com.mitchellh.ghostty')
  })

  test('returns WezTerm bundle ID', () => {
    expect(getTerminalBundleId({ TERM_PROGRAM: 'WezTerm' })).toBe('com.github.wez.wezterm')
  })

  test('prefers Kitty over TERM_PROGRAM=tmux (Kitty-inside-tmux case)', () => {
    expect(getTerminalBundleId({ KITTY_WINDOW_ID: '2', TERM_PROGRAM: 'tmux' })).toBe(
      'net.kovidgoyal.kitty'
    )
  })

  test('returns undefined for unknown terminals', () => {
    expect(getTerminalBundleId({ TERM_PROGRAM: 'xterm' })).toBeUndefined()
    expect(getTerminalBundleId({})).toBeUndefined()
  })
})
