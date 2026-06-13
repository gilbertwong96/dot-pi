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

`toolError()` prefixes `Error:` once and marks `isError: true`.

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
  hiddenLines: (hidden) => hidden > 0 ? [meta(`… ${hidden} more`, theme)] : []
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

const response = await fetchJson<MyResponse>(url, {
  headers: { Authorization: `Bearer ${apiKey.value}` }
}, { signal, timeoutMs: 30_000 })
```

Use `withTimeoutSignal()` directly when an SDK accepts `AbortSignal` but does its own request.

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
- `execute` returns `toolText()` / `toolError()` / `toolLoading()`.
- `renderResult` uses `renderError`, `renderMuted`, `renderLines`, and semantic colors.
- Compact output is short; expanded output contains long bodies/diffs/docs.
- If compact output hides content, show the expand footer via shared helpers.
- Add a regression test when adding a new shared pattern.
