# API-backed extensions guide

Use this when adding or maintaining extensions that call external APIs.

## Current API-backed extensions

| Extension                  | API                                          | Env                                                  | Docs                                                                                |
| -------------------------- | -------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `extensions/websearch/`    | Exa Search API via `exa-js`                  | `EXA_API_KEY`, optional `EXA_ENDPOINT_URL`           | https://exa.ai/docs/reference/search-api-guide-for-coding-agents.md                 |
| `extensions/context7/`     | Context7 Public API                          | `CONTEXT7_API_KEY`, optional `CONTEXT7_ENDPOINT_URL` | https://context7.com/docs/openapi.json                                              |
| `extensions/codesearch.ts` | grep.app remote MCP endpoint                 | none                                                 | https://mcp.grep.app, community docs: https://pypi.org/project/grep-mcp/            |
| `extensions/voice-input/`  | ElevenLabs realtime speech-to-text WebSocket | `ELEVENLABS_API_KEY`, optional `ELEVENLABS_LANGUAGE` | https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime |
| `extensions/provider/`     | Custom provider setup endpoint               | `PROVIDER_API_KEY`                                   | Internal protocol in `extensions/provider/index.ts`                                 |

## Baseline implementation pattern

```ts
const apiKey = requireEnv('SERVICE_API_KEY')
if (!apiKey.ok) return toolError(apiKey.message, details)

const response = await fetchJson<ResponseShape>(
  url,
  { headers: { Authorization: `Bearer ${apiKey.value}` } },
  { signal, timeoutMs: 30_000 }
)
```

For SDKs that do not accept `AbortSignal`, still check `signal?.aborted` after awaited calls before returning expensive output.

## External API notes

### Exa Search

Docs read:

- https://exa.ai/docs/reference/search-api-guide-for-coding-agents.md
- https://exa.ai/docs/reference/contents-api-guide-for-coding-agents.md
- https://exa.ai/docs/llms.txt

Important details:

- Search endpoint: `POST https://api.exa.ai/search`.
- Auth header in REST docs: `x-api-key`; `exa-js` handles this when constructed with the key.
- Recommended search types: `auto`, `fast`, `instant`, `deep-lite`, `deep`, `deep-reasoning`.
- Legacy docs may mention `neural`; new code should default to `auto` and not expose `neural`.
- `numResults` range is `1..100`.
- Contents should be budgeted. Prefer `highlights: true` for agent workflows, use full `text` only when needed and cap `maxCharacters`.
- Freshness belongs under contents as `contents.maxAgeHours` in REST docs. The extension uses direct REST instead of `exa-js` so it can pass current REST-only fields.
- Categories in current REST docs: `company`, `people`, `research paper`, `news`, `personal site`, `financial report`.
- Category restrictions from docs:
  - `company`: does not support `startPublishedDate`, `endPublishedDate`, `excludeDomains`.
  - `people`: does not support `startPublishedDate`, `endPublishedDate`, `excludeDomains`; `includeDomains` only accepts LinkedIn domains.

Maintenance notes:

- Keep tool descriptions synchronized with the REST docs, not stale SDK types.
- If switching back to `exa-js`, first verify support for `contents.maxAgeHours`, `deep-lite`, `deep-reasoning`, `systemPrompt`, and `outputSchema`.

### Context7

Docs read:

- https://context7.com/docs/openapi.json
- https://context7.com/docs/sdks/ts/commands/search-library
- https://context7.com/docs/sdks/ts/commands/get-context

Important details:

- Base URL: `https://context7.com/api`.
- `GET /v2/libs/search` params: `libraryName`, `query`, optional `fast`.
- `GET /v2/context` params: `libraryId`, `query`, `type`, optional `fast`.
- `/v2/context` can return JSON or `text/plain`; `type=txt` is appropriate for direct LLM context.
- `libraryId` is documented in `/owner/repo` form. The API docs accept that form; if stripping a leading slash locally, keep it isolated and tested.
- Search response includes useful ranking metadata: `trustScore`, `benchmarkScore`, `totalSnippets`, `stars`, `versions`, `state`.
- Error statuses include `202`, `301`, `400`, `401`, `402`, `403`, `404`, `422`, `429`, `500`, `503`; do not assume all non-200 failures mean missing library.

Maintenance notes:

- Prefer rendering library rows with trust/snippet/benchmark metadata rather than raw JSON.
- Keep `type=txt` for docs if the model should consume snippets directly.

### grep.app remote MCP

Docs read:

- https://mcp.grep.app
- https://pypi.org/project/grep-mcp/

Important details:

- The remote endpoint is an MCP server over HTTP/SSE.
- The public tool naming differs across servers/docs (`searchGitHub`, `grep_query`, etc.); verify against the live endpoint when changing request shape.
- Useful filters: query, language, repository, path.
- The endpoint is unauthenticated but may rate limit; keep timeouts and compact rendering.

Maintenance notes:

- The current extension posts a JSON-RPC `tools/call` request and parses the first `data:` line from SSE. If the MCP transport evolves, update parsing with a fixture test.

### ElevenLabs realtime speech-to-text

Docs read:

- https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
- https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/event-reference

Important details:

- WebSocket endpoint: `wss://api.elevenlabs.io/v1/speech-to-text/realtime`.
- Auth can use `xi-api-key` header or single-use `token` query parameter. Server-side tools can use `xi-api-key`; client-facing flows should use tokens.
- Query params include `model_id`, `audio_format`, `language_code`, `commit_strategy`, VAD thresholds, timestamps/language detection flags.
- Audio is sent as `input_audio_chunk` messages.
- Received events include `session_started`, `partial_transcript`, `committed_transcript`, `committed_transcript_with_timestamps`.
- Error types include `auth_error`, `quota_exceeded`, `input_error`, `rate_limited`, `chunk_size_exceeded`, `session_time_limit_exceeded`, etc.

Maintenance notes:

- Keep chunk size conservative and close the WebSocket/recording process on every error/cancel path.
- Surface API errors in the UI without dumping raw event payloads.

## Checklist for API-backed tools

- Read the current official docs and record the URL in this guide or in the extension header.
- Use `requireEnv()` for mandatory keys.
- Use `fetchText()` / `fetchJson()` with `timeoutMs` when possible.
- Preserve `AbortSignal` when the API or SDK supports it; otherwise check `signal?.aborted` after awaited calls.
- Return structured `details` and render from details; do not parse rendered text in UI code.
- Keep compact output small; put raw docs/page text/results in expanded view.
- Clamp or cap all external content before rendering and before returning to the model.
- Add fixture tests for non-trivial response parsing, especially SSE/MCP and markdown/text transformations.
- Re-read docs and SDK types when bumping dependencies.
