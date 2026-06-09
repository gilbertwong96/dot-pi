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
  test('is an in-place workflow hint, not a generic lesson', () => {
    const prompt = buildTutorPrompt('', '/tmp/example-project')

    expect(prompt).toContain('in-place Dan-style workflow hint')
    expect(prompt).toContain('Use the current conversation as evidence')
    expect(prompt).toContain('Do not give a generic lesson')
    expect(prompt).toContain('What Dan would notice')
    expect(prompt).toContain('What he would ask Pi')
  })

  test('handles realistic build tasks and stays read-only', () => {
    const prompt = buildTutorPrompt('building a web app', '/tmp/example-project')

    expect(prompt).toContain('Focus: building a web app')
    expect(prompt).toContain('smallest useful slice')
    expect(prompt).toContain('Stay advisory/read-only')
    expect(prompt).toContain('Do not edit files')
  })
})
