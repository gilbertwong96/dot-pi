import { describe, expect, test } from 'bun:test'
import { matchCommandRule, parseInvocations, type CommandRule } from './confirm-actions'

const rules: CommandRule[] = [
  { argv: ['gh', 'pr', 'create'], label: 'Publish GitHub PR' },
  {
    argv: ['gh', 'api'],
    label: 'Mutate via GitHub API',
    matches: (argv) => argv.includes('--method') && argv.includes('PATCH')
  }
]

describe('parseInvocations', () => {
  test('splits shell control operators', () => {
    expect(parseInvocations('cd repo && gh pr create; echo done')).toEqual([
      ['cd', 'repo'],
      ['gh', 'pr', 'create'],
      ['echo', 'done']
    ])
  })
})

describe('matchCommandRule', () => {
  test('matches argv command prefixes', () => {
    expect(matchCommandRule('gh pr create --title x', rules)?.label).toBe('Publish GitHub PR')
  })

  test('does not match quoted command-looking text', () => {
    expect(matchCommandRule('echo "gh pr create"', rules)).toBeUndefined()
    expect(
      matchCommandRule('rg -n "gh issue|gh pr comment|gh api" README.md', rules)
    ).toBeUndefined()
  })

  test('matches after assignments and shell operators', () => {
    expect(matchCommandRule('cd repo && GH_TOKEN=x gh pr create', rules)?.label).toBe(
      'Publish GitHub PR'
    )
  })

  test('matches through common wrappers', () => {
    expect(matchCommandRule('sudo -E gh pr create', rules)?.label).toBe('Publish GitHub PR')
    expect(matchCommandRule('env GH_TOKEN=x gh pr create', rules)?.label).toBe('Publish GitHub PR')
  })

  test('honors rule-specific matchers', () => {
    expect(matchCommandRule('gh api repos/acme/app/issues', rules)).toBeUndefined()
    expect(matchCommandRule('gh api repos/acme/app/issues/1 --method PATCH', rules)?.label).toBe(
      'Mutate via GitHub API'
    )
  })
})
