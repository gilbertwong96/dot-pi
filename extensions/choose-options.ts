import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent'
import { Key, matchesKey, Text, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { renderLines } from './shared/render'
import { Type } from 'typebox'

type Option = {
  label: string
  description?: string
}

type ChooseResult = {
  question: string
  action: string
  options: Option[]
  selectedIndexes: number[]
  cancelled: boolean
}

type PickerConfig = {
  question: string
  options: Option[]
  actions: string[]
  allowMultiple: boolean
  defaultActionIndex: number
}

const OptionSchema = Type.Object({
  label: Type.String({ description: 'Display label for the option' }),
  description: Type.Optional(Type.String({ description: 'Optional description shown below label' }))
})

const ParamsSchema = Type.Object({
  question: Type.String({ description: 'Question shown above the options' }),
  options: Type.Array(OptionSchema, {
    description:
      'Numbered options, next steps, alternatives, plans, fixes, or actions to choose from'
  }),
  allowMultiple: Type.Optional(
    Type.Boolean({ description: 'Allow selecting multiple options. Defaults to true.' })
  ),
  actions: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Available intents for the selected options. Defaults to Do selected, Discuss selected, Explain selected.'
    })
  ),
  defaultAction: Type.Optional(Type.String({ description: 'Initially selected action label' }))
})

const DEFAULT_ACTIONS = ['Do selected', 'Discuss selected', 'Explain selected']
const SYSTEM_HINT =
  'When you need the user to pick from options/next steps, call choose_from_options; do not ask them to type item numbers.'

export function formatChoiceResult(result: ChooseResult): string {
  if (result.cancelled) return 'User cancelled option selection.'

  const selected = result.selectedIndexes
    .map((index) => `${index + 1}. ${result.options[index]?.label ?? '(missing option)'}`)
    .join('\n')

  return `User chose action: ${result.action}\n\nSelected options:\n${selected}\n\nContinue according to the chosen action. Do not act on unselected options.`
}

export default function chooseOptions(pi: ExtensionAPI) {
  pi.on('before_agent_start', (event) => ({
    systemPrompt: event.systemPrompt.includes(SYSTEM_HINT)
      ? event.systemPrompt
      : `${event.systemPrompt}\n\n${SYSTEM_HINT}`
  }))

  pi.registerTool({
    name: 'choose_from_options',
    label: 'Choose Options',
    description:
      "Ask the user to choose from an option list. Use after presenting numbered options, next steps, alternatives, plans, or actions when you need the user's choice before continuing.",
    parameters: ParamsSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const options = params.options
      if (!ctx.hasUI) return errorResult('Error: UI not available', params.question, options)
      if (options.length === 0)
        return errorResult('Error: No options provided', params.question, [])

      const actions = params.actions?.length ? params.actions : DEFAULT_ACTIONS
      const defaultActionIndex = Math.max(
        0,
        actions.indexOf(params.defaultAction ?? actions[0] ?? '')
      )

      const result = await ctx.ui.custom<ChooseResult>(
        (tui, theme, _kb, done) =>
          new OptionPicker(
            {
              question: params.question,
              options,
              actions,
              allowMultiple: params.allowMultiple !== false,
              defaultActionIndex
            },
            theme,
            () => tui.requestRender(),
            done
          ),
        { overlay: true, overlayOptions: { width: '80%', maxHeight: '80%', minWidth: 56 } }
      )

      return {
        content: [{ type: 'text', text: formatChoiceResult(result) }],
        details: result
      }
    },

    renderCall(args, theme) {
      const count = Array.isArray(args.options) ? args.options.length : 0
      return new Text(
        theme.fg('toolTitle', theme.bold('choose ')) +
          theme.fg('muted', `${args.question ?? ''} (${count} options)`),
        0,
        0
      )
    },

    renderResult(result, _options, theme) {
      const details = result.details as ChooseResult | undefined
      if (!details) return renderLines([])
      if (details.cancelled) return renderLines([theme.fg('warning', 'Cancelled')])
      const selected = details.selectedIndexes
        .map((index) => details.options[index]?.label)
        .filter(Boolean)
        .join(', ')
      return renderLines([
        theme.fg('toolOutput', details.action) + theme.fg('muted', selected ? ` · ${selected}` : '')
      ])
    }
  })
}

class OptionPicker {
  private optionIndex = 0
  private actionIndex: number
  private numberMode = false
  private numberBuffer = ''
  private selected = new Set<number>([0])
  private cachedWidth?: number
  private cachedLines?: string[]

  constructor(
    private config: PickerConfig,
    private theme: Theme,
    private requestRender: () => void,
    private done: (result: ChooseResult) => void
  ) {
    this.actionIndex = config.defaultActionIndex
  }

  handleInput(data: string): void {
    if (this.numberMode) {
      this.handleNumberModeInput(data)
      return
    }

    if (matchesKey(data, Key.escape)) return this.finish(true)
    if (matchesKey(data, Key.enter)) return this.finish(false)

    if (matchesKey(data, Key.up)) return this.move(-1)
    if (matchesKey(data, Key.down)) return this.move(1)
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) return this.cycleAction(1)
    if (matchesKey(data, Key.left)) return this.cycleAction(-1)

