import { fetchJson } from './http'

export interface NormalizedOpenAIModel {
  id: string
  name: string
  context_length?: number
}

export interface FetchOpenAIModelsOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

interface RemoteOpenAIModelEntry {
  id?: unknown
  name?: unknown
  context_length?: unknown
}

interface RemoteOpenAIModelsResponse {
  data?: unknown
}

const DEFAULT_TIMEOUT_MS = 15_000

export async function fetchOpenAIModels(
  baseUrl: string,
  apiKey: string,
  options: FetchOpenAIModelsOptions = {}
): Promise<NormalizedOpenAIModel[]> {
  const url = `${baseUrl.replace(/\/+$/u, '')}/models`
  const result = await fetchJson<RemoteOpenAIModelsResponse>(
    url,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    { signal: options.signal, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS }
  )

  if (!result.ok) {
    throw new Error(`OpenAI-compatible /models request failed with status ${result.status}`)
  }

  const data = result.data?.data
  if (!Array.isArray(data)) return []

  return data
    .filter((entry): entry is RemoteOpenAIModelEntry => typeof entry === 'object' && entry !== null)
    .map((entry) => normalizeEntry(entry))
    .filter((entry): entry is NormalizedOpenAIModel => entry !== null)
}

function normalizeEntry(entry: RemoteOpenAIModelEntry): NormalizedOpenAIModel | null {
  if (typeof entry.id !== 'string' || entry.id.length === 0) return null
  const name = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : entry.id
  const normalized: NormalizedOpenAIModel = { id: entry.id, name }
  if (typeof entry.context_length === 'number') {
    normalized.context_length = entry.context_length
  }
  return normalized
}
