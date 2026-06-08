import { describe, expect, test } from 'bun:test'
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
})
