import { readFile } from 'node:fs/promises'
import { TuiMainScreen, ProcessTerminal, Text, visibleWidth } from '@earendil-works/pi-tui'
import { ToolExecutionComponent } from '../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js'
import { initTheme } from '../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js'
import { setKeybindings } from '@earendil-works/pi-tui'
import { KeybindingsManager } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js'
import background from '../../extensions/background'
import { registeredTool } from '../../extensions/shared/test-utils'

// Deterministic native-shell smoke: no model, network, or real background process.
initTheme('dark')
setKeybindings(new KeybindingsManager())
const terminal = new ProcessTerminal()
const ui = new TuiMainScreen(terminal)
const imagePath = process.argv.find((arg) => arg.startsWith('--image='))?.slice(8)
const image = imagePath ? (await readFile(imagePath)).toString('base64') : undefined
const tool = registeredTool(background, 'background-logs')
const row = new ToolExecutionComponent(tool.name, 'smoke', {}, {}, tool, ui, process.cwd())
ui.addChild(row)
ui.addChild(new Text('EDITOR SENTINEL — must remain below tool output', 0, 0))
ui.start()
const text =
  'BadMapError: expected a map\n  nil\r\nstack frame\rnext frame\n' + 'long output '.repeat(40)
const phases = image
  ? [
      () => row.updateArgs({ name: 'image-fixture' }),
      () => row.markExecutionStarted(),
      () =>
        row.updateResult({
          content: [
            { type: 'text', text: 'Isolated fixture screenshot' },
            { type: 'image', mimeType: 'image/png', data: image }
          ],
          details: { name: 'image-fixture', logs: 'Isolated fixture screenshot' },
          isError: false
        }),
      () => row.setExpanded(true),
      () => row.setExpanded(false),
      () => row.setShowImages(false),
      () => row.setShowImages(true)
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
  for (const width of image ? [] : [8, 40, 80, 120]) {
    for (const line of row.render(width)) {
      if (/[\r\n\t]/u.test(line) || visibleWidth(line) > width)
        throw new Error(`Invalid row at ${width}`)
    }
  }
  ui.requestRender()
  await new Promise((resolve) => setTimeout(resolve, image ? 2000 : 300))
}
if (image) await new Promise((resolve) => setTimeout(resolve, 20000))
// Pi parks the cursor in the final component. Its default shutdown writes a
// space there; logging at that position also overwrites the rendered sentinel.
// Preserve the verified frame, then move below it before printing completion.
ui.stop({ preserveScreen: true })
terminal.write('\x1b[999B\r\n')
console.log('NATIVE RENDER SMOKE PASSED')
