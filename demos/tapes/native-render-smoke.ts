import { TuiMainScreen, ProcessTerminal, Text, visibleWidth } from '@earendil-works/pi-tui'
import { ToolExecutionComponent } from '../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js'
import { initTheme } from '../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js'
import background from '../../extensions/background'
import { registeredTool } from '../../extensions/shared/test-utils'

// Deterministic native-shell smoke: no model, network, or real background process.
initTheme('dark')
const ui = new TuiMainScreen(new ProcessTerminal())
const tool = registeredTool(background, 'background-logs')
const row = new ToolExecutionComponent(tool.name, 'smoke', {}, {}, tool, ui, process.cwd())
ui.addChild(row)
ui.addChild(new Text('EDITOR SENTINEL — must remain below tool output', 0, 0))
ui.start()
const text =
  'BadMapError: expected a map\n  nil\r\nstack frame\rnext frame\n' + 'long output '.repeat(40)
const phases = [
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
  await new Promise((resolve) => setTimeout(resolve, 300))
}
ui.stop()
console.log('NATIVE RENDER SMOKE PASSED')
