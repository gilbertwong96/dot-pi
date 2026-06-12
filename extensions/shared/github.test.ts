import { describe, expect, test } from 'bun:test'

import { parseGitHubBlobUrl, resolveGitHubFileTarget } from './github'

describe('parseGitHubBlobUrl', () => {
  test('parses GitHub blob URLs', () => {
    expect(
      parseGitHubBlobUrl('https://github.com/facebook/react/blob/main/packages/react/index.js')
    ).toEqual({
      repo: 'facebook/react',
      ref: 'main',
      path: 'packages/react/index.js'
    })
  })

  test('rejects non-blob URLs', () => {
    expect(parseGitHubBlobUrl('https://github.com/facebook/react')).toBeUndefined()
  })
})

describe('resolveGitHubFileTarget', () => {
  test('prefers GitHub URL target over explicit fields', () => {
    expect(
      resolveGitHubFileTarget({
        repo: 'wrong/repo',
        path: 'wrong.ts',
        url: 'https://github.com/facebook/react/blob/main/packages/react/index.js'
      })
    ).toEqual({
      ok: true,
      target: {
        repo: 'facebook/react',
        ref: 'main',
        path: 'packages/react/index.js'
      }
    })
  })

  test('requires a URL or repo and path', () => {
    expect(resolveGitHubFileTarget({ repo: 'facebook/react' })).toEqual({
      ok: false,
      message: 'Provide either url or both repo and path'
    })
  })
})
