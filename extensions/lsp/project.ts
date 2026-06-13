import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

import { getServersForFile, hasCapability, type LspConfig } from './config'
import type { ServerConfig } from './types'

export interface ProjectType {
  type: string
  command?: string[]
  description: string
}

const FILE_SEARCH_MAX_DEPTH = 5
const IGNORED_DIRS = new Set(['node_modules', 'target', 'dist', 'build', '.git'])

export function resolveToCwd(filePath: string, cwd: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)
}

export function detectProjectType(cwd: string): ProjectType {
  if (existsSync(path.join(cwd, 'Cargo.toml'))) {
    return {
      type: 'rust',
      command: ['cargo', 'check', '--message-format=short'],
      description: 'Rust (cargo check)'
    }
  }
  if (existsSync(path.join(cwd, 'tsconfig.json'))) {
    return {
      type: 'typescript',
      command: ['npx', 'tsc', '--noEmit'],
      description: 'TypeScript (tsc --noEmit)'
    }
  }
  if (existsSync(path.join(cwd, 'go.mod'))) {
    return { type: 'go', command: ['go', 'build', './...'], description: 'Go (go build)' }
  }
  if (
    existsSync(path.join(cwd, 'pyproject.toml')) ||
    existsSync(path.join(cwd, 'pyrightconfig.json'))
  ) {
    return { type: 'python', command: ['pyright'], description: 'Python (pyright)' }
  }
  return { type: 'unknown', description: 'Unknown project type' }
}

export function getLspServers(config: LspConfig): Array<[string, ServerConfig]> {
  return (Object.entries(config.servers) as Array<[string, ServerConfig]>).filter(
    ([, serverConfig]) => !serverConfig.createClient
  )
}

export function getLspServerForFile(
  config: LspConfig,
  filePath: string
): [string, ServerConfig] | null {
  const servers = getServersForFile(config, filePath).filter(
    ([, serverConfig]) => !serverConfig.createClient
  )
  return servers.length > 0 ? servers[0] : null
}

export function getRustServer(config: LspConfig): [string, ServerConfig] | null {
  const entries = getLspServers(config)
  const byName = entries.find(
    ([name, server]) => name === 'rust-analyzer' || server.command === 'rust-analyzer'
  )
  if (byName) return byName

  for (const [name, server] of entries) {
    if (hasCapability(server, 'flycheck')) {
      return [name, server]
    }
  }

  return null
}

export function getServerForWorkspaceAction(
  config: LspConfig,
  action: string
): [string, ServerConfig] | null {
  const entries = getLspServers(config)
  if (entries.length === 0) return null

  if (action === 'workspace_symbols') {
    return entries[0]
  }

  if (
    action === 'flycheck' ||
    action === 'ssr' ||
    action === 'runnables' ||
    action === 'reload_workspace'
  ) {
    return getRustServer(config)
  }

  return null
}

export function findFileByExtensions(baseDir: string, extensions: string[]): string | null {
  const normalized = extensions.map((ext) => ext.toLowerCase())
  const search = (dir: string, depth: number): string | null => {
    if (depth > FILE_SEARCH_MAX_DEPTH) return null
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return null
    }

    for (const name of entries) {
      if (name.startsWith('.')) continue
      if (IGNORED_DIRS.has(name)) continue
      const fullPath = path.join(dir, name)
      try {
        const stat = statSync(fullPath)
        if (stat.isFile()) {
          const lowerName = name.toLowerCase()
          if (normalized.some((ext) => lowerName.endsWith(ext))) {
            return fullPath
          }
        } else if (stat.isDirectory()) {
          const found = search(fullPath, depth + 1)
          if (found) return found
        }
      } catch {
        continue
      }
    }
    return null
  }

  return search(baseDir, 0)
}
