import { describe, expect, test } from 'bun:test'
import { visibleWidth } from '@earendil-works/pi-tui'

import { clampRenderedLines, renderLines } from './render'

describe('renderLines', () => {
  test('truncates long lines to viewport width', () => {
    const [, line] = renderLines(['abcdefghijklmnopqrstuvwxyz']).render(10)

    expect(visibleWidth(line)).toBeLessThanOrEqual(10)
    expect(line).toContain('…')
  })
})

describe('clampRenderedLines', () => {
  test('truncates lines returned by wrapped components', () => {
    const component = clampRenderedLines({
      render: () => ['0123456789abcdef'],
      invalidate: () => undefined
    })

    const [line] = component.render(8)

    expect(visibleWidth(line)).toBeLessThanOrEqual(8)
    expect(line).toContain('…')
  })
})
