export function parseSseJson<T>(body: string): T | undefined {
  if (!body.trim()) return undefined

  if (body.trimStart().startsWith('{')) return JSON.parse(body) as T

  let eventData: string[] = []

  const flush = () => {
    if (eventData.length === 0) return undefined

    const payload = eventData.join('\n').trim()
    eventData = []

    if (!payload || payload === '[DONE]') return undefined

    try {
      return JSON.parse(payload) as T
    } catch {
      return undefined
    }
  }

  for (const line of body.replace(/\r\n/gu, '\n').split('\n')) {
    if (line === '') {
      const parsed = flush()
      if (parsed !== undefined) return parsed
      continue
    }

    if (line.startsWith(':') || line.startsWith('event:') || line.startsWith('id:')) continue

    if (line.startsWith('data:')) {
      const value = line.startsWith('data: ') ? line.slice(6) : line.slice(5)
      eventData.push(value)
    }
  }

  return flush()
}
