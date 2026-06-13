/**
 * LSP Tool Extension
 *
 * Provides Language Server Protocol operations for code intelligence.
 * Supports: definition, references, hover, symbols, rename, code actions,
 * workspace diagnostics, call hierarchy, and rust-analyzer specific operations.
 */

import { spawn } from 'node:child_process'

import {
  type ExtensionAPI,
  getLanguageFromPath,
  highlightCode
} from '@earendil-works/pi-coding-agent'
import {
  expandHint,
  firstText,
  renderError,
  renderLines,
  renderToolCall,
  toolText
} from '../shared/render'
import { waitForValue } from '../shared/async'
import { errorMessage } from '../shared/errors'
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CodeAction,
  Command,
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  SymbolInformation,
  WorkspaceEdit
} from 'vscode-languageserver-types'
import path from 'node:path'
import {
  ensureFileOpen,
  getOrCreateClient,
  refreshFile,
  sendRequest,
  setIdleTimeout,
  shutdownAll
} from './client'
import { getLinterClient } from './clients'
import { getServersForFile, hasCapability, loadConfig, type LspConfig } from './config'
import { applyWorkspaceEdit } from './edits'
import {
  detectProjectType,
  findFileByExtensions,
  getLspServerForFile,
  getRustServer,
  getServerForWorkspaceAction,
  resolveToCwd
} from './project'
import * as rustAnalyzer from './rust-analyzer'
import type { LspParams, LspToolDetails, ServerConfig } from './types'
import { lspSchema } from './types'
import {
  extractHoverText,
  fileToUri,
  formatDiagnostic,
  formatDiagnosticsSummary,
  formatDocumentSymbol,
  formatLocation,
  formatSymbolInformation,
  formatWorkspaceEdit,
  symbolKindToIcon,
  uriToFile
} from './utils'

// =============================================================================
// Tool Description
// =============================================================================

const DESCRIPTION = `Interact with Language Server Protocol (LSP) servers for code intelligence.

**Actions:**
- \`definition\` - Go to definition of symbol at position
- \`references\` - Find all references to symbol at position
- \`hover\` - Get type/documentation info at position
- \`symbols\` - List all symbols in a file
- \`workspace_symbols\` - Search symbols across workspace (requires \`query\`)
- \`diagnostics\` - Get errors/warnings for file(s)
- \`workspace_diagnostics\` - Check entire project for issues
- \`rename\` - Rename symbol (requires \`new_name\`)
- \`actions\` - Get/apply code actions at position
- \`incoming_calls\` - Find callers of function at position
- \`outgoing_calls\` - Find functions called by function at position
- \`status\` - Show active LSP servers

**Rust-analyzer specific:**
- \`flycheck\` - Run cargo check
- \`expand_macro\` - Expand macro at position
- \`ssr\` - Structural search/replace (requires \`query\`, \`replacement\`)
- \`runnables\` - List runnable targets
- \`related_tests\` - Find tests for code at position
- \`reload_workspace\` - Reload Cargo workspace

**Parameters:**
- \`file\` - File path (required for most actions)
- \`line\`, \`column\` - 1-based position (required for position-based actions)
- \`query\` - Search query for workspace_symbols/ssr
- \`new_name\` - New name for rename action
- \`apply\` - Apply changes (default: true for rename, false for ssr)
- \`action_index\` - Index of code action to apply

**Supported languages:** TypeScript, JavaScript, Rust, Go, Python, C/C++, and many more.
**Note:** Requires LSP servers to be installed (typescript-language-server, rust-analyzer, gopls, pyright, etc.)`

// =============================================================================
// Helpers
// =============================================================================

async function waitForDiagnostics(
  client: { diagnostics: Map<string, Diagnostic[]> },
  uri: string,
  timeoutMs = 3000
): Promise<Diagnostic[]> {
  return (await waitForValue(() => client.diagnostics.get(uri), { timeoutMs })) ?? []
}

// =============================================================================
// Config Cache
// =============================================================================

const configCache = new Map<string, LspConfig>()

async function getConfig(cwd: string): Promise<LspConfig> {
  let config = configCache.get(cwd)
  if (!config) {
    config = await loadConfig(cwd)
    setIdleTimeout(config.idleTimeoutMs)
    configCache.set(cwd, config)
  }
  return config
}

// =============================================================================
// Diagnostics Helpers
// =============================================================================

