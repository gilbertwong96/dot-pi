import { afterEach, expect, test } from 'vitest'
import type { TUI } from '@earendil-works/pi-tui'
import { ToolExecutionComponent } from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js'
import { initTheme } from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js'
import { resetCapabilitiesCache, setCapabilities } from '@earendil-works/pi-tui'
import computer from './computer'
import { registeredTool } from './shared/test-utils'

// Synthetic 1×1 PNG: no screen capture, terminal process, or desktop access.
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII='
afterEach(() => resetCapabilitiesCache())

test.each([null, 'kitty', 'iterm2'] as const)('native image contract: %s', (images) => {
  initTheme('dark')
  setCapabilities({ images, trueColor: true, hyperlinks: true })
  const tool = registeredTool(computer, 'computer_observe')
  const row = new ToolExecutionComponent(
    tool.name,
    'image-fixture',
    {},
    {},
    tool,
    { requestRender() {} } as TUI,
    '/tmp'
  )
  row.updateResult({
    content: [
      { type: 'text', text: 'Fixture screenshot' },
      { type: 'image', mimeType: 'image/png', data: png }
    ],
    details: { operation: 'observe' },
    isError: false
  })
  const output = () => row.render(40).join('\n')
  const hasImage = (text: string) => text.includes('\x1b_G') || text.includes('1337;File=')
  expect(output()).toContain('Fixture screenshot')
  expect(hasImage(output())).toBe(images !== null)
  row.setExpanded(true)
  expect(hasImage(output())).toBe(images !== null)
  row.setShowImages(false)
  expect(hasImage(output())).toBe(false)
  row.setShowImages(true)
  expect(hasImage(output())).toBe(images !== null)
  row.updateResult({ content: [{ type: 'text', text: 'After screenshot' }], isError: false })
  expect(hasImage(output())).toBe(false)
  expect(output()).toContain('After screenshot')
})
