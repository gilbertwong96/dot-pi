import { describe, expect, test } from 'bun:test'
import { buildPlaybookHint, buildTutorPrompt, isTutorSmokeMode, tutorWorkspaceFor } from './tutor'

describe('tutorWorkspaceFor', () => {
  test('uses a stable project-scoped Pi cache path', () => {
    const path = tutorWorkspaceFor('/tmp/example-project')

    expect(path).toContain('/cache/pi-workflow-tutor/example-project-')
    expect(path).not.toContain('/tmp/example-project/.pi')
  })
})

describe('isTutorSmokeMode', () => {
  test('is disabled by default', () => {
    expect(isTutorSmokeMode()).toBe(false)
  })
})

describe('buildPlaybookHint', () => {
  test('uses a general workflow playbook, not an Elixir-specific one', () => {
    const hint = buildPlaybookHint('vibe workflow')

    expect(hint).toContain('Discuss the shape, user value, and ecosystem fit')
    expect(hint).toContain('list 7 next steps')
    expect(hint).not.toContain('Elixir')
    expect(hint).not.toContain('Igniter')
  })
})

describe('buildTutorPrompt', () => {
  test('defaults to a newcomer-friendly /next lesson', () => {
    const prompt = buildTutorPrompt('', '/tmp/example-project')

    expect(prompt).toContain("using this Pi setup in Dan's style")
    expect(prompt).toContain('Focus: /next')
    expect(prompt).toContain('Keep it newcomer-friendly')
    expect(prompt).toContain('Do not show internal scaffolding')
    expect(prompt).not.toContain('Dan-style playbook to teach')
  })

  test('includes the focus and stays read-only', () => {
    const prompt = buildTutorPrompt('quote shortcut', '/tmp/example-project')

    expect(prompt).toContain('Focus: quote shortcut')
    expect(prompt).toContain('Do not edit files')
    expect(prompt).toContain('Try this now')
  })
})
