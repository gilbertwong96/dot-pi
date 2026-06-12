import { describe, expect, test } from 'bun:test'

import { buildExaSearchRequest } from './index'

describe('buildExaSearchRequest', () => {
  test('uses current Exa search and contents parameters', () => {
    expect(
      buildExaSearchRequest({
        query: 'current ai news',
        type: 'deep-reasoning',
        highlights: true,
        maxAgeHours: 0,
        moderation: true,
        systemPrompt: 'cite sources',
        outputSchema: { type: 'object', properties: { answer: { type: 'string' } } }
      })
    ).toMatchObject({
      query: 'current ai news',
      type: 'deep-reasoning',
      moderation: true,
      systemPrompt: 'cite sources',
      outputSchema: { type: 'object' },
      contents: {
        text: { maxCharacters: 10000 },
        highlights: true,
        maxAgeHours: 0
      }
    })
  })

  test('drops filters unsupported by people search', () => {
    expect(
      buildExaSearchRequest({
        query: 'founders',
        category: 'people',
        includeDomains: ['linkedin.com'],
        excludeDomains: ['example.com'],
        startPublishedDate: '2026-01-01T00:00:00.000Z',
        endPublishedDate: '2026-02-01T00:00:00.000Z'
      })
    ).toMatchObject({
      category: 'people',
      includeDomains: ['linkedin.com']
    })

    const request = buildExaSearchRequest({ query: 'founders', category: 'people' })
    expect(request).not.toHaveProperty('excludeDomains')
    expect(request).not.toHaveProperty('startPublishedDate')
    expect(request).not.toHaveProperty('endPublishedDate')
  })
})
