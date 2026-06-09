import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_COMMAND_RULES,
  buildDefaultCommandRules,
  matchCommandRule,
  parseInvocations,
  type CommandRule
} from './confirm-actions'

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

  test('default rules confirm risky git actions', () => {
    expect(matchCommandRule('git push --force-with-lease', DEFAULT_COMMAND_RULES)?.label).toBe(
      'Force push'
    )
    expect(matchCommandRule('git -C repo push -f origin main', DEFAULT_COMMAND_RULES)?.label).toBe(
      'Force push'
    )
    expect(
      matchCommandRule('git push origin --delete old-branch', DEFAULT_COMMAND_RULES)?.label
    ).toBe('Delete remote branch')
    expect(matchCommandRule('git push origin :old-branch', DEFAULT_COMMAND_RULES)?.label).toBe(
      'Delete remote branch'
    )
    expect(matchCommandRule('git push origin master', DEFAULT_COMMAND_RULES)?.label).toBe(
      'Push git commits'
    )
    expect(matchCommandRule('git -C repo push', DEFAULT_COMMAND_RULES)?.label).toBe(
      'Push git commits'
    )
    expect(matchCommandRule('git reset --hard HEAD~1', DEFAULT_COMMAND_RULES)?.label).toBe(
      'Hard reset'
    )
    expect(matchCommandRule('git clean -fd', DEFAULT_COMMAND_RULES)?.label).toBe(
      'Clean working tree'
    )
    expect(matchCommandRule('git branch -D old-branch', DEFAULT_COMMAND_RULES)?.label).toBe(
      'Delete local branch'
    )
  })

  test('can disable default rule groups', () => {
    const rules = buildDefaultCommandRules({ git: false, twitter: false })

    expect(matchCommandRule('git push origin master', rules)).toBeUndefined()
    expect(matchCommandRule('bird tweet "hello"', rules)).toBeUndefined()
    expect(matchCommandRule('gh repo delete acme/app', rules)?.label).toBe('Delete GitHub repo')
  })

  test('default rules confirm Gmail and X/Twitter mutations', () => {
    expect(
      matchCommandRule(
        'gws gmail +send --to alice@example.com --subject Hi --body Hello',
        DEFAULT_COMMAND_RULES
      )?.label
    ).toBe('Mutate Gmail')
    expect(
      matchCommandRule('gws gmail +reply abc --body Thanks', DEFAULT_COMMAND_RULES)?.label
    ).toBe('Mutate Gmail')
    expect(
      matchCommandRule('gws gmail users messages send --json payload.json', DEFAULT_COMMAND_RULES)
        ?.label
    ).toBe('Mutate Gmail')
    expect(
      matchCommandRule('gws gmail users messages delete --id msg-1', DEFAULT_COMMAND_RULES)?.label
    ).toBe('Mutate Gmail')
    expect(
      matchCommandRule('gws gmail +send --to alice@example.com --dry-run', DEFAULT_COMMAND_RULES)
    ).toBeUndefined()
    expect(matchCommandRule('gws gmail +triage', DEFAULT_COMMAND_RULES)).toBeUndefined()

    expect(matchCommandRule('bird tweet "hello"', DEFAULT_COMMAND_RULES)?.label).toBe(
      'Mutate X/Twitter'
    )
    expect(matchCommandRule('bird reply 123 "thanks"', DEFAULT_COMMAND_RULES)?.label).toBe(
      'Mutate X/Twitter'
    )
    expect(matchCommandRule('bird delete 123', DEFAULT_COMMAND_RULES)?.label).toBe(
      'Mutate X/Twitter'
    )
    expect(
      matchCommandRule('bunx @dannote/bird-premium follow someone', DEFAULT_COMMAND_RULES)?.label
    ).toBe('Mutate X/Twitter')
    expect(matchCommandRule('bird read 123', DEFAULT_COMMAND_RULES)).toBeUndefined()
    expect(matchCommandRule('bird search "pi"', DEFAULT_COMMAND_RULES)).toBeUndefined()
  })

  test('default rules confirm GitHub issue publication and repo mutations', () => {
    expect(
      matchCommandRule('gh issue create --title bug --body details', DEFAULT_COMMAND_RULES)?.label
    ).toBe('Create GitHub issue')
    expect(
      matchCommandRule(
        'cd repo && gh issue create --title bug --body details',
        DEFAULT_COMMAND_RULES
      )?.label
    ).toBe('Create GitHub issue')
    expect(matchCommandRule('gh issue comment 1 --body thanks', DEFAULT_COMMAND_RULES)?.label).toBe(
      'Publish GitHub issue comment'
    )
    expect(
      matchCommandRule('gh repo create acme/app --private', DEFAULT_COMMAND_RULES)?.label
    ).toBe('Create GitHub repo')
    expect(matchCommandRule('gh repo delete acme/app --yes', DEFAULT_COMMAND_RULES)?.label).toBe(
      'Delete GitHub repo'
    )
    expect(matchCommandRule('gh repo archive acme/app --yes', DEFAULT_COMMAND_RULES)?.label).toBe(
      'Archive GitHub repo'
    )
    expect(
      matchCommandRule('gh repo transfer acme/app other-org', DEFAULT_COMMAND_RULES)?.label
    ).toBe('Transfer GitHub repo')
    expect(
      matchCommandRule(
        'gh repo deploy-key add ~/.ssh/id.pub --repo acme/app',
        DEFAULT_COMMAND_RULES
      )?.label
    ).toBe('Mutate GitHub repo deploy keys')
    expect(
      matchCommandRule('gh repo deploy-key list --repo acme/app', DEFAULT_COMMAND_RULES)
    ).toBeUndefined()
  })

  test('default rules confirm release publish and deploy commands', () => {
    expect(matchCommandRule('npm publish', DEFAULT_COMMAND_RULES)?.label).toBe(
      'Publish npm package'
    )
    expect(matchCommandRule('pnpm --filter pkg publish', DEFAULT_COMMAND_RULES)?.label).toBe(
      'Publish npm package'
    )
    expect(matchCommandRule('bun publish', DEFAULT_COMMAND_RULES)?.label).toBe('Publish package')
    expect(matchCommandRule('yarn npm publish', DEFAULT_COMMAND_RULES)?.label).toBe(
      'Publish npm package'
    )
    expect(matchCommandRule('gh release create v1.0.0', DEFAULT_COMMAND_RULES)?.label).toBe(
      'Publish GitHub release'
    )
    expect(matchCommandRule('gh release delete v1.0.0 --yes', DEFAULT_COMMAND_RULES)?.label).toBe(
      'Delete GitHub release'
    )
    expect(matchCommandRule('vercel --prod', DEFAULT_COMMAND_RULES)?.label).toBe(
      'Deploy with Vercel'
    )
    expect(matchCommandRule('netlify deploy --prod', DEFAULT_COMMAND_RULES)?.label).toBe(
      'Deploy with Netlify'
    )
    expect(matchCommandRule('firebase deploy', DEFAULT_COMMAND_RULES)?.label).toBe(
      'Deploy with Firebase'
    )
    expect(matchCommandRule('fly deploy', DEFAULT_COMMAND_RULES)?.label).toBe('Deploy with Fly.io')
    expect(matchCommandRule('wrangler publish', DEFAULT_COMMAND_RULES)?.label).toBe(
      'Deploy with Wrangler'
    )
  })
})