async function _getDiagnosticsForFile(
  absolutePath: string,
  cwd: string,
  servers: Array<[string, ServerConfig]>,
  signal?: AbortSignal
): Promise<{ server?: string; messages: string[]; summary: string; errored: boolean } | undefined> {
  if (servers.length === 0) {
    return undefined
  }

  const uri = fileToUri(absolutePath)
  const relPath = path.relative(cwd, absolutePath)
  const allDiagnostics: Diagnostic[] = []
  const serverNames: string[] = []

  const results = await Promise.allSettled(
    servers.map(async ([serverName, serverConfig]) => {
      signal?.throwIfAborted()
      if (serverConfig.createClient) {
        const linterClient = getLinterClient(serverName, serverConfig, cwd)
        const diagnostics = await linterClient.lint(absolutePath)
        return { serverName, diagnostics }
      }

      const client = await getOrCreateClient(serverConfig, cwd)
      signal?.throwIfAborted()
      const diagnostics = await waitForDiagnostics(client, uri, 3000)
      return { serverName, diagnostics }
    })
  )

  for (const result of results) {
    if (result.status === 'fulfilled') {
      serverNames.push(result.value.serverName)
      allDiagnostics.push(...result.value.diagnostics)
    }
  }

  if (serverNames.length === 0) {
    return undefined
  }

  if (allDiagnostics.length === 0) {
    return {
      server: serverNames.join(', '),
      messages: [],
      summary: 'OK',
      errored: false
    }
  }

  const seen = new Set<string>()
  const uniqueDiagnostics: Diagnostic[] = []
  for (const d of allDiagnostics) {
    const key = `${d.range.start.line}:${d.range.start.character}:${d.range.end.line}:${d.range.end.character}:${d.message}`
    if (!seen.has(key)) {
      seen.add(key)
      uniqueDiagnostics.push(d)
    }
  }

  const formatted = uniqueDiagnostics.map((d) => formatDiagnostic(d, relPath))
  const summary = formatDiagnosticsSummary(uniqueDiagnostics)
  const hasErrors = uniqueDiagnostics.some((d) => d.severity === 1)

  return {
    server: serverNames.join(', '),
    messages: formatted,
    summary,
    errored: hasErrors
  }
}

async function runWorkspaceDiagnostics(
  cwd: string,
  config: LspConfig
): Promise<{ output: string; projectType: { type: string; description: string } }> {
  const projectType = detectProjectType(cwd)

  if (projectType.type === 'rust') {
    const rustServer = getRustServer(config)
    if (rustServer && hasCapability(rustServer[1], 'flycheck')) {
      const [, serverConfig] = rustServer
      try {
        const client = await getOrCreateClient(serverConfig, cwd)
        await rustAnalyzer.flycheck(client)

        const collected: Array<{ filePath: string; diagnostic: Diagnostic }> = []
        for (const [diagUri, diags] of client.diagnostics.entries()) {
          const relPath = path.relative(cwd, uriToFile(diagUri))
          for (const diag of diags) {
            collected.push({ filePath: relPath, diagnostic: diag })
          }
        }

        if (collected.length === 0) {
          return { output: 'No issues found', projectType }
        }

        const summary = formatDiagnosticsSummary(collected.map((d) => d.diagnostic))
        const formatted = collected
          .slice(0, 50)
          .map((d) => formatDiagnostic(d.diagnostic, d.filePath))
        const more = collected.length > 50 ? `\n  ... and ${collected.length - 50} more` : ''
        return {
          output: `${summary}:\n${formatted.map((f) => `  ${f}`).join('\n')}${more}`,
          projectType
        }
      } catch {
        // Fall through to shell command
      }
    }
  }

  if (!projectType.command) {
    return {
      output: `Cannot detect project type. Supported: Rust (Cargo.toml), TypeScript (tsconfig.json), Go (go.mod), Python (pyproject.toml)`,
      projectType
    }
  }

  try {
    const [command, ...args] = projectType.command
    const proc = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })

    let stdout = ''
    let stderr = ''
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    await new Promise<number | null>((resolve, reject) => {
      proc.once('error', reject)
      proc.once('exit', resolve)
    })

    const combined = (stdout + stderr).trim()
    if (!combined) {
      return { output: 'No issues found', projectType }
    }

    const lines = combined.split('\n')
    if (lines.length > 50) {
      return {
        output: `${lines.slice(0, 50).join('\n')}\n... and ${lines.length - 50} more lines`,
        projectType
      }
    }

    return { output: combined, projectType }
  } catch (e) {
    return { output: `Failed to run ${projectType.command.join(' ')}: ${e}`, projectType }
  }
}

