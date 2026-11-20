import { describe, expect, test } from 'vitest'
import type { Message, Tool, Usage } from '@earendil-works/pi-ai'

import {
  buildGoRequest,
  goThinkingLevelMap,
  knownGoModels,
  parseGoCatalog,
  toWireMessages,
  toWireSystem,
  toWireTools,
  type GoRequestInput
} from './provider-commandcode-go'

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

// ---- shared fixtures for the request/stream tests -------------------------

function readTool(): Tool {
  return { name: 'read', description: 'read a file', parameters: { type: 'object' } }
}

function userText(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: 1 }
}

function systemMessageWithTools(options: { prompt: string; tools: Tool[] }): Message {
  return {
    role: 'system',
    content: options.prompt,
    toolsAdded: options.tools,
    timestamp: 1
  }
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
}

function baseInput(over: Partial<GoRequestInput> = {}): GoRequestInput {
  return {
    model: 'deepseek/deepseek-v4.1-flash',
    system: 'rules',
    messages: [userText('hi')],
    tools: [readTool()],
    maxTokens: 64_000,
    workingDir: '/repo',
    date: '2026-11-20',
    platform: 'darwin',
    structure: ['src'],
    ...over
  }
}

describe('wire conversion', () => {
  test('marks every system part but the last cacheable', () => {
    expect(toWireSystem('a\nb')).toEqual([
      { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'b' }
    ])
    expect(toWireSystem('')).toEqual([])
  })

  test('drops system messages, keeps image mimeType, echoes reasoning, joins tool results', () => {
    const wire = toWireMessages([
      systemMessageWithTools({ prompt: 'rules', tools: [readTool()] }),
      userText('look'),
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'a.ts' } }
        ],
        api: 'commandcode-alpha',
        provider: 'commandcode-go',
        model: 'm',
        usage: zeroUsage(),
        stopReason: 'toolUse',
        timestamp: 1
      },
      {
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'read',
        content: [
          { type: 'text', text: 'line 1' },
          { type: 'text', text: 'line 2' }
        ],
        isError: false,
        timestamp: 2
      }
    ])

    expect(wire[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'look' }] })
    expect(wire[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'hmm' },
        { type: 'tool-call', toolCallId: 'call_1', toolName: 'read', input: { path: 'a.ts' } }
      ]
    })
    expect(wire[2]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'read',
          output: { type: 'text', value: 'line 1\nline 2' }
        }
      ]
    })
  })

  test('reports failed tool results as error-text and images with mimeType', () => {
    const [user] = toWireMessages([
      {
        role: 'user',
        content: [{ type: 'image', data: 'AAA', mimeType: 'image/png' }],
        timestamp: 1
      }
    ])
    expect(user).toEqual({
      role: 'user',
      content: [{ type: 'image', image: 'data:image/png;base64,AAA', mimeType: 'image/png' }]
    })

    const [tool] = toWireMessages([
      {
        role: 'toolResult',
        toolCallId: 'c',
        toolName: 'bash',
        content: [{ type: 'text', text: 'boom' }],
        isError: true,
        timestamp: 2
      }
    ])
    expect(tool).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c',
          toolName: 'bash',
          output: { type: 'error-text', value: 'boom' }
        }
      ]
    })
  })

  test('merges consecutive tool results into one tool message', () => {
    const wire = toWireMessages([
      {
        role: 'toolResult',
        toolCallId: 'a',
        toolName: 'read',
        content: [{ type: 'text', text: 'x' }],
        isError: false,
        timestamp: 1
      },
      {
        role: 'toolResult',
        toolCallId: 'b',
        toolName: 'read',
        content: [{ type: 'text', text: 'y' }],
        isError: false,
        timestamp: 2
      }
    ])
    expect(wire).toHaveLength(1)
    expect(wire[0]).toMatchObject({ role: 'tool' })
    expect((wire[0] as { content: unknown[] }).content).toHaveLength(2)
  })

  test('sends tools with input_schema', () => {
    expect(toWireTools([readTool()])).toEqual([
      { name: 'read', description: 'read a file', input_schema: { type: 'object' } }
    ])
  })

  test('builds the CLI envelope with a neutral config and no undefined keys', () => {
    const body = buildGoRequest(
      baseInput({
        threadId: '9d1b8f2e-5f1a-4f1e-9f2a-2f1f4b1f0a11',
        reasoningEffort: 'high',
        temperature: 0.2
      })
    )

    expect(body.config).toEqual({
      workingDir: '/repo',
      date: '2026-11-20',
      environment: 'darwin',
      structure: ['src'],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: []
    })
    expect(body.memory).toBeNull()
    expect(body.taste).toBeNull()
    expect(body.skills).toBeNull()
    expect(body.permissionMode).toBe('standard')
    expect(body.params).toMatchObject({
      model: 'deepseek/deepseek-v4.1-flash',
      max_tokens: 64_000,
      stream: true,
      reasoning_effort: 'high',
      temperature: 0.2
    })
    expect(body.params.system).toEqual([{ type: 'text', text: 'rules' }])
    expect(JSON.stringify(body)).not.toContain('undefined')
  })

  test('omits a threadId that is not a UUID', () => {
    expect(buildGoRequest(baseInput({ threadId: 'not-a-uuid' })).threadId).toBeUndefined()
  })
})
