# Native tool renderer validation

Run the deterministic native-shell smoke from the repository root:

```sh
asciinema rec --overwrite -c 'npx tsx demos/tapes/native-render-smoke.ts' /tmp/native-render.cast
```

Run in tmux at both 80 and 40 columns. The fixture uses Pi's actual tool execution component and main-screen renderer, not a model or external service. It exercises argument updates, partial output, settled output, expansion/collapse, and exceptions without details. Every phase also checks physical rows at widths 8, 40, 80, and 120. The editor sentinel must remain below the result and the run must end with `NATIVE RENDER SMOKE PASSED`.

The fixture imports internal Pi components intentionally to test the native shell. Update these imports when upgrading the development Pi dependency; do not copy this pattern into production extensions.

Automated regression coverage:

- `extensions/render-call.test.ts`: all registered model-facing tool renderers, streaming-start arguments, missing-detail success/partial/error results, physical rows at narrow widths.
- `extensions/shared/render.test.ts`: embedded newline/carriage-return flattening and tab expansion.
- `extensions/shared/register-tool.test.ts`: structured failure propagation, call isolation, and shutdown cleanup.
- `pi-elixir/packages/extension/test/render-rows.test.ts` in the companion checkout: multiline exception rows.

## Interactive session replay

`npx tsx demos/tapes/create-render-session.ts` creates an isolated fixture session under `/tmp/dot-pi-interactive-smoke-sessions` and prints its path. Resume it with:

```sh
pi --offline --no-extensions --no-skills --no-prompt-templates --no-context-files \
  -e ./extensions/background.ts --session <printed-path>
```

Record with asciinema inside tmux. Toggle Ctrl+O, resize 80 → 40 → 100 columns, and type an editor sentinel without submitting it. Verify the real editor and footer remain below tool output. This was verified with Pi 0.85.0; the recording is `/tmp/dot-pi-interactive.cast`. The fixture model intentionally does not exist, so a model-restore warning is expected. No model request is needed.

This is a rendering contract check, not an end-to-end test of every external API or a guarantee against all terminal artifacts. Image protocol behavior, live provider-driven streaming, and every extension's service-specific payloads require separate coverage.
