/**
 * Test harness for a provider's `refreshModels`: a context whose `publish`
 * records every persisted catalog, so a test can assert both what the refresh
 * returned and what it wrote back.
 */
import type { RefreshModelsContext } from '@earendil-works/pi-ai'

export type PersistedCatalog = NonNullable<
  Parameters<RefreshModelsContext['publish']>[0]['persist']
>

export function makeRefreshContext(overrides: Partial<RefreshModelsContext> = {}): {
  context: RefreshModelsContext
  persisted: PersistedCatalog[]
} {
  const persisted: PersistedCatalog[] = []
  const context: RefreshModelsContext = {
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async (publication) => {
      if (publication.persist) persisted.push(publication.persist)
      return true
    },
    ...overrides
  }
  return { context, persisted }
}
