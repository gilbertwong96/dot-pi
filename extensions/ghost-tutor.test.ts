import { describe, expect, test } from 'bun:test'
import {
  buildGhostConversation,
  buildGhostTutorSystemPrompt,
  extractText,
  GHOST_TUTOR_MESSAGE_TYPE
} from './ghost-tutor'

const message = (role: 'user' | 'assistant', text: string) => ({
  type: 'message',
  message: {
    role,
    content: [{ type: 'text', text }]
  }
})

describe('extractText', () => {
  test('extracts text blocks from Pi message content', () => {
    expect(
      extractText([
        { type: 'text', text: 'one' },
        { type: 'image', data: 'x' },
        { type: 'text', text: 'two' }
      ])
    ).toBe('one\ntwo')
  })
})

describe('buildGhostConversation', () => {
  test('keeps recent user and assistant text messages', () => {
    const result = buildGhostConversation([
      message('user', 'hello'),
      message('assistant', 'answer'),
      { type: 'custom', customType: GHOST_TUTOR_MESSAGE_TYPE }
    ])

    expect(result).toHaveLength(2)
    expect(result[0]?.role).toBe('user')
    expect(result[1]?.role).toBe('assistant')
  })
})

describe('buildGhostTutorSystemPrompt', () => {
  test('delegates nudge detection to the LLM semantically', () => {
    const prompt = buildGhostTutorSystemPrompt()

    expect(prompt).toContain('Decide whether a ghost nudge is useful')
    expect(prompt).toContain('use semantic judgment')
    expect(prompt).toContain('not keyword matching')
    expect(prompt).toContain('return exactly: NO_NUDGE')
    expect(prompt).toContain('Start with "Dan:"')
    expect(prompt).toContain('next big / exactly 7 next steps = reset/control surface')
  })
})
