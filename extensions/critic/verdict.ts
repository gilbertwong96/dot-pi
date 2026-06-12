export type CriticVerdictStatus = 'APPROVED' | 'NEEDS_WORK' | 'BLOCKED'

export interface ParsedCriticVerdict {
  critique: string
  status: CriticVerdictStatus
  approved: boolean
  hasVerdictBlock: boolean
}

const VERDICT_BLOCK =
  /<critic_verdict>\s*status:\s*(APPROVED|NEEDS_WORK|BLOCKED)\s*<\/critic_verdict>/i
const VERDICT_BLOCK_ANY = /<critic_verdict>[\s\S]*<\/critic_verdict>/i

export function parseCriticVerdict(critique: string): ParsedCriticVerdict {
  const verdictMatch = critique.match(VERDICT_BLOCK)
  const status = verdictMatch
    ? (verdictMatch[1].toUpperCase() as CriticVerdictStatus)
    : 'NEEDS_WORK'

  return {
    critique: verdictMatch ? critique.replace(VERDICT_BLOCK_ANY, '').trim() : critique,
    status,
    approved: status === 'APPROVED',
    hasVerdictBlock: Boolean(verdictMatch)
  }
}
