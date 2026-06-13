import { describe, expect, test } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'

import { filterDisplayOnlyMessages } from './display-message'

describe('filterDisplayOnlyMessages', () => {
  test('removes matching custom messages only', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 },
      { role: 'custom', customType: 'receipt', content: 'hidden', display: true, timestamp: 2 },
      { role: 'custom', customType: 'other', content: 'kept', display: true, timestamp: 3 }
    ] as AgentMessage[]

    expect(filterDisplayOnlyMessages(messages, 'receipt')).toEqual([messages[0], messages[2]])
  })
})
