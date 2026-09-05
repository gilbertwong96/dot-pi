# Native Pi migration audit

Scope: dot-pi model-facing tools and optional extension UI/lifecycle boundaries, plus the screenshot-related companion pi-elixir renderer. This is not certification of every external API or every possible terminal behavior.

## Completed checks and changes

| Area | Evidence / changes |
| --- | --- |
| Tool call/result rows | Cross-tool streaming/missing-details/error/width checks in `extensions/render-call.test.ts`; shared multiline and tab regression tests |
| Structured failures | Shared `register-tool.ts` forwards failure state through Pi's canonical `tool_result` channel without losing details |
| Native terminal integration | Deterministic native shell recordings at 80/40 columns and Pi 0.85.0 interactive session replay with expansion and 80→40→100 resizing; see `native-render-validation.md` |
| AST tools | Compact search previews, semantic styling, error/partial rendering, abort signal forwarding, command failure handling |
| Background/worktrees | Missing-details fallback, bounded worktree status previews, separate log expansion footer |
| Computer replacement | Old companion removed from global settings and installer/docs; native prompt metadata; observation state updated inside queue; mixed addressing rejected; pre-dispatch cancellation checked |
| Companion pi-elixir | Multiline physical-row normalization and single-line call normalization; renderer tests and JS check passed in companion checkout |
| Optional bash completion | Custom editor installation gated on TUI mode |
| Optional voice input | TUI mode gate; recording/socket/blink cleanup at shutdown; removed delayed cross-recording socket close; ignore stale socket callbacks |
| Optional critic | TUI-only graphical model picker; subprocess abort listeners removed on completion/error |

## Remaining migration work / limitations

- Bash completion and voice input still replace the custom editor independently; they are not yet a composable shared editor integration.
- AST multi-file mutation is not yet integrated with Pi's per-file mutation queue. Directory dry-run fallback can still expose ast-grep's native pseudo-diff.
- Expanded single-line content can still be width-truncated. Full-width-aware wrapping and accurate expansion hints need a separate renderer pass.
- Computer handle lifetime/identity behavior, especially the pre-existing semantic-ref reuse changes, needs real desktop interaction coverage. Image-protocol rendering has not been verified.
- Voice microphone/transcription behavior has not been exercised against ElevenLabs; no recording was started for this audit.
- Critic, provider, plan-mode, coaching/tutor workflows, and other optional integrations have not all received full end-to-end lifecycle tests.
- Live provider-driven streaming remains distinct from deterministic native-shell streaming tests.

Do not describe this migration as exhaustive or promise zero future bugs while these items remain.
