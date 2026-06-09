import { describe, expect, test } from 'bun:test'
import { buildTutorPrompt, isTutorSmokeMode, tutorWorkspaceFor } from './tutor'

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

describe('buildTutorPrompt', () => {
  test('defaults to a newcomer-friendly /next lesson', () => {
    const prompt = buildTutorPrompt('', '/tmp/example-project')

    expect(prompt).toContain("using this Pi setup in Dannote's style")
    expect(prompt).toContain('Focus: /next')
    expect(prompt).toContain('Keep it newcomer-friendly')
    expect(prompt).toContain('Do not show internal scaffolding')
  })

  test('includes the focus and stays read-only', () => {
    const prompt = buildTutorPrompt('quote shortcut', '/tmp/example-project')

    expect(prompt).toContain('Focus: quote shortcut')
    expect(prompt).toContain('Do not edit files')
    expect(prompt).toContain('Try this now')
  })
})
