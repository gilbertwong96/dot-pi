import { describe, expect, test } from 'bun:test'

import { parseCriticJsonEvent } from './runner-events'

describe('parseCriticJsonEvent', () => {
  test('ignores malformed and irrelevant lines', () => {
    expect(parseCriticJsonEvent('not json')).toBeUndefined()
    expect(parseCriticJsonEvent(JSON.stringify({ type: 'other' }))).toBeUndefined()
  })

  test('extracts assistant critique metadata', () => {
    expect(
      parseCriticJsonEvent(
        JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            model: 'model-a',
            content: [{ type: 'text', text: 'review' }],
            usage: { input: 1, output: 2, cost: { total: 0.3 } }
          }
        })
      )
    ).toMatchObject({
      critique: 'review',
      model: 'model-a',
      usage: { input: 1, output: 2, cost: 0.3 }
    })
  })

  test('extracts error events', () => {
    expect(parseCriticJsonEvent(JSON.stringify({ type: 'error', message: 'bad' }))).toEqual({
      error: 'bad'
    })
  })
})
