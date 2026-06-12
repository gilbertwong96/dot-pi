import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'bun:test'

import type { LspConfig } from './config'
import {
  detectProjectType,
  findFileByExtensions,
  getLspServerForFile,
  getServerForWorkspaceAction,
  resolveToCwd
} from './project'

function tempProject(name: string) {
  return join(tmpdir(), `dot-pi-lsp-${name}-${crypto.randomUUID()}`)
}

describe('LSP project helpers', () => {
  test('resolves relative paths against cwd', () => {
    expect(resolveToCwd('src/index.ts', '/repo')).toBe('/repo/src/index.ts')
    expect(resolveToCwd('/tmp/file.ts', '/repo')).toBe('/tmp/file.ts')
  })

  test('detects common project types from root markers', () => {
    const dir = tempProject('markers')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'tsconfig.json'), '{}')

    expect(detectProjectType(dir)).toMatchObject({
      type: 'typescript',
      description: 'TypeScript (tsc --noEmit)'
    })
  })

  test('selects file servers and workspace servers', () => {
    const config: LspConfig = {
      servers: {
        ts: { command: 'typescript-language-server', fileTypes: ['.ts'], rootMarkers: [] },
        biome: {
          command: 'biome',
          fileTypes: ['.ts'],
          rootMarkers: [],
          createClient: () => {
            throw new Error('not used')
          }
        },
        rust: { command: 'rust-analyzer', fileTypes: ['.rs'], rootMarkers: [] }
      }
    }

    expect(getLspServerForFile(config, 'src/app.ts')?.[0]).toBe('ts')
    expect(getServerForWorkspaceAction(config, 'workspace_symbols')?.[0]).toBe('ts')
    expect(getServerForWorkspaceAction(config, 'flycheck')?.[0]).toBe('rust')
  })

  test('finds a matching source file while skipping ignored dirs', () => {
    const dir = tempProject('files')
    mkdirSync(join(dir, 'node_modules/pkg'), { recursive: true })
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'node_modules/pkg/index.ts'), '')
    writeFileSync(join(dir, 'src/main.ts'), '')

    expect(findFileByExtensions(dir, ['.ts'])).toBe(join(dir, 'src/main.ts'))
  })
})
