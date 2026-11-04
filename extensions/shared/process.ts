export interface CommandOutput {
  code?: number | null
  stdout?: string
  stderr?: string
  truncated?: boolean
}

export function commandOutput(result: CommandOutput, fallback = 'Unknown error'): string {
  return result.stderr?.trim() || result.stdout?.trim() || fallback
}

export function commandFailure(result: CommandOutput, action: string): string {
  if (result.truncated) return `${action}: output exceeded the limit and was truncated`
  const output = commandOutput(result)
  const code = result.code === undefined || result.code === null ? '' : ` (exit ${result.code})`
  return `${action}${code}: ${output}`
}

export function throwIfTruncated(result: CommandOutput, action: string): void {
  if (result.truncated) throw new Error(commandFailure(result, action))
}
