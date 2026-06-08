import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Key, matchesKey, Text, truncateToWidth } from '@earendil-works/pi-tui'
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
      const allowMultiple = params.allowMultiple !== false
      const defaultActionIndex = Math.max(
        0,
        actions.indexOf(params.defaultAction ?? actions[0] ?? '')
      )

      const result = await ctx.ui.custom<ChooseResult>((tui, theme, _kb, done) => {
        let optionIndex = 0
        let actionIndex = defaultActionIndex
        const selected = new Set<number>([0])
        let cachedLines: string[] | undefined

        function refresh() {
          cachedLines = undefined
          tui.requestRender()
        }

        function toggle(index: number) {
          if (!allowMultiple) {
            selected.clear()
            selected.add(index)
            return
          }
          if (selected.has(index)) selected.delete(index)
          else selected.add(index)
          if (selected.size === 0) selected.add(index)
        }

        function finish(cancelled: boolean) {
          done({
            question: params.question,
            action: actions[actionIndex] ?? DEFAULT_ACTIONS[0],
            options,
            selectedIndexes: [...selected].sort((a, b) => a - b),
            cancelled
          })
        }

        function handleInput(data: string) {
          if (matchesKey(data, Key.escape)) return finish(true)
          if (matchesKey(data, Key.enter)) return finish(false)

          if (matchesKey(data, Key.up)) {
            optionIndex = Math.max(0, optionIndex - 1)
            refresh()
            return
          }
          if (matchesKey(data, Key.down)) {
            optionIndex = Math.min(options.length - 1, optionIndex + 1)
            refresh()
            return
          }
          if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
            actionIndex = (actionIndex + 1) % actions.length
            refresh()
            return
          }
          if (matchesKey(data, Key.left)) {
            actionIndex = (actionIndex - 1 + actions.length) % actions.length
            refresh()
            return
          }
          if (matchesKey(data, Key.space) || data === ' ') {
            toggle(optionIndex)
            refresh()
            return
          }
          if (data === 'a') {
            options.forEach((_, index) => selected.add(index))
            refresh()
            return
          }
          if (data === 'n') {
            selected.clear()
            selected.add(optionIndex)
            refresh()
            return
          }
          if (/^[1-9]$/.test(data)) {
            const index = Number(data) - 1
            if (index < options.length) {
              optionIndex = index
              toggle(index)
              refresh()
            }
          }
        }

        function render(width: number): string[] {
          if (cachedLines) return cachedLines

          const lines: string[] = []
          const add = (line: string) => lines.push(truncateToWidth(line, width))
          const border = theme.fg('accent', '─'.repeat(width))

          add(border)
          add(theme.fg('text', ` ${params.question}`))
          lines.push('')
          add(`${theme.fg('muted', ' Action:')} ${theme.fg('accent', actions[actionIndex] ?? '')}`)
          lines.push('')

          for (let index = 0; index < options.length; index++) {
            const option = options[index]
            const cursor = index === optionIndex ? theme.fg('accent', '>') : ' '
            const mark = selected.has(index) ? theme.fg('success', '●') : theme.fg('muted', '○')
            const label = `${cursor} ${mark} ${index + 1}. ${option.label}`
            add(index === optionIndex ? theme.fg('accent', label) : label)
            if (option.description) add(`     ${theme.fg('muted', option.description)}`)
          }

          lines.push('')
          add(
            theme.fg(
              'dim',
              ' ↑↓ move • Space/1-9 toggle • Tab action • a all • n none • Enter OK • Esc cancel'
            )
          )
          add(border)

          cachedLines = lines
          return lines
        }

        return { render, handleInput, invalidate: () => (cachedLines = undefined) }
      })

      return {
        content: [{ type: 'text', text: formatChoiceResult(result) }],
        details: result
      }
    },

    renderCall(args, theme) {
      const count = Array.isArray(args.options) ? args.options.length : 0
      return new Text(
        theme.fg('toolTitle', theme.bold('choose_from_options ')) +
          theme.fg('muted', `${args.question ?? ''} (${count} options)`),
        0,
        0
      )
    },

    renderResult(result, _options, theme) {
      const details = result.details as ChooseResult | undefined
      if (!details) return new Text('', 0, 0)
      if (details.cancelled) return new Text(theme.fg('warning', 'Cancelled'), 0, 0)
      const selected = details.selectedIndexes.map((index) => index + 1).join(', ')
      return new Text(
        theme.fg('success', '✓ ') +
          theme.fg('accent', details.action) +
          theme.fg('muted', `: ${selected}`),
        0,
        0
      )
    }
  })
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
