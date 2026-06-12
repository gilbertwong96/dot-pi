import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export type RegisteredTool = Parameters<ExtensionAPI['registerTool']>[0]

export function collectRegisteredTools(extension: (pi: ExtensionAPI) => void): RegisteredTool[] {
  const tools: RegisteredTool[] = []
  const pi = {
    registerTool: (tool: RegisteredTool) => tools.push(tool),
    registerCommand: () => undefined,
    on: () => undefined,
    registerMessageRenderer: () => undefined
  } as unknown as ExtensionAPI

  extension(pi)
  return tools
}

export function registeredTool(
  extension: (pi: ExtensionAPI) => void,
  name: string
): RegisteredTool {
  const tool = collectRegisteredTools(extension).find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`${name} tool was not registered`)
  return tool
}
