import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'
import { Key, matchesKey, Text, truncateToWidth } from '@earendil-works/pi-tui'
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
  comment?: string
  cancelled: boolean
  active?: boolean
  optionIndex?: number
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
  const comment = result.comment ? `\n\nComment:\n${result.comment}` : ''

  return `User chose action: ${result.action}\n\nSelected options:\n${selected}${comment}\n\nContinue according to the chosen action. Do not act on unselected options.`
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

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const options = params.options
      if (ctx.mode !== 'tui')
        return errorResult('Error: UI not available', params.question, options)
      if (options.length === 0)
        return errorResult('Error: No options provided', params.question, [])

      const actions = params.actions?.length ? params.actions : DEFAULT_ACTIONS
      const defaultActionIndex = Math.max(
        0,
        actions.indexOf(params.defaultAction ?? actions[0] ?? '')
      )

      const result = await runNativeEditorChooser(
        {
          question: params.question,
          options,
          actions,
          allowMultiple: params.allowMultiple !== false,
          defaultActionIndex
        },
        ctx,
        signal
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
          theme.fg('muted', `${args.question ?? ''}${count ? ` (${count} options)` : ''}`),
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
      const comment = details.comment ? ` · ${details.comment}` : ''
      return renderLines([
        theme.fg('toolOutput', details.action) +
          theme.fg('muted', `${selected ? ` · ${selected}` : ''}${comment}`)
      ])
    }
  })
}

type ChooserState = {
  optionIndex: number
  actionIndex: number
  selected: Set<number>
}

const WIDGET_KEY = 'choose-from-options'
const MAX_VISIBLE_OPTIONS = 5

type AltBaseKey = Parameters<typeof Key.alt>[0]

function altKey(key: string) {
  return Key.alt(key as AltBaseKey)
}

function runNativeEditorChooser(
  config: PickerConfig,
  ctx: ExtensionContext,
  signal?: AbortSignal
): Promise<ChooseResult> {
  const state: ChooserState = {
    optionIndex: 0,
    actionIndex: config.defaultActionIndex,
    selected: new Set([0])
  }

  let requestRender = () => {}
  let widget: MinimalChooseWidget | undefined
  let unsubscribeInput: (() => void) | undefined
  let finished = false
  let lastNavigation: { key: string; at: number } | undefined

  return new Promise((resolve) => {
    const cleanup = () => {
      signal?.removeEventListener('abort', abort)
      unsubscribeInput?.()
      ctx.ui.setWidget(WIDGET_KEY, undefined)
    }

    const refresh = () => {
      widget?.invalidate()
      requestRender()
    }

    const finish = (cancelled: boolean) => {
      if (finished) return
      finished = true
      const editorText = ctx.ui.getEditorText().trim()
      const parsed = cancelled
        ? { selectedIndexes: sortedSelection(state.selected), comment: undefined }
        : parseEditorChoice(editorText, state.selected, config.options.length)

      if (!cancelled) ctx.ui.setEditorText('')
      cleanup()
      resolve(
        currentResult(config, state, cancelled, parsed.comment, false, parsed.selectedIndexes)
      )
    }

    const abort = () => finish(true)
    if (signal?.aborted) return abort()
    signal?.addEventListener('abort', abort, { once: true })

    ctx.ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => {
        widget = new MinimalChooseWidget(config, state, theme)
        requestRender = () => tui.requestRender()
        return widget
      },
      { placement: 'belowEditor' }
    )

    const shouldHandleNavigation = (key: string) => {
      const now = Date.now()
      if (lastNavigation?.key === key && now - lastNavigation.at < 300) return false
      lastNavigation = { key, at: now }
      return true
    }

    unsubscribeInput = ctx.ui.onTerminalInput((data) => {
      if (matchesKey(data, Key.enter)) {
        finish(false)
        return { consume: true }
      }
      if (matchesKey(data, Key.escape)) {
        finish(true)
        return { consume: true }
      }
      if (matchesKey(data, Key.up)) {
        if (!shouldHandleNavigation('up')) return { consume: true }
        move(config, state, -1)
        refresh()
        return { consume: true }
      }
      if (matchesKey(data, Key.down)) {
        if (!shouldHandleNavigation('down')) return { consume: true }
        move(config, state, 1)
        refresh()
        return { consume: true }
      }
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
        if (!shouldHandleNavigation('action-next')) return { consume: true }
        cycleAction(config, state, 1)
        refresh()
        return { consume: true }
      }
      if (matchesKey(data, Key.left)) {
        if (!shouldHandleNavigation('action-prev')) return { consume: true }
        cycleAction(config, state, -1)
        refresh()
        return { consume: true }
      }
      if (matchesKey(data, Key.alt('a'))) {
        selectAll(config, state)
        refresh()
        return { consume: true }
      }
      if (matchesKey(data, Key.alt('n'))) {
        selectOnlyCurrent(state)
        refresh()
        return { consume: true }
      }
      if (matchesKey(data, Key.alt(Key.space))) {
        toggleCurrent(config, state)
        refresh()
        return { consume: true }
      }

      const actionIndex = actionShortcutIndex(config, data)
      if (actionIndex !== undefined) {
        state.actionIndex = actionIndex
        refresh()
        return { consume: true }
      }

      for (let index = 0; index < Math.min(9, config.options.length); index++) {
        if (matchesKey(data, altKey(String(index + 1)))) {
          toggleIndex(config, state, index)
          refresh()
          return { consume: true }
        }
      }

      return undefined
    })
  })
}

class MinimalChooseWidget {
  private cachedWidth?: number
  private cachedLines?: string[]

  constructor(
    private config: PickerConfig,
    private state: ChooserState,
    private theme: Theme
  ) {}

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines

