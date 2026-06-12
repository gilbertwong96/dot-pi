import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent'
import type { Component } from '@earendil-works/pi-tui'

export type RegisteredTool = Parameters<ExtensionAPI['registerTool']>[0]

export const testTheme = {
  fg: (_name: string, text: string) => String(text),
  bg: (_name: string, text: string) => String(text),
  bold: (text: string) => String(text),
  underline: (text: string) => String(text)
} as Theme

export function renderComponentText(component: Component | undefined, width = 120): string {
  return component?.render(width).join('\n') ?? ''
}

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
