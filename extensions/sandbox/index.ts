/**
 * Sandbox Extension - OS-level sandboxing for bash commands
 *
 * Uses @anthropic-ai/sandbox-runtime to enforce filesystem and network
 * restrictions on bash commands at the OS level (sandbox-exec on macOS,
 * bubblewrap on Linux).
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/sandbox.json (global)
 * - <cwd>/.pi/sandbox.json (project-local)
 *
 * Usage:
 * - `pi -e ./sandbox` - sandbox enabled with default/config settings
 * - `pi -e ./sandbox --no-sandbox` - disable sandboxing
 * - `/sandbox` - show current sandbox configuration
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type BashOperations,
  createBashTool,
  type ExtensionAPI,
  type ExtensionContext
} from '@earendil-works/pi-coding-agent'
import { errorMessage } from '../shared/errors'
import { parseJsonObject } from '../shared/json'

interface SandboxNetworkConfig {
  allowedDomains?: string[]
  deniedDomains?: string[]
}

interface SandboxFilesystemConfig {
  denyRead?: string[]
  allowWrite?: string[]
  denyWrite?: string[]
}

interface SandboxRuntimeConfig {
  network?: SandboxNetworkConfig
  filesystem?: SandboxFilesystemConfig
  ignoreViolations?: Record<string, string[]>
  enableWeakerNestedSandbox?: boolean
}

interface SandboxConfig extends SandboxRuntimeConfig {
  enabled?: boolean
}

interface SandboxViolation {
  line: string
}

type SandboxAskCallback = (target: { host: string; port?: number | string }) => Promise<boolean>

interface SandboxManagerApi {
  initialize: (
    config: SandboxRuntimeConfig,
    askCallback: SandboxAskCallback,
    enableLogMonitor: boolean
  ) => Promise<void>
  reset: () => Promise<void>
  wrapWithSandbox: (command: string) => Promise<string>
  annotateStderrWithSandboxFailures: (command: string, stderr: string) => string
  getSandboxViolationStore: () => {
    subscribe: (listener: (violations: SandboxViolation[]) => void) => () => void
    getViolationsForCommand: (command: string) => SandboxViolation[]
  }
}

const require = createRequire(import.meta.url)
let loadedSandboxManager: SandboxManagerApi | null | undefined

async function loadSandboxManager(): Promise<SandboxManagerApi | null> {
  if (loadedSandboxManager !== undefined) return loadedSandboxManager

  try {
    const module = require('@anthropic-ai/sandbox-runtime') as {
      SandboxManager?: SandboxManagerApi
    }
    loadedSandboxManager = module.SandboxManager ?? null
    return loadedSandboxManager
  } catch {
    loadedSandboxManager = null
    return null
  }
}

const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  network: {
    allowedDomains: [
      // Package registries
      'npmjs.org',
      '*.npmjs.org',
      'registry.npmjs.org',
      'registry.yarnpkg.com',
      'pypi.org',
      '*.pypi.org',
      'rubygems.org',
      '*.rubygems.org',
      // GitHub
      'github.com',
      '*.github.com',
      'api.github.com',
      'raw.githubusercontent.com',
      // Bun
      'bun.sh',
      '*.bun.sh',
      // LLM APIs
      '*.googleapis.com',
      '*.google.com',
      '*.anthropic.com',
      '*.openai.com'
    ],
    deniedDomains: []
  },
  filesystem: {
    denyRead: ['~/.ssh', '~/.aws', '~/.gnupg', '~/.config/gh'],
    allowWrite: ['.', '/tmp', '/private/tmp', '/var/folders', '/private/var/folders', '~/.bun'],
    denyWrite: ['.env', '.env.*', '*.pem', '*.key']
  }
}

function loadConfig(cwd: string): SandboxConfig {
  const projectConfigPath = join(cwd, '.pi', 'sandbox.json')
  const globalConfigPath = join(homedir(), '.pi', 'agent', 'sandbox.json')

  let globalConfig: Partial<SandboxConfig> = {}
  let projectConfig: Partial<SandboxConfig> = {}

  if (existsSync(globalConfigPath)) {
    try {
      globalConfig = parseJsonObject(readFileSync(globalConfigPath, 'utf-8')) ?? {}
    } catch (e) {
      console.error(`Warning: Could not parse ${globalConfigPath}: ${errorMessage(e)}`)
    }
  }

  if (existsSync(projectConfigPath)) {
    try {
      projectConfig = parseJsonObject(readFileSync(projectConfigPath, 'utf-8')) ?? {}
    } catch (e) {
      console.error(`Warning: Could not parse ${projectConfigPath}: ${errorMessage(e)}`)
    }
  }

  return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig)
}

function deepMerge(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
  const result: SandboxConfig = { ...base }

  if (overrides.enabled !== undefined) result.enabled = overrides.enabled
  if (overrides.network) {
    result.network = { ...base.network, ...overrides.network }
  }
  if (overrides.filesystem) {
    result.filesystem = { ...base.filesystem, ...overrides.filesystem }
  }

  const extOverrides = overrides as {
    ignoreViolations?: Record<string, string[]>
    enableWeakerNestedSandbox?: boolean
  }
  const extResult = result as {
    ignoreViolations?: Record<string, string[]>
    enableWeakerNestedSandbox?: boolean
  }

  if (extOverrides.ignoreViolations) {
    extResult.ignoreViolations = extOverrides.ignoreViolations
  }
  if (extOverrides.enableWeakerNestedSandbox !== undefined) {
    extResult.enableWeakerNestedSandbox = extOverrides.enableWeakerNestedSandbox
  }

  return result
}

function createSandboxedBashOps(_command?: string): BashOperations {
  return {
    async exec(cmd, cwd, { onData, signal, timeout }) {
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`)
      }

      const sandboxManager = await loadSandboxManager()
      if (!sandboxManager) {
        throw new Error(
          'Sandbox runtime is not installed. Re-run without the sandbox extension or install @anthropic-ai/sandbox-runtime.'
        )
      }

      const wrappedCommand = await sandboxManager.wrapWithSandbox(cmd)
      let stderrBuffer = ''

      return new Promise((resolve, reject) => {
        const child = spawn('bash', ['-c', wrappedCommand], {
          cwd,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })

        let timedOut = false
        let timeoutHandle: NodeJS.Timeout | undefined

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true
            if (child.pid) {
              try {
                process.kill(-child.pid, 'SIGKILL')
              } catch {
                child.kill('SIGKILL')
              }
            }
          }, timeout * 1000)
        }

        child.stdout?.on('data', onData)
        child.stderr?.on('data', (data: Buffer) => {
          stderrBuffer += data.toString()
          onData(data)
        })

        child.on('error', (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle)
          reject(err)
        })

        const onAbort = () => {
          if (child.pid) {
            try {
              process.kill(-child.pid, 'SIGKILL')
            } catch {
              child.kill('SIGKILL')
            }
          }
        }

        signal?.addEventListener('abort', onAbort, { once: true })

        child.on('close', (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle)
          signal?.removeEventListener('abort', onAbort)

          if (signal?.aborted) {
            reject(new Error('aborted'))
          } else if (timedOut) {
            reject(new Error(`timeout:${timeout}`))
          } else {
            // Check for sandbox violations and annotate output
            const annotated = sandboxManager.annotateStderrWithSandboxFailures(cmd, stderrBuffer)
            if (annotated !== stderrBuffer) {
              // There were violations - send the annotation as additional output
              const annotation = annotated.slice(stderrBuffer.length)
              if (annotation) {
                onData(Buffer.from(annotation))
              }

              // Parse violations and suggest config fixes
              const violations = sandboxManager
                .getSandboxViolationStore()
                .getViolationsForCommand(cmd)
              const pathsToAllow = new Set<string>()

              for (const v of violations) {
                // Extract path from violation line like "bun(57060) deny(1) file-write-create /private/tmp/.xxx"
                const match = v.line.match(/file-(?:write|read)[^\s]*\s+(\S+)/)
                if (match) {
                  // Get parent directory for the suggestion
                  const path = match[1]
                  const parentDir = path.replace(/\/[^/]+$/, '')
                  if (parentDir && parentDir !== path) {
                    pathsToAllow.add(parentDir)
                  }
                }
              }

              if (pathsToAllow.size > 0) {
                const suggestion = `\n\n<sandbox_config_suggestion>\nTo allow these operations, add to ~/.pi/agent/sandbox.json or .pi/sandbox.json:\n{\n  "filesystem": {\n    "allowWrite": ${JSON.stringify(Array.from(pathsToAllow))}\n  }\n}\nThen restart the session.\n</sandbox_config_suggestion>\n`
                onData(Buffer.from(suggestion))
              }
            }
            resolve({ exitCode: code })
          }
        })
      })
    }
  }
}

// Track allowed domains for this session (user approved)
const sessionAllowedDomains = new Set<string>()

// Create the ask callback that prompts user for network permission
function createAskCallback(ctx: ExtensionContext): SandboxAskCallback {
  return async ({ host, port }) => {
    const target = port ? `${host}:${port}` : host

    // Check if already approved this session
    if (sessionAllowedDomains.has(host) || sessionAllowedDomains.has(target)) {
      return true
    }

    const allowed = await ctx.ui.confirm('Network Access', `Allow connection to ${target}?`)

    if (allowed) {
      sessionAllowedDomains.add(host)
      ctx.ui.notify(`Allowed: ${target}`, 'info')
    } else {
      ctx.ui.notify(`Blocked: ${target}`, 'warning')
    }

    return allowed
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag('no-sandbox', {
    description: 'Disable OS-level sandboxing for bash commands',
    type: 'boolean',
    default: false
  })

  const localCwd = process.cwd()
  const localBash = createBashTool(localCwd)

  let sandboxEnabled = false
  let sandboxInitialized = false
  let unsubscribeViolations: (() => void) | undefined

  pi.registerTool({
    ...localBash,
    label: 'bash (sandboxed)',
    async execute(id, params, signal, onUpdate, _ctx) {
      if (!sandboxEnabled || !sandboxInitialized) {
        return localBash.execute(id, params, signal, onUpdate)
      }

      const sandboxedBash = createBashTool(localCwd, {
        operations: createSandboxedBashOps()
      })
      return sandboxedBash.execute(id, params, signal, onUpdate)
    }
  })

  pi.on('user_bash', () => {
    if (!sandboxEnabled || !sandboxInitialized) return
    return { operations: createSandboxedBashOps() }
  })

  pi.on('session_start', async (_event, ctx) => {
    const noSandbox = pi.getFlag('no-sandbox') as boolean

    if (noSandbox) {
      sandboxEnabled = false
      ctx.ui.notify('Sandbox disabled via --no-sandbox', 'warning')
      return
    }

    const config = loadConfig(ctx.cwd)

    if (!config.enabled) {
      sandboxEnabled = false
      ctx.ui.notify('Sandbox disabled via config', 'info')
      return
    }

    const platform = process.platform
    if (platform !== 'darwin' && platform !== 'linux') {
      sandboxEnabled = false
      ctx.ui.notify(`Sandbox not supported on ${platform}`, 'warning')
      return
    }

    try {
      const configExt = config as unknown as {
        ignoreViolations?: Record<string, string[]>
        enableWeakerNestedSandbox?: boolean
      }

      // Create ask callback for network permission prompts
      const askCallback = createAskCallback(ctx)

      const sandboxManager = await loadSandboxManager()
      if (!sandboxManager) {
        throw new Error(
          'Sandbox runtime is not installed. Install @anthropic-ai/sandbox-runtime or run with --no-sandbox.'
        )
      }

      await sandboxManager.initialize(
        {
          network: config.network,
          filesystem: config.filesystem,
          ignoreViolations: configExt.ignoreViolations,
          enableWeakerNestedSandbox: configExt.enableWeakerNestedSandbox
        },
        askCallback,
        true // enable log monitor for violations
      )

      // Subscribe to violation events
      const violationStore = sandboxManager.getSandboxViolationStore()
      let lastViolationCount = 0

      unsubscribeViolations = violationStore.subscribe((violations: SandboxViolation[]) => {
        // Only notify about new violations
        if (violations.length > lastViolationCount) {
          const newViolations = violations.slice(lastViolationCount)
          for (const v of newViolations) {
            ctx.ui.notify(`Sandbox blocked: ${v.line}`, 'warning')
          }
          lastViolationCount = violations.length
        }
      })

      sandboxEnabled = true
      sandboxInitialized = true

      const networkCount = config.network?.allowedDomains?.length ?? 0
      const writeCount = config.filesystem?.allowWrite?.length ?? 0
      ctx.ui.setStatus(
        'sandbox',
        ctx.ui.theme.fg('muted', `Sandbox: ${networkCount} domains, ${writeCount} write paths`)
      )
      ctx.ui.notify('Sandbox initialized', 'info')
    } catch (err) {
      sandboxEnabled = false
      ctx.ui.notify(`Sandbox initialization failed: ${errorMessage(err)}`, 'error')
    }
  })

  pi.on('session_shutdown', async () => {
    if (unsubscribeViolations) {
      unsubscribeViolations()
      unsubscribeViolations = undefined
    }

    if (sandboxInitialized) {
      try {
        const sandboxManager = await loadSandboxManager()
        await sandboxManager?.reset()
      } catch {
        // Ignore cleanup errors
      }
    }

    // Clear session state
    sessionAllowedDomains.clear()
  })

  pi.registerCommand('sandbox', {
    description: 'Show sandbox configuration',
    handler: async (_args, ctx) => {
      if (!sandboxEnabled) {
        ctx.ui.notify('Sandbox is disabled', 'info')
        return
      }

      const config = loadConfig(ctx.cwd)
      const lines = [
        'Sandbox Configuration:',
        '',
        'Network:',
        `  Allowed: ${config.network?.allowedDomains?.join(', ') || '(none)'}`,
        `  Denied: ${config.network?.deniedDomains?.join(', ') || '(none)'}`,
        `  Session approved: ${Array.from(sessionAllowedDomains).join(', ') || '(none)'}`,
        '',
        'Filesystem:',
        `  Deny Read: ${config.filesystem?.denyRead?.join(', ') || '(none)'}`,
        `  Allow Write: ${config.filesystem?.allowWrite?.join(', ') || '(none)'}`,
        `  Deny Write: ${config.filesystem?.denyWrite?.join(', ') || '(none)'}`
      ]
      ctx.ui.notify(lines.join('\n'), 'info')
    }
  })
}
