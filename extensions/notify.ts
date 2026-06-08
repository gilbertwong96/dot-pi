/**
 * Desktop Notification Extension
 *
 * Sends native desktop notifications when the agent needs attention or finishes.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { notifyDesktop } from './shared/desktop-notify'
import { formatPiNotificationTitle } from './shared/project-name'

type StopInfo = {
  stopReason?: string
  errorMessage?: string
}

export default function (pi: ExtensionAPI) {
  let toolsCalled = new Set<string>()
  let currentPrompt = ''

  pi.on('before_agent_start', (event) => {
    currentPrompt = summarize(event.prompt)
  })

  pi.on('agent_start', () => {
    toolsCalled = new Set()
  })

  pi.on('tool_call', (event) => {
    toolsCalled.add(event.toolName)
  })

  pi.on('agent_end', async (event, ctx) => {
    const lastMessage = event.messages[event.messages.length - 1]
    const { stopReason, errorMessage } = getStopInfo(lastMessage)
    const title = formatPiNotificationTitle(ctx.cwd)

    if (stopReason === 'error') {
      notifyDesktop(title, `Error: ${summarize(errorMessage || 'Unknown error')}`)
      return
    }

    if (stopReason === 'aborted') return

    notifyDesktop(title, getNotificationBody(toolsCalled, currentPrompt))
  })
}

function getStopInfo(message: AgentMessage | undefined): StopInfo {
  if (!message || typeof message !== 'object') return {}

  const maybeStop = message as StopInfo
  return {
    stopReason: maybeStop.stopReason,
    errorMessage: maybeStop.errorMessage
  }
}

function getNotificationBody(tools: Set<string>, prompt: string): string {
  const action = tools.has('question') ? 'Waiting for your choice' : getActionSummary(tools)
  return prompt ? `${action}: ${prompt}` : action
}

function getActionSummary(tools: Set<string>): string {
  if (tools.has('edit') || tools.has('write')) return 'Finished editing'
  if (tools.has('bash')) return 'Finished running commands'
  if (tools.has('read') || tools.has('grep') || tools.has('find') || tools.has('ls')) {
    return 'Finished inspecting'
  }
  return 'Task completed'
}

function summarize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 80)
}
