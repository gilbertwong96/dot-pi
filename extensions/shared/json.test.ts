import { describe, expect, test } from 'vitest'

import { isRecord, parseJson, parseJsonObject, parseJsoncObject } from './json'

describe('json helpers', () => {
  test('identifies plain records', () => {
    expect(isRecord({ ok: true })).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
  })

  test('parses JSON safely', () => {
    expect(parseJson<{ ok: boolean }>('{"ok":true}')).toEqual({ ok: true })
    expect(parseJson('{bad')).toBeUndefined()
  })

  test('returns objects only for object helpers', () => {
    expect(parseJsonObject('{"ok":true}')).toEqual({ ok: true })
    expect(parseJsonObject('[1,2]')).toBeUndefined()
  })

  test('parses JSONC object content', () => {
    expect(parseJsoncObject('{ // comment\n "ok": true }')).toEqual({ ok: true })
    expect(parseJsoncObject('[1,2]')).toBeUndefined()
  })
})