// =============================================================================
// Extension Entry Point
// =============================================================================

function lspText(text: string, details: LspToolDetails) {
  return toolText(text, details)
}

function lspError(message: string, details: Omit<LspToolDetails, 'success'>) {
  const text =
    message.startsWith('Error:') || message.startsWith('LSP error:') ? message : `Error: ${message}`
  return toolText(text, { ...details, success: false }, { isError: true })
}

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd()

  pi.registerTool({
    name: 'lsp',
    label: 'LSP',
    description: DESCRIPTION,
    parameters: lspSchema,

    async execute(_toolCallId, params: LspParams) {
      const {
        action,
        file,
        files,
        line,
        column,
        end_line,
        end_character,
        query,
        new_name,
        replacement,
        kind,
        apply,
        action_index,
        include_declaration
      } = params

      const config = await getConfig(cwd)

      // Status action
      if (action === 'status') {
        const servers = Object.keys(config.servers)
        const projectType = detectProjectType(cwd)
        const lines = [`LSP status for ${cwd}`, `Detected project: ${projectType.description}`]

        if (servers.length > 0) {
          lines.push(`Active language servers: ${servers.join(', ')}`)
        } else {
          lines.push('Active language servers: none')
          lines.push('No configured server matched this directory and PATH.')
          lines.push(
            'Run from a project root with markers such as tsconfig.json, Cargo.toml, go.mod, or pyproject.toml, or add an lsp.json override.'
          )
        }

        return lspText(lines.join('\n'), { action, success: true })
      }

      // Workspace diagnostics
      if (action === 'workspace_diagnostics') {
        const result = await runWorkspaceDiagnostics(cwd, config)
        return lspText(
          `Workspace diagnostics (${result.projectType.description}):\n${result.output}`,
          {
            action,
            success: true
          }
        )
      }

      // Diagnostics (batch or single-file)
      if (action === 'diagnostics') {
        const targets = files?.length ? files : file ? [file] : null
        if (!targets) {
          return lspError('file or files parameter required for diagnostics', { action })
        }

        const detailed = Boolean(files?.length)
        const results: string[] = []
        const allServerNames = new Set<string>()

        for (const target of targets) {
          const resolved = resolveToCwd(target, cwd)
          const servers = getServersForFile(config, resolved)
          if (servers.length === 0) {
            results.push(`${target}: no language server found`)
            continue
          }

          const uri = fileToUri(resolved)
          const relPath = path.relative(cwd, resolved)
          const allDiagnostics: Diagnostic[] = []

          for (const [serverName, serverConfig] of servers) {
            allServerNames.add(serverName)
            try {
              if (serverConfig.createClient) {
                const linterClient = getLinterClient(serverName, serverConfig, cwd)
                const diagnostics = await linterClient.lint(resolved)
                allDiagnostics.push(...diagnostics)
                continue
              }
              const client = await getOrCreateClient(serverConfig, cwd)
              await refreshFile(client, resolved)
              const diagnostics = await waitForDiagnostics(client, uri)
              allDiagnostics.push(...diagnostics)
            } catch {
              // Server failed
            }
          }

          const seen = new Set<string>()
          const uniqueDiagnostics: Diagnostic[] = []
          for (const d of allDiagnostics) {
            const key = `${d.range.start.line}:${d.range.start.character}:${d.range.end.line}:${d.range.end.character}:${d.message}`
            if (!seen.has(key)) {
              seen.add(key)
              uniqueDiagnostics.push(d)
            }
          }

          if (!detailed && targets.length === 1) {
            if (uniqueDiagnostics.length === 0) {
              return lspText('No diagnostics', {
                action,
                serverName: Array.from(allServerNames).join(', '),
                success: true
              })
            }

            const summary = formatDiagnosticsSummary(uniqueDiagnostics)
            const formatted = uniqueDiagnostics.map((d) => formatDiagnostic(d, relPath))
            const output = `${summary}:\n${formatted.map((f) => `  ${f}`).join('\n')}`
            return lspText(output, {
              action,
              serverName: Array.from(allServerNames).join(', '),
              success: true
            })
          }

          if (uniqueDiagnostics.length === 0) {
            results.push(`${relPath}: no issues`)
          } else {
            const summary = formatDiagnosticsSummary(uniqueDiagnostics)
            results.push(`${relPath}: ${summary}`)
            for (const diag of uniqueDiagnostics) {
              results.push(`  ${formatDiagnostic(diag, relPath)}`)
            }
          }
        }

        return lspText(results.join('\n'), {
          action,
          serverName: Array.from(allServerNames).join(', '),
          success: true
        })
      }

      // Check if file is required
      const requiresFile =
        !file &&
        action !== 'workspace_symbols' &&
        action !== 'flycheck' &&
        action !== 'ssr' &&
        action !== 'runnables' &&
        action !== 'reload_workspace'

      if (requiresFile) {
        return lspError('file parameter required for this action', { action })
      }

      const resolvedFile = file ? resolveToCwd(file, cwd) : null
      const serverInfo = resolvedFile
        ? getLspServerForFile(config, resolvedFile)
        : getServerForWorkspaceAction(config, action)

      if (!serverInfo) {
        return lspError('No language server found for this action', { action })
      }

      const [serverName, serverConfig] = serverInfo

      try {
        const client = await getOrCreateClient(serverConfig, cwd)
        let targetFile = resolvedFile
        if (action === 'runnables' && !targetFile) {
          targetFile = findFileByExtensions(cwd, serverConfig.fileTypes)
          if (!targetFile) {
            return lspError('no matching files found for runnables', { action, serverName })
          }
        }

        if (targetFile) {
          await ensureFileOpen(client, targetFile)
        }

        const uri = targetFile ? fileToUri(targetFile) : ''
        const position = { line: (line || 1) - 1, character: (column || 1) - 1 }

        let output: string

        switch (action) {
          case 'definition': {
            const result = (await sendRequest(client, 'textDocument/definition', {
              textDocument: { uri },
              position
            })) as Location | Location[] | LocationLink | LocationLink[] | null

            if (!result) {
              output = 'No definition found'
            } else {
              const raw = Array.isArray(result) ? result : [result]
              const locations = raw.flatMap((loc) => {
                if ('uri' in loc) {
                  return [loc as Location]
                }
                if ('targetUri' in loc) {
                  const link = loc as LocationLink
                  return [
                    { uri: link.targetUri, range: link.targetSelectionRange ?? link.targetRange }
                  ]
                }
                return []
              })

              if (locations.length === 0) {
                output = 'No definition found'
              } else {
                output = `Found ${locations.length} definition(s):\n${locations
                  .map((loc) => `  ${formatLocation(loc, cwd)}`)
                  .join('\n')}`
              }
            }
            break
          }

          case 'references': {
            const result = (await sendRequest(client, 'textDocument/references', {
              textDocument: { uri },
              position,
              context: { includeDeclaration: include_declaration ?? true }
            })) as Location[] | null

            if (!result || result.length === 0) {
              output = 'No references found'
            } else {
              const lines = result.map((loc) => `  ${formatLocation(loc, cwd)}`)
              output = `Found ${result.length} reference(s):\n${lines.join('\n')}`
            }
            break
          }

          case 'hover': {
            const result = (await sendRequest(client, 'textDocument/hover', {
              textDocument: { uri },
              position
            })) as Hover | null

            if (!result || !result.contents) {
              output = 'No hover information'
            } else {
              output = extractHoverText(result.contents)
            }
            break
          }

          case 'symbols': {
            const result = (await sendRequest(client, 'textDocument/documentSymbol', {
              textDocument: { uri }
            })) as (DocumentSymbol | SymbolInformation)[] | null

            if (!result || result.length === 0) {
              output = 'No symbols found'
            } else if (!targetFile) {
              return lspError('file parameter required for symbols', { action, serverName })
            } else {
              const relPath = path.relative(cwd, targetFile)
              if ('selectionRange' in result[0]) {
                const lines = (result as DocumentSymbol[]).flatMap((s) => formatDocumentSymbol(s))
                output = `Symbols in ${relPath}:\n${lines.join('\n')}`
              } else {
                const lines = (result as SymbolInformation[]).map((s) => {
                  const line = s.location.range.start.line + 1
                  const icon = symbolKindToIcon(s.kind)
                  return `${icon} ${s.name} @ line ${line}`
                })
                output = `Symbols in ${relPath}:\n${lines.join('\n')}`
              }
            }
            break
          }

          case 'workspace_symbols': {
            if (!query) {
              return lspError('query parameter required for workspace_symbols', {
                action,
                serverName
              })
            }

            const result = (await sendRequest(client, 'workspace/symbol', { query })) as
              | SymbolInformation[]
              | null

            if (!result || result.length === 0) {
              output = `No symbols matching "${query}"`
            } else {
              const lines = result.map((s) => formatSymbolInformation(s, cwd))
              output = `Found ${result.length} symbol(s) matching "${query}":\n${lines.map((l) => `  ${l}`).join('\n')}`
            }
            break
          }

          case 'rename': {
            if (!new_name) {
              return lspError('new_name parameter required for rename', { action, serverName })
            }

            const result = (await sendRequest(client, 'textDocument/rename', {
              textDocument: { uri },
              position,
              newName: new_name
            })) as WorkspaceEdit | null

            if (!result) {
              output = 'Rename returned no edits'
            } else {
              const shouldApply = apply !== false
              if (shouldApply) {
                const applied = await applyWorkspaceEdit(result, cwd)
                output = `Applied rename:\n${applied.map((a) => `  ${a}`).join('\n')}`
              } else {
                const preview = formatWorkspaceEdit(result, cwd)
                output = `Rename preview:\n${preview.map((p) => `  ${p}`).join('\n')}`
              }
            }
            break
          }

          case 'actions': {
            if (!targetFile) {
              return lspError('file parameter required for actions', { action, serverName })
            }

            await refreshFile(client, targetFile)
            const diagnostics = await waitForDiagnostics(client, uri)
            const endLine = (end_line ?? line ?? 1) - 1
            const endCharacter = (end_character ?? column ?? 1) - 1
            const range = { start: position, end: { line: endLine, character: endCharacter } }
            const relevantDiagnostics = diagnostics.filter(
              (d) => d.range.start.line <= range.end.line && d.range.end.line >= range.start.line
            )

            const codeActionContext: { diagnostics: Diagnostic[]; only?: string[] } = {
              diagnostics: relevantDiagnostics
            }
            if (kind) {
              codeActionContext.only = [kind]
            }

            const result = (await sendRequest(client, 'textDocument/codeAction', {
              textDocument: { uri },
              range,
              context: codeActionContext
            })) as Array<CodeAction | Command> | null

            if (!result || result.length === 0) {
              output = 'No code actions available'
            } else if (action_index !== undefined) {
              if (action_index < 0 || action_index >= result.length) {
                return lspError(
                  `action_index ${action_index} out of range (0-${result.length - 1})`,
                  {
                    action,
                    serverName
                  }
                )
              }

              const isCommand = (candidate: CodeAction | Command): candidate is Command =>
                typeof (candidate as Command).command === 'string'
              const isCodeAction = (candidate: CodeAction | Command): candidate is CodeAction =>
                !isCommand(candidate)
              const getCommandPayload = (
                candidate: CodeAction | Command
              ): { command: string; arguments?: unknown[] } | null => {
                if (isCommand(candidate)) {
                  return { command: candidate.command, arguments: candidate.arguments }
                }
                if (candidate.command) {
                  return {
                    command: candidate.command.command,
                    arguments: candidate.command.arguments
                  }
                }
                return null
              }

              const codeAction = result[action_index]

              let resolvedAction = codeAction
              if (
                isCodeAction(codeAction) &&
                !codeAction.edit &&
                codeAction.data &&
                client.serverCapabilities?.codeActionProvider
              ) {
                const provider = client.serverCapabilities.codeActionProvider
                if (typeof provider === 'object' && provider.resolveProvider) {
                  resolvedAction = (await sendRequest(
                    client,
                    'codeAction/resolve',
                    codeAction
                  )) as CodeAction
                }
              }

              if (isCodeAction(resolvedAction) && resolvedAction.edit) {
                const applied = await applyWorkspaceEdit(resolvedAction.edit, cwd)
                output = `Applied "${codeAction.title}":\n${applied.map((a) => `  ${a}`).join('\n')}`
              } else {
                const commandPayload = getCommandPayload(resolvedAction)
                if (commandPayload) {
                  await sendRequest(client, 'workspace/executeCommand', commandPayload)
                  output = `Executed "${codeAction.title}"`
                } else {
                  output = `Code action "${codeAction.title}" has no edits or command to apply`
                }
              }
            } else {
              const lines = result.map((actionItem, i) => {
                if ('kind' in actionItem || 'isPreferred' in actionItem || 'edit' in actionItem) {
                  const actionDetails = actionItem as CodeAction
                  const preferred = actionDetails.isPreferred ? ' (preferred)' : ''
                  const kindInfo = actionDetails.kind ? ` [${actionDetails.kind}]` : ''
                  return `  [${i}] ${actionDetails.title}${kindInfo}${preferred}`
                }
                return `  [${i}] ${actionItem.title}`
              })
              output = `Available code actions:\n${lines.join('\n')}\n\nUse action_index parameter to apply a specific action.`
            }
            break
          }

          case 'incoming_calls':
          case 'outgoing_calls': {
            const prepareResult = (await sendRequest(client, 'textDocument/prepareCallHierarchy', {
              textDocument: { uri },
              position
            })) as CallHierarchyItem[] | null

            if (!prepareResult || prepareResult.length === 0) {
              output = 'No callable symbol found at this position'
              break
            }

            const item = prepareResult[0]

            if (action === 'incoming_calls') {
              const calls = (await sendRequest(client, 'callHierarchy/incomingCalls', { item })) as
                | CallHierarchyIncomingCall[]
                | null

              if (!calls || calls.length === 0) {
                output = `No callers found for "${item.name}"`
              } else {
                const lines = calls.map((call) => {
                  const loc = { uri: call.from.uri, range: call.from.selectionRange }
                  const detail = call.from.detail ? ` (${call.from.detail})` : ''
                  return `  ${call.from.name}${detail} @ ${formatLocation(loc, cwd)}`
                })
                output = `Found ${calls.length} caller(s) of "${item.name}":\n${lines.join('\n')}`
              }
            } else {
              const calls = (await sendRequest(client, 'callHierarchy/outgoingCalls', { item })) as
                | CallHierarchyOutgoingCall[]
                | null

              if (!calls || calls.length === 0) {
                output = `"${item.name}" doesn't call any functions`
              } else {
                const lines = calls.map((call) => {
                  const loc = { uri: call.to.uri, range: call.to.selectionRange }
                  const detail = call.to.detail ? ` (${call.to.detail})` : ''
                  return `  ${call.to.name}${detail} @ ${formatLocation(loc, cwd)}`
                })
                output = `"${item.name}" calls ${calls.length} function(s):\n${lines.join('\n')}`
              }
            }
            break
          }

          // Rust-analyzer specific
          case 'flycheck': {
            if (!hasCapability(serverConfig, 'flycheck')) {
              return lspError('flycheck requires rust-analyzer', { action, serverName })
            }

            await rustAnalyzer.flycheck(client, resolvedFile ?? undefined)
            const collected: Array<{ filePath: string; diagnostic: Diagnostic }> = []
            for (const [diagUri, diags] of client.diagnostics.entries()) {
              const relPath = path.relative(cwd, uriToFile(diagUri))
              for (const diag of diags) {
                collected.push({ filePath: relPath, diagnostic: diag })
              }
            }

            if (collected.length === 0) {
              output = 'Flycheck: no issues found'
            } else {
              const summary = formatDiagnosticsSummary(collected.map((d) => d.diagnostic))
              const formatted = collected
                .slice(0, 20)
                .map((d) => formatDiagnostic(d.diagnostic, d.filePath))
              const more = collected.length > 20 ? `\n  ... and ${collected.length - 20} more` : ''
              output = `Flycheck ${summary}:\n${formatted.map((f) => `  ${f}`).join('\n')}${more}`
            }
            break
          }

          case 'expand_macro': {
            if (!hasCapability(serverConfig, 'expandMacro')) {
              return lspError('expand_macro requires rust-analyzer', { action, serverName })
            }

            if (!targetFile) {
              return lspError('file parameter required for expand_macro', { action, serverName })
            }

            const result = await rustAnalyzer.expandMacro(
              client,
              targetFile,
              line || 1,
              column || 1
            )
            if (!result) {
              output = 'No macro expansion at this position'
            } else {
              output = `Macro: ${result.name}\n\nExpansion:\n${result.expansion}`
            }
            break
          }

          case 'ssr': {
            if (!hasCapability(serverConfig, 'ssr')) {
              return lspError('ssr requires rust-analyzer', { action, serverName })
            }

            if (!query) {
              return lspError('query parameter (pattern) required for ssr', { action, serverName })
            }

            if (!replacement) {
              return lspError('replacement parameter required for ssr', { action, serverName })
            }

            const shouldApply = apply === true
            const result = await rustAnalyzer.ssr(client, query, replacement, !shouldApply)

            if (shouldApply) {
              const applied = await applyWorkspaceEdit(result, cwd)
              output =
                applied.length > 0
                  ? `Applied SSR:\n${applied.map((a) => `  ${a}`).join('\n')}`
                  : 'SSR: no matches found'
            } else {
              const preview = formatWorkspaceEdit(result, cwd)
              output =
                preview.length > 0
                  ? `SSR preview:\n${preview.map((p) => `  ${p}`).join('\n')}`
                  : 'SSR: no matches found'
            }
            break
          }

          case 'runnables': {
            if (!hasCapability(serverConfig, 'runnables')) {
              return lspError('runnables requires rust-analyzer', { action, serverName })
            }

            if (!targetFile) {
              return lspError('file parameter required for runnables', { action, serverName })
            }

            const result = await rustAnalyzer.runnables(client, targetFile, line)
            if (result.length === 0) {
              output = 'No runnables found'
            } else {
              const lines = result.map((r) => {
                const args = r.args?.cargoArgs?.join(' ') || ''
                return `  [${r.kind}] ${r.label}${args ? ` (cargo ${args})` : ''}`
              })
              output = `Found ${result.length} runnable(s):\n${lines.join('\n')}`
            }
            break
          }

          case 'related_tests': {
            if (!hasCapability(serverConfig, 'relatedTests')) {
              return lspError('related_tests requires rust-analyzer', { action, serverName })
            }

            if (!targetFile) {
              return lspError('file parameter required for related_tests', { action, serverName })
            }

            const result = await rustAnalyzer.relatedTests(
              client,
              targetFile,
              line || 1,
              column || 1
            )
            if (result.length === 0) {
              output = 'No related tests found'
            } else {
              output = `Found ${result.length} related test(s):\n${result.map((t) => `  ${t}`).join('\n')}`
            }
            break
          }

          case 'reload_workspace': {
            await rustAnalyzer.reloadWorkspace(client)
            output = 'Workspace reloaded successfully'
            break
          }

          default:
            output = `Unknown action: ${action}`
        }

        return lspText(output, { serverName, action, success: true, file: targetFile ?? undefined })
      } catch (err) {
        return lspError(`LSP error: ${errorMessage(err)}`, {
          serverName,
          action,
          file: resolvedFile ?? undefined
        })
      }
    },

    renderCall(args, theme) {
      const p = (args ?? {}) as Partial<LspParams & { file?: string; files?: string[] }>

      return renderToolCall(theme, 'lsp', {
        segments: [
          { text: p.action },
          {
            text: p.file ?? (p.files?.length ? `${p.files.length} file(s)` : undefined),
            color: 'muted'
          }
        ]
      })
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as LspToolDetails | undefined
      const text = firstText(result)

      if (!text) return renderError('No result', theme)
      if (!details?.success) return renderError(text, theme)

      // Detect language from file path
      const fileLang = details.file ? getLanguageFromPath(details.file) : undefined

      // Detect code blocks and apply syntax highlighting
      const formatOutput = (raw: string): string => {
        // Match ```language ... ``` blocks, use detected lang as fallback
        return raw.replace(/```(\w+)?\n([\s\S]*?)```/g, (_match, blockLang, code) => {
          const language = blockLang || fileLang || 'text'
          const highlighted = highlightCode(code.trim(), language)
          return highlighted.join('\n')
        })
      }

      const lines = formatOutput(text).split('\n')
      const PREVIEW_LINES = 8
      const shown = expanded ? lines : lines.slice(0, PREVIEW_LINES)
      const hiddenCount = expanded ? 0 : lines.length - shown.length

      return renderLines([
        theme.fg('muted', details.action),
        ...shown,
        ...(hiddenCount > 0
          ? [theme.fg('dim', `… ${hiddenCount} more lines`), expandHint(theme)]
          : [])
      ])
    }
  })

  // Cleanup on shutdown
  pi.on('session_shutdown', async () => {
    shutdownAll()
    configCache.clear()
  })
}
