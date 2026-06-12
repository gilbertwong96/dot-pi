/**
 * Background Process Manager
 *
 * Start, stop, and monitor long-running processes (dev servers, watchers) without blocking.
 *
 * Storage: /tmp/pi-bg/<project-hash>/<name>.{pid,log,json}
 * The .json file stores metadata (cwd, command) for display purposes.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { DynamicBorder, truncateTail } from '@earendil-works/pi-coding-agent'
import { Container, Text } from '@earendil-works/pi-tui'
import {
  firstText,
  meta,
  primary,
  renderError,
  renderLines,
  renderMuted,
  renderToolCall,
  title,
  toolError,
  toolText
} from './shared/render'
import { Type } from 'typebox'
import { spawn, spawnSync } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

const BASE_DIR = '/tmp/pi-bg'
const BACKGROUND_SYSTEM_HINT =
  'Use background-start, not bash, for long-running dev servers/watchers.'

interface ProcessMeta {
  projectDir: string
  cwd?: string
  command: string
}

interface ProcessInfo {
  name: string
  pid: number
  running: boolean
  logFile: string
  cwd?: string
  error?: boolean
}

interface StopDetails {
  name: string
  error?: boolean
}

interface LogsDetails {
  name: string
  logs: string
  error?: boolean
}

export function normalizeProjectDir(projectDir?: string): string {
  return projectDir || process.cwd()
}

function getProjectDir(projectDir?: string): string {
  const dir = normalizeProjectDir(projectDir)
  const hash = crypto.createHash('sha256').update(dir).digest('hex').slice(0, 12)
  const name = path.basename(dir)
  return path.join(BASE_DIR, `${name}-${hash}`)
}

export function buildBackgroundSystemPrompt(systemPrompt: string): string {
  return systemPrompt.includes(BACKGROUND_SYSTEM_HINT)
    ? systemPrompt
    : `${systemPrompt}\n\n${BACKGROUND_SYSTEM_HINT}`
}

function ensureProjectDir(projectDir?: string): string {
  const dir = getProjectDir(projectDir)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function getRelativeCwd(projectDir: string, cwd: string): string | undefined {
  if (cwd === projectDir) return undefined
  if (cwd.startsWith(projectDir + '/')) {
    return path.relative(projectDir, cwd)
  }
  return cwd
}

function listProcesses(projectDir: string): ProcessInfo[] {
  let projectDirs: string[]
  try {
    projectDirs = fs.readdirSync(BASE_DIR).map((d) => path.join(BASE_DIR, d))
  } catch {
    return []
  }

  const results: ProcessInfo[] = []

  for (const dir of projectDirs) {
    let files: string[]
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.pid'))
    } catch {
      continue
    }

    for (const file of files) {
      const name = file.slice(0, -4)
      const pidFile = path.join(dir, file)
      const logFile = path.join(dir, `${name}.log`)
      const metaFile = path.join(dir, `${name}.json`)

      let meta: ProcessMeta
      try {
        meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
      } catch {
        continue
      }

      // Filter: only show processes from this project or its subdirectories
      if (!meta.projectDir.startsWith(projectDir)) continue

      let pid = 0
      let running = false

      try {
        pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10)
        process.kill(pid, 0)
        running = true
      } catch {
        running = false
      }

      // Calculate display cwd relative to current projectDir
      let cwd: string | undefined
      if (meta.projectDir !== projectDir) {
        const relProject = path.relative(projectDir, meta.projectDir)
        cwd = meta.cwd ? path.join(relProject, meta.cwd) : relProject
      } else {
        cwd = meta.cwd
      }

      results.push({ name, pid, running, logFile, cwd })
    }
  }

  return results
}

function startProcess(
  projectDir: string | undefined,
  name: string,
  command: string,
  cwd?: string
): ProcessInfo {
  projectDir = normalizeProjectDir(projectDir)
  const dir = ensureProjectDir(projectDir)
  const pidFile = path.join(dir, `${name}.pid`)
  const logFile = path.join(dir, `${name}.log`)
  const metaFile = path.join(dir, `${name}.json`)

  const existing = listProcesses(projectDir).find((p) => p.name === name && p.running)
  if (existing) {
    throw new Error(`Process "${name}" already running (PID ${existing.pid})`)
  }

  const actualCwd = cwd || projectDir
  const relativeCwd = getRelativeCwd(projectDir, actualCwd)
  const logFd = fs.openSync(logFile, 'w')

  const child = spawn('bash', ['-c', command], {
    cwd: actualCwd,
    detached: true,
    stdio: ['ignore', logFd, logFd]
  })

  const pid = child.pid
  if (!pid) {
    fs.closeSync(logFd)
    throw new Error('Failed to start process')
  }

  child.unref()
  fs.writeFileSync(pidFile, pid.toString())

  const meta: ProcessMeta = { projectDir, command, cwd: relativeCwd }
  fs.writeFileSync(metaFile, JSON.stringify(meta))

  return { name, pid, running: true, logFile, cwd: relativeCwd }
}

function findProcessDir(projectDir: string, name: string): string | null {
  const processes = listProcesses(projectDir)
  const proc = processes.find((p) => p.name === name)
  if (!proc) return null
  return path.dirname(proc.logFile)
}

function stopProcess(projectDir: string, name: string): void {
  const dir = findProcessDir(projectDir, name)
  if (!dir) {
    throw new Error(`Process "${name}" not found`)
  }

  const pidFile = path.join(dir, `${name}.pid`)
  const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10)

  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Process already dead
  }

  fs.unlinkSync(pidFile)
  try {
    fs.unlinkSync(path.join(dir, `${name}.json`))
  } catch {
    /* ignore */
  }
}

