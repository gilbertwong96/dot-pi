import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { renderEmpty, renderError, renderLines, primary, resultText } from './render'
import type { TSchema } from 'typebox'

/** Register a tool and fill in a result renderer when details are still streaming. */
export function registerTool<T extends TSchema, D>(
  pi: ExtensionAPI,
  definition: ToolDefinition<T, D>
): void {
  const renderResult = definition.renderResult
  pi.registerTool({
    ...definition,
    renderResult: renderResult
      ? (result, options, theme, context) => {
          if (context.isError && result.details === undefined)
            return renderError(resultText(result), theme)
          if (options.isPartial && result.details === undefined) return renderEmpty()
          if (result.details === undefined) return renderLines([primary(resultText(result), theme)])
          return renderResult(result, options, theme, context)
        }
      : undefined
  })
}
