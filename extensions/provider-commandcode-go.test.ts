import { afterEach, describe, expect, test } from 'vitest'
import {
  normalizeContext,
  type Api,
  type Message,
  type Model,
  type RefreshModelsContext,
  type Tool,
  type TranscriptContext,
  type Usage
} from '@earendil-works/pi-ai'
import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent'

import { makeRefreshContext } from './shared/refresh-models-harness'

import commandcodeGo, {
  buildGoRequest,
  goThinkingLevelMap,
  knownGoModels,
  parseGoCatalog,
  readNdjson,
  refreshCommandCodeGoCatalog,
  streamCommandCodeGo,
  toWireMessages,
  toWireSystem,
  toWireTools,
  type GoRequestInput,
  type GoRequestBody
} from './provider-commandcode-go'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

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

// ---- stream fixtures ------------------------------------------------------

function streamFrom(text: string, chunkSize = Number.MAX_SAFE_INTEGER): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += chunkSize) {
        controller.enqueue(bytes.slice(index, index + chunkSize))
      }
      controller.close()
    }
  })
}

function ndjson(lines: string[]): string {
  return `${lines.join('\n')}\n`
}

function testModel(over: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: 'deepseek/deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    api: 'commandcode-alpha',
    provider: 'commandcode-go',
    baseUrl: 'https://api.commandcode.ai',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 393_216,
    reasoning: true,
    ...over
  } as Model<Api>
}

function transcript(prompt: string, tools: Tool[] = []): TranscriptContext {
  return normalizeContext({ systemPrompt: prompt, tools, messages: [userText('hi')] })
}

interface StubOptions {
  onRequest?: (init: { headers: Record<string, string>; body: string }) => void
}

function stubGenerate(lines: string[], options: StubOptions = {}): void {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    options.onRequest?.({
      headers: init?.headers as Record<string, string>,
      body: String(init?.body ?? '{}')
    })
    return new Response(ndjson(lines), {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' }
    })
  }) as typeof fetch
}

function stubStatus(status: number, body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    })) as typeof fetch
}

describe('readNdjson', () => {
  test('skips junk and blank lines and flushes a final line without a newline', async () => {
    const events: unknown[] = []
    for await (const event of readNdjson(streamFrom('{"a":1}\r\nnot json\n\n{"a":2}'))) {
      events.push(event)
    }
    expect(events).toEqual([{ a: 1 }, { a: 2 }])
  })

  test('reassembles a JSON line split across chunks and keeps multibyte text intact', async () => {
    const events: unknown[] = []
    const text = ndjson(['{"type":"text-delta","text":"你好，世界"}'])
    for await (const event of readNdjson(streamFrom(text, 3))) events.push(event)
    expect(events).toEqual([{ type: 'text-delta', text: '你好，世界' }])
  })
})

describe('streamCommandCodeGo text and usage', () => {
  test('streams reasoning and text without requiring start events', async () => {
    stubGenerate([
      '{"type":"reasoning-delta","text":"thinking"}',
      '{"type":"text-delta","text":"hel"}',
      '{"type":"text-delta","text":"lo"}',
      '{"type":"finish","finishReason":"end_turn","totalUsage":{"inputTokens":120,"outputTokens":7,"inputTokenDetails":{"cacheReadTokens":100,"cacheWriteTokens":5}}}'
    ])

    const message = await streamCommandCodeGo(testModel(), transcript('hi'), {
      apiKey: 'user_test'
    }).result()

    expect(message.content).toEqual([
      { type: 'thinking', thinking: 'thinking' },
      { type: 'text', text: 'hello' }
    ])
    expect(message.usage).toMatchObject({
      input: 20,
      output: 7,
      cacheRead: 100,
      cacheWrite: 5,
      totalTokens: 132
    })
    expect(message.usage.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0
    })
    expect(message.stopReason).toBe('stop')
  })

  test('ignores unknown events and tolerates explicit start/end events', async () => {
    stubGenerate([
      '{"type":"start"}',
      '{"type":"start-step"}',
      '{"type":"text-start","id":"txt-0"}',
      '{"type":"text-delta","id":"txt-0","text":"ok"}',
      '{"type":"text-end","id":"txt-0"}',
      '{"type":"provider-metadata","x":1}',
      '{"type":"finish","finishReason":"end_turn"}'
    ])

    const message = await streamCommandCodeGo(testModel(), transcript('hi'), {
      apiKey: 'user_test'
    }).result()

    expect(message.content).toEqual([{ type: 'text', text: 'ok' }])
    expect(message.usage).toMatchObject({ input: 0, output: 0, totalTokens: 0 })
  })

  test('maps the gateway finish reasons onto pi stop reasons', async () => {
    const stop = async (finishReason: string) => {
      stubGenerate([`{"type":"finish","finishReason":"${finishReason}"}`])
      return (
        await streamCommandCodeGo(testModel(), transcript('hi'), { apiKey: 'user_test' }).result()
      ).stopReason
    }

    expect(await stop('end_turn')).toBe('stop')
    expect(await stop('max_tokens')).toBe('length')
    expect(await stop('length')).toBe('length')
    expect(await stop('tool_calls')).toBe('toolUse')
  })

  test('surfaces a refusal as an error instead of a silent stop', async () => {
    stubGenerate([
      '{"type":"text-delta","text":"I cannot"}',
      '{"type":"finish","finishReason":"refusal"}'
    ])

    const message = await streamCommandCodeGo(testModel(), transcript('hi'), {
      apiKey: 'user_test'
    }).result()

    expect(message.stopReason).toBe('error')
    expect(message.errorMessage).toMatch(/refus/i)
  })

  test('fails a stream that ends before finish, with wording pi will not retry', async () => {
    stubGenerate(['{"type":"text-delta","text":"partial"}'])

    const message = await streamCommandCodeGo(testModel(), transcript('hi'), {
      apiKey: 'user_test'
    }).result()

    expect(message.stopReason).toBe('error')
    expect(message.errorMessage).toMatch(/stream interrupted after content started/i)
    expect(message.errorMessage).not.toMatch(/429|500|502|503|504|rate.?limit|server.?error/i)
  })
})

