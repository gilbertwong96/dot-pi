import type { ExtensionAPI, ToolDefinition, AgentToolResult } from '@earendil-works/pi-coding-agent'
import { renderEmpty, renderError, renderLines, primary, resultText } from './render'
import type { TSchema } from 'typebox'

/** Preserve structured failures through Pi's canonical tool_result error channel. */
export function registerTool<T extends TSchema, D>(
  pi: ExtensionAPI,
  definition: ToolDefinition<T, D>
): void {
  const failures = new Set<string>()
  pi.on('tool_result', (event) => {
    if (event.toolName !== definition.name || !failures.delete(event.toolCallId)) return
    return { isError: true }
  })
  pi.on('session_shutdown', () => failures.clear())
  pi.registerTool({
    ...definition,
    renderResult: definition.renderResult
      ? (result, options, theme, context) => {
          if (context.isError && result.details === undefined)
            return renderError(resultText(result), theme)
          if (options.isPartial && result.details === undefined) return renderEmpty()
          if (result.details === undefined) return renderLines([primary(resultText(result), theme)])
          return definition.renderResult!(result as AgentToolResult<D>, options, theme, context)
        }
      : undefined,
    async execute(id, params, signal, onUpdate, ctx) {
      failures.delete(id)
      const result = await definition.execute(id, params, signal, onUpdate, ctx)
      if ((result as { isError?: boolean }).isError) failures.add(id)
      return result
    }
  })
}
