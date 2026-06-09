import { describe, expect, test } from 'bun:test'
import { buildDiscussPrompt, buildNextPrompt, buildRecapPrompt } from './workflow-shortcuts'

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

  test('uses a simpler prompt for one next step', () => {
    expect(buildNextPrompt('1')).toBe("What's next?")
  })

  test('supports coarse-grained next steps', () => {
    expect(buildNextPrompt('big')).toBe(
      'State briefly. List exactly 7 next steps at coarse granularity. Each step should be a meaningful work chunk, not a micro-action. Avoid routine substeps unless they are the main work item. End with best action.'
    )
  })

  test('supports short coarse-grained alias with count', () => {
    expect(buildNextPrompt('b 3')).toBe(
      'State briefly. List exactly 3 next steps at coarse granularity. Each step should be a meaningful work chunk, not a micro-action. Avoid routine substeps unless they are the main work item. End with best action.'
    )
  })
})

describe('buildDiscussPrompt', () => {
  test('puts the assistant in discussion mode', () => {
    expect(buildDiscussPrompt('scope')).toContain('Do not edit files')
    expect(buildDiscussPrompt('scope')).toContain('Topic: scope')
  })

  test('accepts a multiword topic', () => {
    expect(buildDiscussPrompt('whether to merge PR 1 or stop polishing')).toContain(
      'Topic: whether to merge PR 1 or stop polishing'
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
