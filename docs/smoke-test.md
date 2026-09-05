# Smoke test checklist

Use this after changing the workflow extensions. Run local checks first:

```bash
npm run format:check
npm run check
npm test
```

## Interactive Pi smoke tests

Start a fresh TUI session from this repo. Editing files does not update extensions already loaded in a running session: explicitly reload or start a separate process loading the checkout.

## Native tool rendering

Record the deterministic native-shell fixture:

```bash
asciinema rec --overwrite -c 'npx tsx demos/tapes/native-render-smoke.ts' /tmp/native-render.cast
```

Run inside tmux at 80 and 40 columns. Add `--computer` after the script path to cover computer window filters, empty discovery, long titles, compact limits, and expansion. The fixture initializes Pi's keybindings as well as its theme so expansion hints match a real session. It exercises argument updates, partial/settled output, expansion/collapse, and exceptions without details using Pi's actual tool component. It also checks physical rows at widths 8, 40, 80, and 120. The editor sentinel must remain below the output; the run must finish with `NATIVE RENDER SMOKE PASSED`.

The fixture deliberately imports internal Pi components. Update those imports when upgrading Pi; do not use that pattern in production extensions.

For the real editor and footer, create an isolated session:

```bash
npx tsx demos/tapes/create-render-session.ts
pi --offline --no-extensions --no-skills --no-prompt-templates --no-context-files \
  -e ./extensions/background.ts --session <printed-path>
```

Record the replay, toggle Ctrl+O, resize 80 → 40 → 100 columns, and type an editor sentinel without submitting it. The editor and footer must stay below tool output. The fixture's nonexistent model produces an expected restore warning; no model request is required.

Relevant automated tests: `extensions/render-call.test.ts`, `extensions/shared/render.test.ts`, and `extensions/shared/register-tool.test.ts`. Deterministic renderer tests do not replace live streaming, image-protocol, or service-specific tests.

## Computer replacement

Use a fresh Pi process loading `extensions/computer` explicitly and an isolated disposable desktop window, not a user's document.

- Discover the application, then PID-filtered windows; verify handles appear in model-visible output.
- Observe the exact window and inspect its screenshot.
- Perform a reversible action, such as toggling a fixture checkbox; observe again to verify.
- Retry the old observation's element handle; it must fail safely when its token has expired.
- Reverse the action using the new handle; verify again.
- Close the fixture and rediscover windows; the old window handle must be unavailable.
- Check native tool rows separately: explicit empty states, call filters, bounded compact lists, expansion, and inline images. Notification-only test harnesses do not verify tool rendering.
- Stop fixture/test processes. Review recordings for desktop or document information before publishing them.

## Workflow behavior


### Workflow commands

- `/next` — returns 7 tactical steps and a best action.
- `/next 3` — returns exactly 3 tactical steps.
- `/next big` — returns 7 coarse-grained work chunks, not micro-actions.
- `/next b 3` — returns exactly 3 coarse-grained work chunks.
- `/discuss whether to keep polishing` — discusses tradeoffs without editing files, running commands, committing, or pushing.
- `/recap` — covers goal, state, decisions, open threads, drift, best action.
- `/nobc` — expands to the sharp no-backcompat instruction.
- `/gaa` and `/all` — expand to the same instruction: complete only currently agreed pending items, invent no additional scope, and ask only if blocked.

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
- `gh repo create dummy/test --private` should ask before creating a repo.
- `gh repo delete dummy/test --yes` should ask before deleting a repo.
- `gws gmail +send --to alice@example.com --subject test --body test` should ask before sending email.
- `bird tweet "test"` should ask before posting to X/Twitter.
- `git push origin master` should ask before pushing commits.
- `git push --force-with-lease` should ask before force push.
- `git reset --hard HEAD` should ask before hard reset.
- `sudo true` should ask before privileged execution.
- `rm -rf /tmp/dot-pi-confirm-actions-smoke` should ask before recursive deletion.
- `gh secret set TEST_TOKEN` should ask before mutating repository secrets.
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

### Optional Pi workflow tutor

Automated smoke check:

```bash
npm run smoke:tutor
```

Manual check:

```bash
pi --no-extensions -e extensions/tutor.ts
```

Then run `/tutor` while a realistic task is stuck or drifting, or `/tutor building a web app` in a test session.

Expected: sends an in-place Dan-style workflow hint for the current session, explains what Dan would notice/think/do/ask, stays advisory/read-only, and does not edit/commit/push.
