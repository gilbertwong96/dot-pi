import {
  errorMessageFromEvent,
  isRecord,
  textContentFromUnknown,
  usageFromUnknown,
  type UsageSummary
} from './events'

export interface CriticEventState {
  critique?: string
  model?: string
  usage?: UsageSummary
  error?: string
  messageRole?: string
}

export function parseCriticJsonEvent(line: string): CriticEventState | undefined {
  if (!line.trim()) return undefined

  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    return undefined
  }

  if (!isRecord(event)) return undefined

  if (event.type === 'error') {
    return { error: errorMessageFromEvent(event) }
  }

  if (event.type !== 'message_end' || !isRecord(event.message)) return undefined
  const message = event.message
  const role = typeof message.role === 'string' ? message.role : undefined
  if (role !== 'assistant') return { messageRole: role }

  const state: CriticEventState = { messageRole: role }
  const textContent = textContentFromUnknown(message.content)
  if (textContent?.text) state.critique = textContent.text

  const usage = usageFromUnknown(message.usage)
  if (usage) state.usage = usage
  if (typeof message.model === 'string') state.model = message.model

  return state
}
