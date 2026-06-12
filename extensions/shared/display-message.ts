import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ExtensionAPI, MessageRenderer } from '@earendil-works/pi-coding-agent'

export function filterDisplayOnlyMessages(
  messages: AgentMessage[],
  customType: string
): AgentMessage[] {
  return messages.filter(
    (message) => message.role !== 'custom' || message.customType !== customType
  )
}

export function registerDisplayOnlyMessage<T>(
  pi: ExtensionAPI,
  customType: string,
  renderer: MessageRenderer<T>
): (content: string, details: T) => void {
  pi.registerMessageRenderer<T>(customType, renderer)

  pi.on('context', (event) => ({ messages: filterDisplayOnlyMessages(event.messages, customType) }))

  return (content, details) => {
    pi.sendMessage<T>(
      {
        customType,
        content,
        display: true,
        details
      },
      { triggerTurn: false }
    )
  }
}
