import { describe, expect, test } from 'vitest'
import { buildDesktopNotificationSequences } from './desktop-notify'

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
