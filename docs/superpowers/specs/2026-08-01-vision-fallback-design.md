# Vision Fallback Design

Date: 2026-08-01
Status: Approved (revised 2026-08-04 — client-side handoff replaces model switching)

## Problem

The user's primary model is `ollama-cloud/deepseek-v4-flash:0731`, which does not support images. When an image enters the session (pasted by the user or returned by a tool such as screenshot/read), pi silently replaces the image with the placeholder text `(image omitted: model does not support images)` — the model never sees it.

## Current pi Behavior

- No native image-triggered model switching; `transform-messages.js` in pi-ai strips `image` blocks for models whose `input` field lacks `"image"`.
- `message_end` handlers can return `{ message }` to replace a finalized message; the session mutates the message object in place, so the replacement is visible to the next LLM call and persists in history.
- Extension API exposes `ctx.modelRegistry.find()`, `ctx.modelRegistry.getApiKeyForProvider()`, and pi-ai provider stream functions (`streamSimpleOpenAICompletions`, `streamSimpleAnthropic`) for side calls.

## Model Landscape (verified)

| Model | Provider | API | Vision |
|---|---|---|---|
| `deepseek-v4-flash:0731` (primary) | ollama-cloud | openai-completions | No |
| `kimi-k2.7-code` (handoff 1) | ollama-cloud | openai-completions | Yes |
| `MiniMax-M3` (handoff 2) | minimax | anthropic-messages | Yes |

Both handoff providers have API keys configured. Ollama Cloud quota exhaustion surfaces as HTTP 429 / "rate limited" errors; there is no public quota query API, so detection is reactive.

## Revision: Client-Side Vision Handoff

The original design switched the active model on image arrival. Field testing showed this is fragile: the agent loop snapshots the model per turn, mid-turn switches only take effect after a tool cycle, and switching rewrites the user's default model in settings.json. The pattern used by `pi-provider-umans` is strictly more reliable: **keep the text model, analyze the image with a vision model in a side call, and inject the analysis as text**.

New extension `extensions/vision-fallback.ts` (with `extensions/vision-fallback.test.ts`), registered in `package.json` → `pi.extensions` and the `README.md` table.

### Gate: image support check

```ts
function supportsImages(model): boolean {
  return model?.input?.includes("image") ?? false
}
```

Matches pi's own stripping decision. Models that support images (ChatGPT/GPT family, any vision model) are never touched.

### Flow

1. `message_end` fires for a user or toolResult message containing image blocks, and the active model `supportsImages()` is false.
2. Pick the vision target: `ollama-cloud/kimi-k2.7-code` when Ollama Cloud is healthy, else `minimax/MiniMax-M3`.
3. Side-call the vision model via pi-ai's own stream functions (`streamSimpleOpenAICompletions` for ollama-cloud, `streamSimpleAnthropic` for minimax — branched on `model.api`), with the analysis prompt + image, `maxRetries: 0`, 60s timeout, abort-aware via `ctx.signal`.
4. Replace every image block with `[Image analysis (image:img_xxxxxxxx)]: <report>` and return `{ message: transformed }` — the session mutates the message in place, so the text model sees the analysis on the very next LLM call and the analysis persists in history (not re-analyzed on later turns).
5. Image bytes are cached (keyed by content hash) so the `vision_followup` tool can answer targeted follow-up questions about a specific image.

### Quota degradation

- A side-call failure from `ollama-cloud` matching `rate limit|429|quota|exhausted` increments a streak; 2 consecutive failures mark the session degraded → subsequent analyses (and `vision_followup`) use `minimax/MiniMax-M3` directly.
- Successful ollama-cloud analyses reset the streak. The primary model is never touched.

### Testing

- Pure decision functions (`supportsImages`, `hasImageBlocks`, `pickVisionTarget`, `isQuotaErrorText`, `hashImageId`, `buildAnalysisBlock`) unit-tested with vitest.
- Coverage: text-only vs vision gate, image block detection, degraded chain selection, quota pattern matching, stable image ids, analysis block format.

### Known limitations

- `read` on an image file strips the image itself for text-only models (pi tool behavior), so those images cannot be analyzed; tools that return image blocks (screenshot etc.) are covered.
- Images are only analyzed when a user/toolResult message carries image blocks; a paste that arrives as a bare file path is not an image block.

### Quality Gates

`npm run check`, `npm run test`, `npm run format:check` before committing.
