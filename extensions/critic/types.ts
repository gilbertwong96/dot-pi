import type { ToolStatusDetails } from '../shared/tool-details'
import type { CriticVerdictStatus } from './verdict'

export interface CriticResult {
  critique: string
  approved: boolean
  status?: CriticVerdictStatus
  model?: string
  usage?: {
    input: number
    output: number
    cost: number
  }
  error?: string
  timedOut?: boolean
  durationMs?: number
}

export interface CriticDetails extends ToolStatusDetails {
  result: CriticResult
  context: string
}