describe('streamCommandCodeGo tool calls and plumbing', () => {
  test('emits one toolcall block per call from both the tool-call and the tool-input-* shapes', async () => {
    stubGenerate([
      '{"type":"tool-input-start","id":"call_a","toolName":"read"}',
      '{"type":"tool-input-delta","id":"call_a","delta":"{\\"path\\":"}',
      '{"type":"tool-input-delta","id":"call_a","delta":"\\"a.ts\\"}"}',
      '{"type":"tool-input-end","id":"call_a"}',
      '{"type":"tool-call","toolCallId":"call_b","toolName":"bash","input":{"command":"ls"}}',
      '{"type":"finish","finishReason":"tool_calls"}'
    ])

    const message = await streamCommandCodeGo(testModel(), transcript('go'), {
      apiKey: 'user_test'
    }).result()

    expect(message.content).toEqual([
      { type: 'toolCall', id: 'call_a', name: 'read', arguments: { path: 'a.ts' } },
      { type: 'toolCall', id: 'call_b', name: 'bash', arguments: { command: 'ls' } }
    ])
    expect(message.stopReason).toBe('toolUse')
  })

  test('routes the system prompt and the tool declarations found in the transcript', async () => {
    let body: GoRequestBody | undefined
    stubGenerate(['{"type":"finish","finishReason":"end_turn"}'], {
      onRequest: (init) => {
        body = JSON.parse(init.body) as GoRequestBody
      }
    })

    await streamCommandCodeGo(testModel(), transcript('rules\nmore', [readTool()]), {
      apiKey: 'user_test'
    }).result()

    expect(body?.params.system).toEqual([
      { type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'more' }
    ])
    expect(body?.params.tools).toEqual([
      { name: 'read', description: 'read a file', input_schema: { type: 'object' } }
    ])
  })

  test('sends the CLI headers and honours onPayload, onResponse and onProviderStreamEvent', async () => {
    let headers: Record<string, string> | undefined
    let body: unknown
    let responseSeen = false
    const streamEvents: unknown[] = []
    stubGenerate(
      ['{"type":"text-delta","text":"x"}', '{"type":"finish","finishReason":"end_turn"}'],
      {
        onRequest: (init) => {
          headers = init.headers
          body = JSON.parse(init.body)
        }
      }
    )

    await streamCommandCodeGo(testModel(), transcript('hi'), {
      apiKey: 'user_test',
      sessionId: '9d1b8f2e-5f1a-4f1e-9f2a-2f1f4b1f0a11',
      onPayload: () => ({ replaced: true }),
      onResponse: () => {
        responseSeen = true
      },
      onProviderStreamEvent: (event) => {
        streamEvents.push(event)
      }
    }).result()

    expect(headers).toMatchObject({
      authorization: 'Bearer user_test',
      'x-command-code-version': '1.91.1',
      'x-cli-environment': 'production',
      'x-cli-surface': 'cli',
      accept: 'application/x-ndjson',
      'x-session-id': '9d1b8f2e-5f1a-4f1e-9f2a-2f1f4b1f0a11'
    })
    expect(body).toEqual({ replaced: true })
    expect(responseSeen).toBe(true)
    expect(streamEvents).toHaveLength(2)
  })

  test('maps the requested thinking level through thinkingLevelMap and skips unmapped levels', async () => {
    const seen: (string | undefined)[] = []
    const model = testModel({
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: null,
        medium: null,
        high: 'high',
        xhigh: null,
        max: 'max'
      }
    })
    const capture = () =>
      stubGenerate(['{"type":"finish","finishReason":"end_turn"}'], {
        onRequest: (init) => {
          seen.push((JSON.parse(init.body) as GoRequestBody).params.reasoning_effort)
        }
      })

    capture()
    await streamCommandCodeGo(model, transcript('hi'), { apiKey: 'k', reasoning: 'high' }).result()
    capture()
    await streamCommandCodeGo(model, transcript('hi'), { apiKey: 'k', reasoning: 'off' }).result()
    capture()
    await streamCommandCodeGo(model, transcript('hi'), {
      apiKey: 'k',
      reasoning: 'medium'
    }).result()

    expect(seen).toEqual(['high', undefined, undefined])
  })

  test('a 403 that names the CLI version says so', async () => {
    stubStatus(403, {
      error: {
        code: 'upgrade_required',
        message: 'Your Command Code CLI is out of date. Run `cmd update`. minVersion 0.18.10'
      }
    })

    const message = await streamCommandCodeGo(testModel(), transcript('hi'), {
      apiKey: 'user_test'
    }).result()

    expect(message.stopReason).toBe('error')
    expect(message.errorMessage).toContain('client version rejected')
    expect(message.errorMessage).toContain('COMMANDCODE_GO_VERSION')
  })

  test('a wire abort event stops the stream as aborted', async () => {
    stubGenerate(['{"type":"text-delta","text":"half"}', '{"type":"abort"}'])

    const message = await streamCommandCodeGo(testModel(), transcript('hi'), {
      apiKey: 'user_test'
    }).result()

    expect(message.stopReason).toBe('aborted')
    expect(message.content).toEqual([{ type: 'text', text: 'half' }])
  })

  test('an already-aborted signal never reaches the network', async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return new Response('')
    }) as typeof fetch
    const controller = new AbortController()
    controller.abort()

    const message = await streamCommandCodeGo(testModel(), transcript('hi'), {
      apiKey: 'user_test',
      signal: controller.signal
    }).result()

    expect(called).toBe(false)
    expect(message.stopReason).toBe('aborted')
  })
})

