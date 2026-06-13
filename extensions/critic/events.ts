import type { TextContent } from '@earendil-works/pi-ai'
import { isRecord } from '../shared/json'

export interface ThinkingContent {
  type: 'thinking'
  thinking: string
}

export interface UsageSummary {
  input: number
  output: number
  cost: number
}

export function isThinkingContent(content: unknown): content is ThinkingContent {
  return isRecord(content) && content.type === 'thinking'
}

export function textContentFromUnknown(content: unknown): TextContent | undefined {
  if (!Array.isArray(content)) return undefined
  return content.find(
    (candidate): candidate is TextContent => isRecord(candidate) && candidate.type === 'text'
  )
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  return typeof value === 'number' ? value : 0
}

export function usageFromUnknown(usage: unknown): UsageSummary | undefined {
  if (!isRecord(usage)) return undefined
  const cost = isRecord(usage.cost) ? numberField(usage.cost, 'total') : 0
  return {
    input: numberField(usage, 'input'),
    output: numberField(usage, 'output'),
    cost
  }
}

export function errorMessageFromEvent(event: Record<string, unknown>): string {
  return String(event.message ?? 'unknown error')
}
