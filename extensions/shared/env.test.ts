import { afterEach, describe, expect, test } from 'bun:test'

import { optionalEnv, parseDelimitedEnvList, parseIntegerEnv, parseNumberEnv } from './env'

const ORIGINAL_ENV = { ...process.env }
const KEY = 'DOT_PI_SHARED_ENV_TEST'

afterEach(() => {
  if (ORIGINAL_ENV[KEY] === undefined) delete process.env[KEY]
  else process.env[KEY] = ORIGINAL_ENV[KEY]
})

describe('optionalEnv', () => {
  test('returns trimmed non-empty env values only', () => {
    process.env[KEY] = ' value '
    expect(optionalEnv(KEY)).toBe('value')

    process.env[KEY] = ' '
    expect(optionalEnv(KEY)).toBeUndefined()
  })
})

describe('parseNumberEnv', () => {
  test('parses optional numbers', () => {
    delete process.env[KEY]
    expect(parseNumberEnv(KEY)).toEqual({ ok: true })

    process.env[KEY] = '1.5'
    expect(parseNumberEnv(KEY)).toEqual({ ok: true, value: 1.5 })

    process.env[KEY] = 'nope'
    expect(parseNumberEnv(KEY)).toEqual({ ok: false, message: `${KEY} must be a number` })
  })
})

describe('parseIntegerEnv', () => {
  test('requires integer values', () => {
    process.env[KEY] = '2'
    expect(parseIntegerEnv(KEY)).toEqual({ ok: true, value: 2 })

    process.env[KEY] = '2.5'
    expect(parseIntegerEnv(KEY)).toEqual({ ok: false, message: `${KEY} must be an integer` })
  })
})

describe('parseDelimitedEnvList', () => {
  test('splits comma and newline lists', () => {
    process.env[KEY] = 'Pi, Scribe\nTypeScript'
    expect(parseDelimitedEnvList(KEY)).toEqual(['Pi', 'Scribe', 'TypeScript'])
  })
})
