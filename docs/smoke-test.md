# Smoke test checklist

Use this after changing the workflow extensions. Run local checks first:

```bash
bun run format:check
bun run check
bun test
```

## Interactive Pi smoke tests

Start a fresh TUI session from this repo.

### Workflow commands

- `/next` — returns 7 tactical steps and a best action.
- `/next 3` — returns exactly 3 tactical steps.
- `/next big` — returns 7 coarse-grained work chunks, not micro-actions.
- `/next b 3` — returns exactly 3 coarse-grained work chunks.
- `/discuss whether to keep polishing` — discusses tradeoffs without editing files, running commands, committing, or pushing.
- `/recap` — covers goal, state, decisions, open threads, drift, best action.
- `/nobc` — expands to the sharp no-backcompat instruction.
- `/gaa` — proceeds with all pending items, asks only if blocked.

### Quote workflow

- Select assistant text and press `ctrl+/`.
- Expected: selected text is inserted as `>` quote lines; no stale clipboard quote for shortcut.
- `/quote some text` quotes explicit args.

### Option picker

Ask the model to propose several options and choose one with `choose_from_options`.

Check:

- overlay opens
- `↑/↓` moves
- `Space` toggles current item
- `1`-`9` toggles by number
- `g`, multi-digit number, `Enter` toggles larger item numbers
- `Tab` cycles action
- `a` selects all
- `n` keeps only current item
- `Enter` returns selected action/options to the model
- `Esc` cancels

### Action confirmations

Trigger only harmless/dummy commands and cancel them.

- `gh pr comment 1 --body test` should ask to publish a PR comment.
- `gh issue create --title test --body test` should ask to publish an issue.
- `gws gmail +send --to alice@example.com --subject test --body test` should ask before sending email.
- `bird tweet "test"` should ask before posting to X/Twitter.
- `git push --force-with-lease` should ask before force push.
- `git reset --hard HEAD` should ask before hard reset.
- Cancel each dialog.

### Notifications

- When a confirmation dialog appears, a desktop notification should fire.
- When an agent turn finishes, notification should include repo/context.

### Optional newcomer coach

Load optional coach explicitly:

```bash
pi -e extensions/coach.ts
```

Then run `/coach shortcuts`.

Expected: explains setup/shortcuts using `docs/handbook.md`, `prompts`, `rules`, and `skills`; does not edit/commit/push.
