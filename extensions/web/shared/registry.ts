import { exaSearchBackend } from '../backends/exa-search'
import type { SearchBackendId, WebSearchBackend } from './types'

const searchBackends = {
  exa: exaSearchBackend
} satisfies Record<SearchBackendId, WebSearchBackend<SearchBackendId>>

export function getSearchBackend<Id extends SearchBackendId>(id: Id): WebSearchBackend<Id> {
  const backend = searchBackends[id]
  if (!backend) throw new Error(`Unknown web search backend: ${id}`)
  return backend as WebSearchBackend<Id>
}