function stripProgressNoise(text: string): string {
  // eslint-disable-next-line no-control-regex
  let clean = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')

  clean = clean
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line
      const parts = line.split('\r')
      return parts[parts.length - 1]
    })
    .join('\n')

  return clean
}

function readLogs(projectDir: string, name: string, lines: number): string {
  const dir = findProcessDir(projectDir, name)
  if (!dir) {
    throw new Error(`Log file for "${name}" not found`)
  }
  const logFile = path.join(dir, `${name}.log`)

  if (!fs.existsSync(logFile)) {
    throw new Error(`Log file for "${name}" not found`)
  }

  const result = spawnSync('tail', ['-n', lines.toString(), logFile], {
    encoding: 'utf8'
  })

  const raw = stripProgressNoise(result.stdout || result.stderr || '')
  const truncation = truncateTail(raw, { maxLines: lines })

  if (truncation.truncated) {
    return `[truncated: showing last ${truncation.outputLines} lines / ${truncation.outputBytes} bytes]\n${truncation.content}`
  }

  return truncation.content
}

function readFullLogs(projectDir: string, name: string): string {
  const dir = findProcessDir(projectDir, name)
  if (!dir) {
    throw new Error(`Log file for "${name}" not found`)
  }
  const logFile = path.join(dir, `${name}.log`)

  if (!fs.existsSync(logFile)) {
    throw new Error(`Log file for "${name}" not found`)
  }

  return fs.readFileSync(logFile, 'utf8')
}

function getChildPids(pid: number): number[] {
  try {
    const result = spawnSync('pgrep', ['-P', pid.toString()], {
      encoding: 'utf8',
      timeout: 500
    })
    if (!result.stdout) return []
    return result.stdout
      .trim()
      .split('\n')
      .map((s) => parseInt(s, 10))
      .filter((n) => n > 0)
  } catch {
    return []
  }
}

function getListeningPorts(pid: number): number[] {
  const pids = [pid, ...getChildPids(pid)]
  const ports = new Set<number>()

  for (const p of pids) {
    try {
      const result = spawnSync(
        'lsof',
        ['-iTCP', '-sTCP:LISTEN', '-P', '-n', '-a', '-p', p.toString()],
        {
          encoding: 'utf8',
          timeout: 500
        }
      )
      if (!result.stdout) continue
      for (const line of result.stdout.split('\n').slice(1)) {
        const match = line.match(/:(\d+)\s+\(LISTEN\)/)
        if (match) ports.add(parseInt(match[1], 10))
      }
    } catch {
      continue
    }
  }
  return [...ports]
}

function getDisplayName(proc: ProcessInfo): string {
  if (proc.cwd) {
    return proc.cwd + '/' + proc.name
  }
  return proc.name
}

function renderProcessRow(
  theme: Parameters<typeof title>[1],
  name: string,
  status: string,
  extra?: string
): string[] {
  return [title(name, theme) + '  ' + meta(status, theme), ...(extra ? [meta(extra, theme)] : [])]
}

