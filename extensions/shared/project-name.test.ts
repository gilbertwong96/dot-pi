import { describe, expect, test } from 'bun:test'
import { formatPiNotificationTitle, formatProjectName } from './project-name'

describe('formatProjectName', () => {
  test('uses basename only', () => {
    expect(formatProjectName('/Users/me/Development/dot-pi')).toBe('dot-pi')
  })

  test('truncates long project names', () => {
    expect(formatProjectName('/tmp/abcdefghijklmnopqrstuvwxyz0123456789', 10)).toBe('abcdefghi…')
  })
})

describe('formatPiNotificationTitle', () => {
  test('uses pi symbol and project name', () => {
    expect(formatPiNotificationTitle('/tmp/dot-pi')).toBe('π · dot-pi')
  })
})
