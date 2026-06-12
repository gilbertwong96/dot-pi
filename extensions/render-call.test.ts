import { describe, expect, test } from 'bun:test'
import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent'

import astGrep from './ast-grep'
import background from './background'
import chooseOptions from './choose-options'
import codesearch from './codesearch'
import context7 from './context7'
import lsp from './lsp'
import question from './question'
import webfetch from './webfetch'
import websearch from './websearch'

type RegisteredTool = Parameters<ExtensionAPI['registerTool']>[0]

const theme = {
  fg: (_name: string, text: string) => String(text),
  bg: (_name: string, text: string) => String(text),
  bold: (text: string) => String(text)
} as Theme

function renderText(component: { render(width: number): string[] }): string {
  return component.render(120).join('\n')
}

function collectTools(): RegisteredTool[] {
  const tools: RegisteredTool[] = []
  const pi = {
    registerTool: (tool: RegisteredTool) => tools.push(tool),
    registerCommand: () => undefined,
    on: () => undefined,
    registerMessageRenderer: () => undefined
  } as unknown as ExtensionAPI

  for (const extension of [
    astGrep,
    background,
    chooseOptions,
    codesearch,
    context7,
    lsp,
    question,
    webfetch,
    websearch
  ]) {
    extension(pi)
  }

  return tools.filter((tool) => tool.renderCall)
}

describe('tool renderCall streaming start', () => {
  test('does not render undefined when args are unavailable', () => {
    const rendered = collectTools().map((tool) => [
      tool.name,
      renderText(tool.renderCall?.(undefined as never, theme, {} as never)!)
    ])

    expect(rendered.length).toBeGreaterThan(0)
    for (const [name, text] of rendered) {
      expect(text.toLowerCase(), name).not.toContain('undefined')
    }
  })
})