function updateStatus(ctx: ExtensionContext) {
  const running = listProcesses(ctx.cwd).filter((p) => p.running)
  if (running.length === 0) {
    ctx.ui.setStatus('background', undefined)
    ctx.ui.setWidget('background-logs', undefined)
  } else {
    const theme = ctx.ui.theme
    const items = running
      .map((p) => {
        const display = getDisplayName(p)
        const ports = getListeningPorts(p.pid)
        if (ports.length > 0) {
          return display + ':' + theme.fg('accent', ports.join(','))
        }
        return display
      })
      .join(' ')
    ctx.ui.setStatus('background', theme.fg('success', '●') + ' ' + items)

    ctx.ui.setWidget(
      'background-logs',
      (_tui, theme) => {
        const container = new Container()
        container.addChild(new DynamicBorder((s) => theme.fg('border', s)))
        for (const proc of running) {
          const displayName = getDisplayName(proc)
          try {
            const logs = readLogs(ctx.cwd, proc.name, 2)
            container.addChild(new Text(theme.fg('muted', ` ${displayName} `), 0, 0))
            if (logs.trim()) {
              for (const line of logs.trim().split('\n')) {
                container.addChild(new Text(theme.fg('dim', ` ${line}`), 0, 0))
              }
            }
          } catch {
            container.addChild(new Text(theme.fg('muted', ` ${displayName} `), 0, 0))
            container.addChild(new Text(theme.fg('dim', ' (no logs)'), 0, 0))
          }
        }
        container.addChild(new DynamicBorder((s) => theme.fg('border', s)))
        return container
      },
      { placement: 'belowEditor' }
    )
  }
}

