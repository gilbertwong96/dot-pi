import { TuiMainScreen, ProcessTerminal, Text, visibleWidth } from '@earendil-works/pi-tui'
import { ToolExecutionComponent } from '../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js'
import { initTheme } from '../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js'
import computer from '../../extensions/computer'
import { setKeybindings as setHostKeybindings } from '../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/keybindings.js'
import { setKeybindings } from '@earendil-works/pi-tui'
import { KeybindingsManager } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js'
import background from '../../extensions/background'
import { registeredTool } from '../../extensions/shared/test-utils'

// Deterministic native-shell smoke: no model, network, or real background process.
initTheme('dark')
setKeybindings(new KeybindingsManager())
setHostKeybindings(new KeybindingsManager())
const terminal = new ProcessTerminal()
const ui = new TuiMainScreen(terminal)
const computerMode = process.argv.includes('--computer')
const tool = computerMode
  ? registeredTool(computer, 'computer_windows')
  : registeredTool(background, 'background-logs')
const row = new ToolExecutionComponent(tool.name, 'smoke', {}, {}, tool, ui, process.cwd())
ui.addChild(row)
ui.addChild(new Text('EDITOR SENTINEL — must remain below tool output', 0, 0))
ui.start()
const text =
  'BadMapError: expected a map\n  nil\r\nstack frame\rnext frame\n' + 'long output '.repeat(40)
const computerItems = Array.from({ length: 7 }, (_, index) => ({
  app_name: 'Fixture',
  pid: 42,
  window_id: index + 1,
  title: `Window ${index + 1}: ${'long title '.repeat(8)}`
}))
const computerResult = (items: typeof computerItems) => ({
  content: [{ type: 'text', text: `Found ${items.length} windows` }],
  details: {
    operation: 'windows',
    items,
    windows: items.map((item) => ({
      ref: `@w${item.window_id}`,
      pid: 42,
      windowId: item.window_id
    }))
  },
  isError: false
})
const phases = computerMode
  ? [
      () => row.updateArgs({ pid: 42, onScreenOnly: true }),
      () => row.markExecutionStarted(),
      () => row.updateResult({ content: [], isError: false }, true),
      () => row.updateResult(computerResult([])),
      () => row.updateResult(computerResult(computerItems)),
      () => row.setExpanded(true),
      () => row.setExpanded(false),
      () => row.updateResult(computerResult(computerItems.slice(0, 1)))
    ]
  : [
      () => row.updateArgs({ name: 'renderer-smoke' }),
      () => row.markExecutionStarted(),
      () => row.updateResult({ content: [], isError: false }, true),
      () =>
        row.updateResult({
          content: [{ type: 'text', text }],
          details: { name: 'renderer-smoke', logs: text },
          isError: false
        }),
      () => row.setExpanded(true),
      () => row.setExpanded(false),
      () => row.updateResult({ content: [{ type: 'text', text }], isError: true }),
      () => row.setExpanded(true)
    ]
for (const phase of phases) {
  phase()
  for (const width of [8, 40, 80, 120]) {
    for (const line of row.render(width)) {
      if (/[\r\n\t]/u.test(line) || visibleWidth(line) > width)
        throw new Error(`Invalid row at ${width}`)
    }
  }
  ui.requestRender()
  await new Promise((resolve) => setTimeout(resolve, computerMode ? 1000 : 300))
}
// Pi parks the cursor in the final component. Its default shutdown writes a
// space there; logging at that position also overwrites the rendered sentinel.
// Preserve the verified frame, then move below it before printing completion.
ui.stop({ preserveScreen: true })
terminal.write('\x1b[999B\r\n')
console.log('NATIVE RENDER SMOKE PASSED')
