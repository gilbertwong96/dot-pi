import { SessionManager } from '@earendil-works/pi-coding-agent'
const session = SessionManager.create(process.cwd(), '/tmp/dot-pi-interactive-smoke-sessions')
const text =
  'BadMapError: expected a map\n  nil\n    lib/example.ex:4\n' + 'source preview '.repeat(30)
for (let i = 0; i < 3; i++) {
  session.appendMessage({
    role: 'assistant',
    content: [
      {
        type: 'toolCall',
        id: `smoke-${i}`,
        name: 'background-logs',
        arguments: { name: 'fixture' }
      }
    ],
    api: 'openai-responses',
    provider: 'fixture',
    model: 'fixture',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'toolUse',
    timestamp: Date.now()
  })
  session.appendMessage({
    role: 'toolResult',
    toolCallId: `smoke-${i}`,
    toolName: 'background-logs',
    content: [{ type: 'text', text }],
    details: i === 1 ? undefined : { name: 'fixture', logs: text },
    isError: i === 1,
    timestamp: Date.now()
  })
}
console.log(session.getSessionFile())
