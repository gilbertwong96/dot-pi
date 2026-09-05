# Shared extension helpers

Use these helpers for new dot-pi tools so TUI output stays Pi-native and safe while arguments/results stream.

## Tool calls

Use `renderToolCall()` instead of hand-built `new Text(...)` call lines.

```ts
renderCall(args, theme) {
  const safe = args ?? {}
  return renderToolCall(theme, 'fetch', {
    segments: [{ text: safe.url }],
    tags: [safe.format !== 'markdown' ? safe.format : undefined],
    suffix: safe.limit ? `${safe.limit} results` : undefined
  })
}
```

It skips `undefined`, `null`, empty strings, and false tags, so streaming-start calls do not display `undefined`.

## Tool results

Use text result helpers instead of repeating result object literals.

```ts
return toolText(output, details)
return toolError('API key not set', { error: true })
onUpdate?.(toolLoading({ loading: true }))
```

`toolError()` prefixes `Error:` once and marks `isError: true`. Register tools that return structured failures with `registerTool(pi, definition)` from `register-tool.ts`: Pi ignores a returned `isError` property, so the helper forwards it through the supported `tool_result` hook while preserving content and details. Plain thrown errors already use Pi’s native error channel.

## Result rendering

Use semantic render helpers:

```ts
if (details?.error) return renderError(firstText(result, 'Error'), theme)
if (items.length === 0) return renderMuted('No results found.', theme)
return renderLines([title('Result', theme), meta(path, theme), primary(body, theme)])
```

For compact/expanded lists:

```ts
return renderEntryList(items, theme, {
  expanded,
  compactLimit: 1,
  renderEntry: (item) => ({
    header: title(item.name, theme),
    metadata: meta(item.path, theme),
    body: expanded ? [primary(item.text, theme)] : undefined
  }),
  hiddenLines: (hidden) => (hidden > 0 ? [meta(`… ${hidden} more`, theme)] : [])
})
```

For Markdown-like output:

```ts
return renderMarkdownPreview(markdown, theme, {
  expanded,
  metadata: [meta(source, theme)],
  compactLines: 4
})
```

## HTTP/API helpers

Use `requireEnv()` for API keys and `fetchText()` / `fetchJson()` for HTTP calls.

```ts
const apiKey = requireEnv('EXA_API_KEY')
if (!apiKey.ok) return toolError(apiKey.message, details)

const response = await fetchJson<MyResponse>(
  url,
  {
    headers: { Authorization: `Bearer ${apiKey.value}` }
  },
  { signal, timeoutMs: 30_000 }
)
```

Use `withTimeoutSignal()` directly when an SDK accepts `AbortSignal` but does its own request.

### API references and maintenance

Keep request schemas synchronized with official documentation rather than copying API details into multiple guides.

| Extension | API reference | Configuration |
| --- | --- | --- |
| `codesearch.ts` | [grep.app MCP](https://mcp.grep.app) | No key required |
| `context7/` | [Context7 OpenAPI](https://context7.com/docs/openapi.json) | `CONTEXT7_API_KEY`, optional `CONTEXT7_ENDPOINT_URL` |
| `provider/` | Protocol defined in `extensions/provider/index.ts` | `PROVIDER_API_KEY` |
| `voice-input/` | [ElevenLabs realtime transcription](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime) | `ELEVENLABS_API_KEY`; optional settings in the extension header |
| `websearch/` | [Exa Search API](https://exa.ai/docs/reference/search-api-guide-for-coding-agents.md) | `EXA_API_KEY`, optional `EXA_ENDPOINT_URL` |

- Exa uses direct REST, not `exa-js`. Verify current search types, category restrictions, and contents/freshness fields before changing schemas.
- Context7 supports text and JSON responses; preserve the documented library ID and response formats.
- Treat grep.app as an MCP transport: test JSON-RPC and SSE parsing with fixtures rather than assuming a particular event layout.
- Close voice recording and WebSocket resources on cancellation, errors, and session shutdown. Ignore callbacks from superseded connections.
- Forward `AbortSignal` to every supported API/SDK call. Bound model-visible output as well as rendered output.
- Store structured result details; do not reconstruct them by parsing rendered text.
- Re-read upstream documentation when changing request shapes or dependencies.


## Display-only messages

Use `registerDisplayOnlyMessage()` for UI receipts/nudges that must not enter model context.

```ts
const sendReceipt = registerDisplayOnlyMessage(pi, 'my-receipt', (message, _options, theme) => {
  const box = new Box(1, 0, (text) => theme.bg('customMessageBg', text))
  box.addChild(new Text(theme.fg('dim', String(message.content)), 0, 0))
  return box
})

sendReceipt('done · 3 files', { timestamp: Date.now() })
```

If another `context` hook also transforms messages, call `filterDisplayOnlyMessages(messages, type)` first.

## Checklist for new tools

- `renderCall` uses `renderToolCall()` and handles `args ?? {}`.
- Tools returning structured failures use `registerTool()` from `register-tool.ts`.
- `execute` returns `toolText()` / `toolError()` / `toolLoading()`.
- `renderResult` uses `renderError`, `renderMuted`, `renderLines`, and semantic colors.
- Compact output is short; expanded output contains long bodies/diffs/docs.
- If compact output hides content, show the expand footer via shared helpers.
- Add a regression test when adding a new shared pattern.

## Known migration gaps

These remain open; the native migration is not exhaustive:

- Bash completion and voice input independently replace the custom editor rather than composing.
- AST multi-file writes do not yet use Pi's per-file mutation queue; directory dry-run fallback can expose ast-grep pseudo-diffs.
- Expanded content can still be width-truncated, with incomplete expansion hints.
- Inline terminal images, live provider-driven streaming, voice transcription, and all optional extension lifecycles need further end-to-end coverage.

Use the [smoke checklist](../../docs/smoke-test.md) for repeatable validation. Keep completed-run details in commit messages or review summaries, not new audit files.
