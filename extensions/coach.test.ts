import { describe, expect, test } from 'bun:test'
import { buildCoachPrompt } from './coach'

describe('buildCoachPrompt', () => {
  test('points at setup evidence and stays read-only', () => {
    const prompt = buildCoachPrompt('shortcuts')

    expect(prompt).toContain('docs/handbook.md')
    expect(prompt).toContain('prompts')
    expect(prompt).toContain('rules')
    expect(prompt).toContain('skills')
    expect(prompt).toContain('Focus especially on: shortcuts')
    expect(prompt).toContain('Do not edit files, commit, push, or start implementation')
  })
})