export default function (pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => updateStatus(ctx))
  pi.on('turn_start', (_event, ctx) => updateStatus(ctx))
  pi.on('turn_end', (_event, ctx) => updateStatus(ctx))
  pi.on('before_agent_start', (event) => ({
    systemPrompt: buildBackgroundSystemPrompt(event.systemPrompt)
  }))

  pi.registerCommand('kill', {
    description: 'Stop a background process',
    getArgumentCompletions(prefix) {
      const running = listProcesses(process.cwd()).filter((p) => p.running)
      if (running.length === 0) return null
      const filtered = prefix
        ? running.filter((p) => p.name.toLowerCase().startsWith(prefix.toLowerCase()))
        : running
      return filtered.map((p) => ({
        value: p.name,
        label: p.name,
        description: `PID ${p.pid}`
      }))
    },
    async handler(args, ctx) {
      const name = args.trim()
      if (!name) {
        ctx.ui.notify('Usage: /kill <process-name>', 'info')
        return
      }
      try {
        stopProcess(ctx.cwd, name)
        updateStatus(ctx)
        ctx.ui.notify(`Stopped "${name}"`, 'info')
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), 'error')
      }
    }
  })

  pi.registerCommand('logs', {
    description: 'View full logs from a background process',
    getArgumentCompletions(prefix) {
      const processes = listProcesses(process.cwd())
      if (processes.length === 0) return null
      const filtered = prefix
        ? processes.filter((p) => p.name.toLowerCase().startsWith(prefix.toLowerCase()))
        : processes
      return filtered.map((p) => ({
        value: p.name,
        label: p.name,
        description: p.running ? `PID ${p.pid}` : 'stopped'
      }))
    },
    async handler(args, ctx) {
      const name = args.trim()
      const processes = listProcesses(ctx.cwd)

      if (!name) {
        const running = processes.filter((p) => p.running)
        if (running.length === 0) {
          ctx.ui.notify('No background processes running', 'info')
          return
        }
        if (running.length === 1) {
          const logs = readFullLogs(ctx.cwd, running[0].name)
          await ctx.ui.editor(`Logs: ${running[0].name}`, logs)
          return
        }
        ctx.ui.notify('Usage: /logs <process-name>', 'info')
        return
      }

      const proc = processes.find((p) => p.name === name)
      if (!proc) {
        ctx.ui.notify(`Process "${name}" not found`, 'error')
        return
      }

      try {
        const logs = readFullLogs(ctx.cwd, name)
        await ctx.ui.editor(`Logs: ${name}`, logs)
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), 'error')
      }
    }
  })

  pi.registerTool({
    name: 'background-start',
    label: 'Start Background',
    description:
      'Start a long-running process in background (dev server, watcher, etc.). Use for commands that keep running, such as dev servers, watchers, serve, run dev, start, or launch. Do not use for regular commands; use bash instead.',
    parameters: Type.Object({
      name: Type.String({
        description:
          "Unique name for this process (e.g., 'beebro-server', 'vite-dev'). Use kebab-case."
      }),
      command: Type.String({
        description: 'Shell command to run (e.g., "bun run dev", "npm start")'
      }),
      cwd: Type.Optional(
        Type.String({
          description: 'Working directory (defaults to current directory)'
        })
      )
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const info = startProcess(ctx.cwd, params.name, params.command, params.cwd)
        updateStatus(ctx)
        return toolText(`Started "${info.name}" (PID ${info.pid})\nLogs: ${info.logFile}`, info)
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err), {
          name: params.name,
          pid: 0,
          running: false,
          logFile: '',
          error: true
        } satisfies ProcessInfo)
      }
    },

    renderCall(args, theme) {
      const safeArgs = args ?? {}
      return renderToolCall(theme, 'bg start', {
        segments: [
          { text: safeArgs.name },
          { text: safeArgs.command ? `→ ${safeArgs.command}` : undefined, color: 'dim' }
        ]
      })
    },

    renderResult(result, _options, theme) {
      const details = result.details as ProcessInfo
      if (details.error) return renderError(firstText(result, 'Error'), theme)
      return renderLines(
        renderProcessRow(theme, details.name, `running  PID ${details.pid}`, details.cwd)
      )
    }
  })

  pi.registerTool({
    name: 'background-stop',
    label: 'Stop Background',
    description:
      'Stop a running background process. Use when you need to stop a dev server or watcher that was started with background-start.',
    parameters: Type.Object({
      name: Type.String({
        description: 'Name of the process to stop (as given to background-start)'
      })
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        stopProcess(ctx.cwd, params.name)
        updateStatus(ctx)
        return toolText(`Stopped "${params.name}"`, { name: params.name } satisfies StopDetails)
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err), {
          name: params.name,
          error: true
        } satisfies StopDetails)
      }
    },

    renderCall(args, theme) {
      const safeArgs = args ?? {}
      return renderToolCall(theme, 'bg stop', { segments: [{ text: safeArgs.name }] })
    },

    renderResult(result, _options, theme) {
      const details = result.details as StopDetails
      if (details.error) return renderError(firstText(result, 'Error'), theme)
      return renderLines(renderProcessRow(theme, details.name, 'stopped'))
    }
  })

  pi.registerTool({
    name: 'background-list',
    label: 'List Background',
    description:
      "List all background processes and their status. Use to see what's currently running.",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const processes = listProcesses(ctx.cwd)

      if (processes.length === 0) {
        return toolText('No background processes', { processes: [] as ProcessInfo[] })
      }

      const lines = processes.map((p) => {
        const displayName = getDisplayName(p)
        const status = p.running ? `running (PID ${p.pid})` : 'stopped'
        return `${displayName}: ${status}`
      })

      return toolText(lines.join('\n'), { processes })
    },

    renderCall(_args, theme) {
      return new Text(theme.fg('toolTitle', theme.bold('bg list')), 0, 0)
    },

    renderResult(result, _options, theme) {
      const details = result.details as { processes: ProcessInfo[] }
      if (details.processes.length === 0) return renderMuted('No processes', theme)

      const lines = details.processes.flatMap((p, index) => [
        ...(index > 0 ? [''] : []),
        ...renderProcessRow(theme, p.name, p.running ? `running  PID ${p.pid}` : 'stopped', p.cwd)
      ])

      return renderLines(lines)
    }
  })

  pi.registerTool({
    name: 'background-logs',
    label: 'Background Logs',
    description:
      'Read logs from a background process. Use to check output from a running dev server or watcher.',
    parameters: Type.Object({
      name: Type.String({
        description: 'Name of the process'
      }),
      lines: Type.Optional(
        Type.Number({
          description: 'Number of lines to read (default: 50)',
          default: 50
        })
      )
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const logs = readLogs(ctx.cwd, params.name, params.lines ?? 50)
        return toolText(logs, { name: params.name, logs } satisfies LogsDetails)
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err), {
          name: params.name,
          logs: '',
          error: true
        } satisfies LogsDetails)
      }
    },

    renderCall(args, theme) {
      const safeArgs = args ?? {}
      return renderToolCall(theme, 'bg logs', {
        segments: [{ text: safeArgs.name }],
        suffix: safeArgs.lines ? `${safeArgs.lines} lines` : undefined
      })
    },

    renderResult(result, _options, theme) {
      const details = result.details as LogsDetails
      if (details.error) return renderError(firstText(result, 'Error'), theme)
      if (!details.logs.trim()) return renderMuted('(empty)', theme)
      const preview = details.logs.split('\n').slice(-3)
      return renderLines([
        ...renderProcessRow(theme, details.name, `logs  last ${preview.length}`),
        '',
        ...preview.map((line) => primary(line, theme))
      ])
    }
  })
}
