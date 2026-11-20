import { describe, expect, test } from 'vitest'

import { goThinkingLevelMap, knownGoModels, parseGoCatalog } from './provider-commandcode-go'

/** A `/provider/v1/models?view=client` row, the shape pi never sees directly. */
function goRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'deepseek/deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash (latest)',
    object: 'model',
    context_length: 1_000_000,
    minimumPlan: 'individual-go',
    reasoningEfforts: ['off', 'low', 'high', 'max'],
    inputModalities: ['text', 'image'],
    maxOutputTokens: null,
    display: { label: 'DeepSeek V4.1 Flash', group: 'Open Source' },
    pricing: { inputCost: 0.15, outputCost: 0.6, cacheReadCost: 0.003 },
    ...over
  }
}

describe('parseGoCatalog', () => {
  test('keeps only individual-go rows', () => {
    const models = parseGoCatalog({
      data: [
        goRow(),
        goRow({ id: 'claude-fable-5-2', minimumPlan: 'individual-provider' }),
        goRow({ id: 'gpt-5.4', minimumPlan: 'individual-pro' })
      ]
    })

    expect(models.map((model) => model.id)).toEqual(['deepseek/deepseek-v4.1-flash'])
  })

  test('maps the gateway efforts onto pi thinking levels and flags the model as reasoning', () => {
    const [model] = parseGoCatalog({ data: [goRow()] })

    expect(model.reasoning).toBe(true)
    expect(model.thinkingLevelMap).toEqual({
      off: 'off',
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max'
    })
    expect(model.compat).toEqual({ supportsReasoningEffort: true })
  })

  test('keeps a model with no declared efforts out of the reasoning path', () => {
    const [model] = parseGoCatalog({ data: [goRow({ reasoningEfforts: [] })] })

    expect(model.reasoning).toBe(false)
    expect(model.thinkingLevelMap).toBeUndefined()
    expect(model.compat).toBeUndefined()
  })

  test('strips api/baseUrl and zeroes cost so every model rides the custom stream', () => {
    const [model] = parseGoCatalog({ data: [goRow({ id: 'gpt-6-luna' })] })

    expect(model.api).toBeUndefined()
    expect(model.baseUrl).toBeUndefined()
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })

  test('drops unsupported input modalities and takes the upstream output cap when it reports one', () => {
    const [reported] = parseGoCatalog({
      data: [goRow({ inputModalities: ['text', 'image', 'file'], maxOutputTokens: 65_536 })]
    })
    expect(reported.input).toEqual(['text', 'image'])
    expect(reported.maxTokens).toBe(65_536)

    const [measured] = parseGoCatalog({ data: [goRow()] })
    expect(measured.maxTokens).toBe(393_216)
  })

  test('ignores rows without an id, a name or a numeric context_length', () => {
    const models = parseGoCatalog({
      data: [
        goRow({ id: undefined }),
        goRow({ name: undefined }),
        goRow({ context_length: '1M' }),
        goRow({ minimumPlan: undefined })
      ]
    })

    expect(models).toEqual([])
  })

  test('tolerates a body that is not a catalog', () => {
    expect(parseGoCatalog(null)).toEqual([])
    expect(parseGoCatalog({ data: 'nope' })).toEqual([])
  })
})

describe('goThinkingLevelMap', () => {
  test('maps every declared effort to itself and leaves the rest unsupported', () => {
    expect(goThinkingLevelMap(['high', 'max'])).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max'
    })
  })
})

describe('knownGoModels', () => {
  test('serves the baked snapshot with unique ids and no provider routing', () => {
    const models = knownGoModels()

    expect(models.length).toBeGreaterThan(0)
    expect(new Set(models.map((model) => model.id)).size).toBe(models.length)
    expect(models.every((model) => model.api === undefined && model.baseUrl === undefined)).toBe(
      true
    )
    expect(models.every((model) => model.cost.input === 0)).toBe(true)
    expect(models.some((model) => model.id.startsWith('deepseek/'))).toBe(true)
  })
})
