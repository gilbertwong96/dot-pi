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
  test('defaults to Dannote Pi workflow instead of generic tutoring', () => {
    const prompt = buildTutorPrompt('', '/tmp/example-project')

    expect(prompt).toContain("Act as Dannote's Pi workflow tutor")
    expect(prompt).toContain("default mission: learn Dannote's Pi workflow style")
    expect(prompt).toContain('do not block on interviews')
    expect(prompt).toContain('/next, /next big N, /recap, /discuss, /quote, /gaa, /nobc')
  })

  test('includes the focus and stays read-only', () => {
    const prompt = buildTutorPrompt('quote shortcut', '/tmp/example-project')

    expect(prompt).toContain("today's Pi workflow lesson: quote shortcut")
    expect(prompt).toContain('Stay advisory/read-only')
    expect(prompt).toContain('One exercise/check')
  })
})