    if (matchesKey(data, Key.space) || data === ' ') return this.toggleCurrent()
    if (data === 'a') return this.selectAll()
    if (data === 'n') return this.selectOnlyCurrent()
    if (data === 'g') return this.startNumberMode()

    if (/^[1-9]$/.test(data)) {
      const index = Number(data) - 1
      if (index < this.config.options.length) this.toggleIndex(index)
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines

    const innerWidth = Math.max(20, Math.min(width, 100))
    const lines: string[] = []
    const add = (line: string) => lines.push(truncateToWidth(line, innerWidth))
    const border = this.theme.fg('accent', '─'.repeat(innerWidth))

    add(border)
    for (const line of wrapTextWithAnsi(
      this.theme.fg('text', ` ${this.config.question}`),
      innerWidth
    )) {
      add(line)
    }
    lines.push('')
    add(`${this.theme.fg('muted', ' Action:')} ${this.theme.fg('accent', this.currentAction())}`)
    lines.push('')

    for (let index = 0; index < this.config.options.length; index++) {
      this.renderOption(index, innerWidth).forEach(add)
    }

    lines.push('')
    this.renderFooter(innerWidth).forEach(add)
    add(border)

    this.cachedWidth = width
    this.cachedLines = lines
    return lines
  }

  invalidate(): void {
    this.cachedWidth = undefined
    this.cachedLines = undefined
  }

  private renderOption(index: number, width: number): string[] {
    const option = this.config.options[index]
    const cursor = index === this.optionIndex ? this.theme.fg('accent', '>') : ' '
    const mark = this.selected.has(index)
      ? this.theme.fg('success', '●')
      : this.theme.fg('muted', '○')
    const label = `${cursor} ${mark} ${index + 1}. ${option.label}`
    const rendered = index === this.optionIndex ? this.theme.fg('accent', label) : label
    const lines = wrapTextWithAnsi(rendered, width)

    if (option.description) {
      lines.push(...wrapTextWithAnsi(`     ${this.theme.fg('muted', option.description)}`, width))
    }

    return lines
  }

  private renderFooter(width: number): string[] {
    const footer = this.numberMode
      ? [
          this.theme.fg('muted', ` Go/toggle item #: ${this.numberBuffer || '_'}`),
          this.theme.fg('dim', ' Enter toggle • Backspace edit • Esc cancel')
        ]
      : [
          this.theme.fg(
            'dim',
            ' ↑↓ move • Space/1-9 toggle • g number • Tab action • a all • n none • Enter OK • Esc cancel'
          )
        ]

    return footer.flatMap((line) => wrapTextWithAnsi(line, width))
  }

  private handleNumberModeInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.numberMode = false
      this.numberBuffer = ''
      this.refresh()
      return
    }
    if (matchesKey(data, Key.enter)) {
      this.toggleNumberBuffer()
      return
    }
    if (matchesKey(data, Key.backspace) || data === '\x7f') {
      this.numberBuffer = this.numberBuffer.slice(0, -1)
      this.refresh()
      return
    }
    if (/^[0-9]$/.test(data)) {
      this.numberBuffer += data
      this.refresh()
    }
  }

  private move(delta: number): void {
    this.optionIndex = Math.max(
      0,
      Math.min(this.config.options.length - 1, this.optionIndex + delta)
    )
    this.refresh()
  }

  private cycleAction(delta: number): void {
    this.actionIndex =
      (this.actionIndex + delta + this.config.actions.length) % this.config.actions.length
    this.refresh()
  }

  private toggleCurrent(): void {
    this.toggle(this.optionIndex)
    this.refresh()
  }

  private toggleIndex(index: number): void {
    this.optionIndex = index
    this.toggle(index)
    this.refresh()
  }

  private toggle(index: number): void {
    if (!this.config.allowMultiple) {
      this.selected.clear()
      this.selected.add(index)
      return
    }
    if (this.selected.has(index)) this.selected.delete(index)
    else this.selected.add(index)
    if (this.selected.size === 0) this.selected.add(index)
  }

  private toggleNumberBuffer(): void {
    const index = Number(this.numberBuffer) - 1
    if (Number.isInteger(index) && index >= 0 && index < this.config.options.length) {
      this.toggleIndex(index)
    }
    this.numberMode = false
    this.numberBuffer = ''
    this.refresh()
  }

  private selectAll(): void {
    this.config.options.forEach((_, index) => this.selected.add(index))
    this.refresh()
  }

  private selectOnlyCurrent(): void {
    this.selected.clear()
    this.selected.add(this.optionIndex)
    this.refresh()
  }

  private startNumberMode(): void {
    this.numberMode = true
    this.numberBuffer = ''
    this.refresh()
  }

  private finish(cancelled: boolean): void {
    this.done({
      question: this.config.question,
      action: this.currentAction(),
      options: this.config.options,
      selectedIndexes: [...this.selected].sort((a, b) => a - b),
      cancelled
    })
  }

  private currentAction(): string {
    return this.config.actions[this.actionIndex] ?? DEFAULT_ACTIONS[0]
  }

  private refresh(): void {
    this.invalidate()
    this.requestRender()
  }
}

function errorResult(message: string, question: string, options: Option[]) {
  const details: ChooseResult = {
    question,
    action: '',
    options,
    selectedIndexes: [],
    cancelled: true
  }
  return { content: [{ type: 'text' as const, text: message }], details }
}
