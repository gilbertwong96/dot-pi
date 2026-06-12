import { describe, expect, test } from 'bun:test'
import type { AgentMessage } from '@earendil-works/pi-agent-core'

import { buildOracleContext, DEFAULT_CONFIG } from './oracle'

function user(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }
}

function assistant(text: string): AgentMessage {
  return {
    role: 'assistant',
    provider: 'test',
    model: 'test',
    api: 'openai-completions',
    content: [
      { type: 'thinking', thinking: 'hidden reasoning' },
      { type: 'text', text },
      { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'echo expensive' } }
    ],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: Date.now()
  }
}

function toolResult(text: string): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'bash',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: Date.now()
  }
}

describe('buildOracleContext', () => {
  test('keeps latest compaction summary and current user request', () => {
    const messages: AgentMessage[] = [
      {
        role: 'compactionSummary',
        summary: 'older summary',
        tokensBefore: 50000,
        timestamp: Date.now()
      },
      user('previous request'),
      assistant('previous answer'),
      user('oracle request')
    ]

    const result = buildOracleContext(messages, DEFAULT_CONFIG)

    expect(result.map((message) => message.role)).toEqual([
      'compactionSummary',
      'user',
      'assistant',
      'user'
    ])
    expect(result[0]).toMatchObject({ role: 'compactionSummary', summary: 'older summary' })
    expect(result.at(-1)).toMatchObject({ role: 'user' })
  })

  test('drops thinking and tool results by default', () => {
    const result = buildOracleContext(
      [
        user('previous request'),
        assistant('previous answer'),
        toolResult('large output'),
        user('oracle request')
      ],
      DEFAULT_CONFIG
    )

    expect(result.some((message) => message.role === 'toolResult')).toBe(false)
    const keptAssistant = result.find((message) => message.role === 'assistant')
    expect(keptAssistant?.content.some((block) => block.type === 'thinking')).toBe(false)
  })
})
