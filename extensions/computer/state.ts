import type { ToolResult } from '@trycua/cua-driver'
import type { ComputerElement, ComputerWindow } from './render'
import type { ComputerParams } from './schemas'

export interface ComputerState {
  windows: Map<string, ComputerWindow>
  elements: Map<string, ComputerElement>
  nextWindowRef: number
  nextElementRef: number
}

export function createState(): ComputerState {
  return { windows: new Map(), elements: new Map(), nextWindowRef: 1, nextElementRef: 1 }
}

export function queueKey(params: ComputerParams, state: ComputerState): string {
  const element =
    typeof params.element === 'string' ? state.elements.get(params.element) : undefined
  const target = params.target as { window?: string } | undefined
  return element?.window ?? target?.window ?? 'desktop'
}

export function updateWindows(
  state: ComputerState,
  value: ToolResult,
  params: ComputerParams = {}
): void {
  if (!value.structuredJson) return
  try {
    const parsed = JSON.parse(value.structuredJson) as { windows?: Array<Record<string, unknown>> }
    const previous = new Map(
      [...state.windows.values()].map((window) => [`${window.pid}:${window.windowId}`, window])
    )
    if (!Array.isArray(parsed.windows)) throw new Error('Invalid windows response')
    for (const [ref, window] of state.windows) {
      if (params.pid === undefined || params.pid === window.pid) state.windows.delete(ref)
    }
    for (const item of parsed.windows) {
      if (typeof item.pid !== 'number' || typeof item.window_id !== 'number') continue
      const identity = `${item.pid}:${item.window_id}`
      const window = previous.get(identity) ?? {
        ref: `@w${state.nextWindowRef++}`,
        pid: item.pid,
        windowId: item.window_id
      }
      state.windows.set(window.ref, window)
    }
    state.elements = new Map(
      [...state.elements].filter(([, element]) => state.windows.has(element.window))
    )
  } catch {
    state.windows.clear()
    state.elements.clear()
  }
}

export function updateElements(
  state: ComputerState,
  value: ToolResult,
  params: ComputerParams
): void {
  const target = params.target as { window?: string } | undefined
  if (target?.window) {
    const previous = new Map(state.elements)
    state.elements = new Map(
      [...state.elements].filter(([, element]) => element.window !== target.window)
    )
    if (!value.structuredJson || value.isError) return
    // Keep previous tokens available only while building a successful observation.
    state.elements = previous
  } else return
  try {
    const parsed = JSON.parse(value.structuredJson) as { elements?: Array<Record<string, unknown>> }
    const retained = new Map(
      [...state.elements].filter(([, element]) => element.window !== target?.window)
    )
    for (const item of parsed.elements ?? []) {
      const role = typeof item.role === 'string' ? item.role : ''
      const label = typeof item.label === 'string' ? item.label : ''
      if (
        typeof item.element_token !== 'string' ||
        !label ||
        ['AXWindow', 'AXMenuBar', 'AXMenu'].includes(role) ||
        !target?.window
      )
        continue
      const index = typeof item.element_index === 'number' ? item.element_index : undefined
      // Labels and outline positions are not stable accessibility identities.
      // Reuse only an exact backend token in the same observed window.
      const previous = [...state.elements.values()].find(
        (element) => element.window === target.window && element.token === item.element_token
      )
      const ref = previous?.ref ?? `@e${state.nextElementRef++}`
      retained.set(ref, {
        ref,
        window: target.window,
        token: item.element_token,
        index,
        role,
        label
      })
    }
    state.elements = retained
  } catch {
    state.elements.clear()
  }
}

export function resetState(state: ComputerState): void {
  state.windows.clear()
  state.elements.clear()
  state.nextWindowRef = 1
  state.nextElementRef = 1
}
