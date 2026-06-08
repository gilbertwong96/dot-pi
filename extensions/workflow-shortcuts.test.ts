import { describe, expect, test } from 'bun:test'
import { buildNextPrompt, buildRecapPrompt } from './workflow-shortcuts'

describe('buildNextPrompt', () => {
  test('defaults to 7 steps when count is blank', () => {
    expect(buildNextPrompt('')).toBe(
      'State briefly. List exactly 7 next steps. End with best action.'
    )
  })

  test('uses the provided count', () => {
    expect(buildNextPrompt('3')).toBe(
      'State briefly. List exactly 3 next steps. End with best action.'
    )
  })
})

describe('buildRecapPrompt', () => {
  test('omits focus when blank', () => {
    expect(buildRecapPrompt('')).not.toContain('Focus on:')
  })

  test('includes focus when provided', () => {
    expect(buildRecapPrompt('release plan')).toContain('Focus on: release plan')
  })
})
