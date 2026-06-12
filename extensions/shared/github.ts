import { spawnSync } from 'child_process'

import { apiErrorMessage, fetchText } from './http'

const DEFAULT_GITHUB_TIMEOUT_MS = 30_000
const GITHUB_MAX_BUFFER = 10 * 1024 * 1024

export interface GitHubFileTargetParams {
  repo?: string
  path?: string
  ref?: string
  url?: string
}

export interface GitHubFileTarget {
  repo: string
  path: string
  ref?: string
}

export type GitHubFileResult =
  | ({ ok: true; text: string } & GitHubFileTarget)
  | ({ ok: false; message: string } & Partial<GitHubFileTarget>)

export function parseGitHubBlobUrl(url: string): GitHubFileTarget | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }

  if (parsed.hostname !== 'github.com') return undefined

  const parts = parsed.pathname.split('/').filter(Boolean)
  const blobIndex = parts.indexOf('blob')
  if (blobIndex !== 2 || parts.length < 5) return undefined

  const [owner, repoName] = parts
  const ref = parts[3]
  const fileParts = parts.slice(4)
  if (!owner || !repoName || !ref || fileParts.length === 0) return undefined

  return {
    repo: `${owner}/${repoName}`,
    ref,
    path: fileParts.map((part) => decodeURIComponent(part)).join('/')
  }
}

export function resolveGitHubFileTarget(
  params: GitHubFileTargetParams
): { ok: true; target: GitHubFileTarget } | { ok: false; message: string } {
  const fromUrl = params.url ? parseGitHubBlobUrl(params.url) : undefined
  const repo = fromUrl?.repo ?? params.repo
  const path = fromUrl?.path ?? params.path
  const ref = fromUrl?.ref ?? params.ref

  if (!repo || !path) {
    return { ok: false, message: 'Provide either url or both repo and path' }
  }

  if (!/^[^\s/]+\/[^\s/]+$/u.test(repo)) {
    return { ok: false, message: "repo must look like 'owner/name'" }
  }

  return { ok: true, target: { repo, path, ref } }
}

function encodePathForEndpoint(path: string): string {
  return path
    .split('/')
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join('/')
}

function fetchGitHubFileWithGh(target: GitHubFileTarget): GitHubFileResult {
  const endpointPath = encodePathForEndpoint(target.path)
  const endpoint = `repos/${target.repo}/contents/${endpointPath}${target.ref ? `?ref=${encodeURIComponent(target.ref)}` : ''}`
  const result = spawnSync('gh', ['api', endpoint, '-H', 'Accept: application/vnd.github.raw'], {
    encoding: 'utf-8',
    maxBuffer: GITHUB_MAX_BUFFER
  })

  if (result.status === 0) {
    return { ok: true, text: result.stdout, ...target }
  }

  const message =
    result.error?.message ??
    (result.stderr || result.stdout || `gh api exited ${result.status}`).trim()
  return { ok: false, message, ...target }
}

async function fetchGitHubFileWithPublicApi(target: GitHubFileTarget): Promise<GitHubFileResult> {
  const endpointPath = encodePathForEndpoint(target.path)
  const ref = target.ref ? `?ref=${encodeURIComponent(target.ref)}` : ''
  const response = await fetchText(
    `https://api.github.com/repos/${target.repo}/contents/${endpointPath}${ref}`,
    {
      headers: {
        Accept: 'application/vnd.github.raw',
        'User-Agent': 'dot-pi-github-fetch'
      }
    },
    { timeoutMs: DEFAULT_GITHUB_TIMEOUT_MS }
  )

  if (!response.ok) {
    return { ok: false, message: apiErrorMessage(response.status, response.text), ...target }
  }

  return { ok: true, text: response.text, ...target }
}

export async function fetchGitHubFile(params: GitHubFileTargetParams): Promise<GitHubFileResult> {
  const resolved = resolveGitHubFileTarget(params)
  if (!resolved.ok) return resolved

  const ghResult = fetchGitHubFileWithGh(resolved.target)
  if (ghResult.ok) return ghResult

  const publicResult = await fetchGitHubFileWithPublicApi(resolved.target)
  if (publicResult.ok) return publicResult

  return {
    ok: false,
    message: `${ghResult.message}; fallback failed: ${publicResult.message}`,
    ...resolved.target
  }
}