    this.cachedWidth = width
    this.cachedLines = renderChoiceRows(this.config, this.state, this.theme, {
      width,
      footer: true
    })
    return this.cachedLines
  }

  invalidate(): void {
    this.cachedWidth = undefined
    this.cachedLines = undefined
  }
}

function renderChoiceRows(
  config: PickerConfig,
  state: ChooserState,
  theme: Theme,
  options: { width?: number; footer: boolean }
): string[] {
  const contentWidth = Math.max(20, (options.width ?? 100) - 4)
  const lines: string[] = []
  const visible = visibleOptionIndexes(config, state)
  for (const index of visible) {
    lines.push(`  ${renderChoiceOption(config, state, theme, index, contentWidth)}`)
  }
  if (options.footer) lines.push(`  ${renderChoiceFooter(config, state, theme, contentWidth)}`)
  return lines
}

function renderChoiceOption(
  config: PickerConfig,
  state: ChooserState,
  theme: Theme,
  index: number,
  width: number
): string {
  const option = config.options[index]
  const current = index === state.optionIndex
  const selected = state.selected.has(index)
  const cursor = current ? theme.fg('accent', '→') : selected ? theme.fg('accent', '•') : ' '
  const number = selected ? theme.fg('accent', `${index + 1}`) : theme.fg('muted', `${index + 1}`)
  const label = current ? theme.fg('accent', option.label) : theme.fg('toolOutput', option.label)
  const selectedText = selected ? theme.fg('muted', ' selected') : ''
  const description = option.description ? theme.fg('muted', `  ${option.description}`) : ''

  return truncateToWidth(`${cursor} ${number}  ${label}${selectedText}${description}`, width)
}

function renderChoiceFooter(
  config: PickerConfig,
  state: ChooserState,
  theme: Theme,
  width: number
): string {
  const total = config.options.length
  const position = `${state.optionIndex + 1}/${total}`
  const action = currentAction(config, state)
  return truncateToWidth(
    theme.fg('dim', `(${position}) ${action} · Enter confirm · Esc cancel · type comment`),
    width
  )
}

function visibleOptionIndexes(config: PickerConfig, state: ChooserState): number[] {
  const total = config.options.length
  if (total <= MAX_VISIBLE_OPTIONS) return [...Array(total).keys()]
  const half = Math.floor(MAX_VISIBLE_OPTIONS / 2)
  const start = Math.max(0, Math.min(total - MAX_VISIBLE_OPTIONS, state.optionIndex - half))
  return [...Array(MAX_VISIBLE_OPTIONS).keys()].map((offset) => start + offset)
}

function move(config: PickerConfig, state: ChooserState, delta: number): void {
  state.optionIndex = Math.max(0, Math.min(config.options.length - 1, state.optionIndex + delta))
}

function cycleAction(config: PickerConfig, state: ChooserState, delta: number): void {
  state.actionIndex = (state.actionIndex + delta + config.actions.length) % config.actions.length
}

function toggleCurrent(config: PickerConfig, state: ChooserState): void {
  toggleIndex(config, state, state.optionIndex)
}

function toggleIndex(config: PickerConfig, state: ChooserState, index: number): void {
  state.optionIndex = index
  if (!config.allowMultiple) {
    state.selected.clear()
    state.selected.add(index)
    return
  }
  if (state.selected.has(index)) state.selected.delete(index)
  else state.selected.add(index)
  if (state.selected.size === 0) state.selected.add(index)
}

function selectAll(config: PickerConfig, state: ChooserState): void {
  if (!config.allowMultiple) return selectOnlyCurrent(state)
  config.options.forEach((_, index) => state.selected.add(index))
}

function selectOnlyCurrent(state: ChooserState): void {
  state.selected.clear()
  state.selected.add(state.optionIndex)
}

function sortedSelection(selected: Set<number>): number[] {
  return [...selected].sort((a, b) => a - b)
}

function currentResult(
  config: PickerConfig,
  state: ChooserState,
  cancelled: boolean,
  comment?: string,
  active = false,
  selectedIndexes = sortedSelection(state.selected)
): ChooseResult {
  return {
    question: config.question,
    action: currentAction(config, state),
    options: config.options,
    selectedIndexes,
    comment,
    cancelled,
    active,
    optionIndex: state.optionIndex
  }
}

function currentAction(config: PickerConfig, state: ChooserState): string {
  return config.actions[state.actionIndex] ?? DEFAULT_ACTIONS[0]
}

function actionShortcutIndex(config: PickerConfig, data: string): number | undefined {
  const shortcuts = ['d', 's', 'e']
  for (let index = 0; index < Math.min(shortcuts.length, config.actions.length); index++) {
    if (matchesKey(data, altKey(shortcuts[index]!))) return index
  }
  return undefined
}

function parseEditorChoice(text: string, fallback: Set<number>, optionCount: number) {
  const trimmed = text.trim()
  if (!trimmed) return { selectedIndexes: sortedSelection(fallback), comment: undefined }

  const leading = trimmed.match(/^((?:#?\d+\s*(?:(?:,|\+|&|and)\s*)?)+)(.*)$/i)
  if (!leading) return { selectedIndexes: sortedSelection(fallback), comment: trimmed }

  const parsed = [...leading[1].matchAll(/#?(\d+)/g)]
    .map((match) => Number(match[1]) - 1)
    .filter((index) => Number.isInteger(index) && index >= 0 && index < optionCount)

  const selectedIndexes =
    parsed.length > 0 ? [...new Set(parsed)].sort((a, b) => a - b) : sortedSelection(fallback)
  const comment = leading[2]?.trim() || undefined
  return { selectedIndexes, comment }
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
