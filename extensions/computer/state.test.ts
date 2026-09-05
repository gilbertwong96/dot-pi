import { expect, test } from 'vitest'
import { createState, updateElements, updateWindows } from './state'
import type { ToolResult } from '@trycua/cua-driver'
const payload = (value: object) => ({ structuredJson: JSON.stringify(value) }) as ToolResult

test('never reassigns a stale handle using the same label or outline index', () => {
  const state = createState()
  const params = { target: { kind: 'window', window: '@w1' } }
  updateElements(
    state,
    payload({ elements: [{ element_token: 'old', element_index: 1, label: 'OK' }] }),
    params
  )
  updateElements(
    state,
    payload({ elements: [{ element_token: 'new', element_index: 1, label: 'OK' }] }),
    params
  )
  expect(state.elements.has('@e1')).toBe(false)
  expect(state.elements.get('@e2')?.token).toBe('new')
  updateElements(state, {} as ToolResult, params)
  expect(state.elements.size).toBe(0)
})

test('filtered discovery expires only that process windows', () => {
  const state = createState()
  updateWindows(
    state,
    payload({
      windows: [
        { pid: 1, window_id: 2 },
        { pid: 3, window_id: 4 }
      ]
    })
  )
  updateWindows(state, payload({ windows: [] }), { pid: 1 })
  expect([...state.windows.values()].map((window) => window.pid)).toEqual([3])
})