// ---- registration and catalog refresh -------------------------------------

function captureProviderConfig(): ProviderConfig {
  let captured: ProviderConfig | undefined
  const pi = {
    registerProvider: (_id: string, config: ProviderConfig) => {
      captured = config
    },
    on: () => () => undefined
  } as unknown as ExtensionAPI
  commandcodeGo(pi)
  if (!captured) throw new Error('commandcode-go did not register a provider')
  return captured
}

function stubClientCatalog(rows: Record<string, unknown>[]): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: rows }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })) as typeof fetch
}

describe('commandcode-go registration', () => {
  test('registers the custom api, the pinned key env var and the baked models', () => {
    const config = captureProviderConfig()

    expect(config.api).toBe('commandcode-alpha')
    expect(config.apiKey).toBe('$COMMANDCODE_API_KEY')
    expect(config.baseUrl).toBe('https://api.commandcode.ai')
    expect(config.models?.map((model) => model.id)).toEqual(
      knownGoModels().map((model) => model.id)
    )
    expect(config.models?.every((model) => model.api === undefined)).toBe(true)
  })
})

describe('refreshCommandCodeGoCatalog', () => {
  test('keeps the baked catalog inside the refresh cooldown', async () => {
    const { context, persisted } = makeRefreshContext({
      stored: { checkedAt: Date.now(), models: [] }
    })

    expect(await refreshCommandCodeGoCatalog(context)).toEqual(knownGoModels())
    expect(persisted).toEqual([])
  })

  test('publishes a fresh catalog filtered to the Go plan', async () => {
    stubClientCatalog([
      goRow(),
      goRow({ id: 'claude-fable-5-2', minimumPlan: 'individual-provider' })
    ])
    const { context, persisted } = makeRefreshContext({ credential: { type: 'api_key', key: 'k' } })

    const models = await refreshCommandCodeGoCatalog(context)

    expect(models.map((model) => model.id)).toEqual(['deepseek/deepseek-v4.1-flash'])
    expect(persisted[0].models[0]).toMatchObject({
      provider: 'commandcode-go',
      api: 'commandcode-alpha',
      baseUrl: 'https://api.commandcode.ai'
    })
  })

  test('keeps the baked catalog when the account can run none of the Go models', async () => {
    stubClientCatalog([goRow({ minimumPlan: 'individual-pro' })])
    const { context, persisted } = makeRefreshContext({ credential: { type: 'api_key', key: 'k' } })

    expect(await refreshCommandCodeGoCatalog(context)).toEqual(knownGoModels())
    expect(persisted).toEqual([])
  })

  test('keeps the baked catalog when the fetch fails', async () => {
    globalThis.fetch = (async () => {
      throw new Error('offline')
    }) as typeof fetch
    const { context, persisted } = makeRefreshContext({ credential: { type: 'api_key', key: 'k' } })

    expect(await refreshCommandCodeGoCatalog(context)).toEqual(knownGoModels())
    expect(persisted).toEqual([])
  })

  test('refreshes without a network in the cache-only phase', async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return new Response('{}')
    }) as typeof fetch
    const { context } = makeRefreshContext({
      allowNetwork: false,
      credential: { type: 'api_key', key: 'k' }
    })

    expect(await refreshCommandCodeGoCatalog(context)).toEqual(knownGoModels())
    expect(called).toBe(false)
  })
})
