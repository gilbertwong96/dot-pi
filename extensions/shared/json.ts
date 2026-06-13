import { parse as parseJsonc } from 'jsonc-parser'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseJson<T = unknown>(content: string): T | undefined {
  try {
    return JSON.parse(content) as T
  } catch {
    return undefined
  }
}

export function parseJsonObject(content: string): Record<string, unknown> | undefined {
  const parsed = parseJson(content)
  return isRecord(parsed) ? parsed : undefined
}

export function parseJsoncObject(content: string): Record<string, unknown> | undefined {
  try {
    const parsed = parseJsonc(content)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}
