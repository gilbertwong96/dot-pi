import { describe, expect, test } from 'vitest'
import { buildBackgroundSystemPrompt, normalizeProjectDir } from './background'

describe('normalizeProjectDir', () => {
  test('falls back to process cwd', () => {
    expect(normalizeProjectDir()).toBe(process.cwd())
  })

  test('keeps explicit project dir', () => {
    expect(normalizeProjectDir('/tmp/project')).toBe('/tmp/project')
  })
})

describe('buildBackgroundSystemPrompt', () => {
  test('adds a concise background-start hint', () => {
    expect(buildBackgroundSystemPrompt('base')).toBe(
      'base\n\nUse background-start, not bash, for long-running dev servers/watchers.'
    )
  })

  test('does not duplicate the hint', () => {
    const once = buildBackgroundSystemPrompt('base')
    expect(buildBackgroundSystemPrompt(once)).toBe(once)
  })
})
