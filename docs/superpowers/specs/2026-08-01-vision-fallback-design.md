# Vision Fallback Design

Date: 2026-08-01
Status: Approved

## Problem

The user's primary model is `ollama-cloud/deepseek-v4-flash:0731`, which does not support images. When an image enters the session (pasted by the user or returned by a tool such as screenshot/read), pi silently replaces the image with the placeholder text `(image omitted: model does not support images)` — the model never sees it.

The user wants automatic model fallback: when the active model cannot accept images, switch to a vision-capable model, then switch back when the image work is done.

## Current pi Behavior

- No native image-triggered model switching.
- `transform-messages.js` in pi-ai strips `image` blocks for models whose `input` field lacks `"image"`.
- No native quota/error-based fallback chain.
- Available hooks: `message_start`, `message_end`, `agent_end`, `model_select`, `session_start`; programmatic switching via `pi.setModel(model)`.

## Model Landscape (verified)

| Model | Provider | Vision |
|---|---|---|
| `deepseek-v4-flash:0731` (primary) | ollama-cloud | No |
| `kimi-k2.7-code` (fallback 1) | ollama-cloud | Yes |
| `MiniMax-M3` (fallback 2) | minimax | Yes (`input: ["text","image"]`) |
| `glm-5.2` | ollama-cloud | No (excluded) |

Both fallback providers have API keys configured. Ollama Cloud quota exhaustion surfaces as HTTP 429 / "rate limited" errors; there is no public quota query API, so detection is reactive.

## Design

New extension `extensions/vision-fallback.ts` (with `extensions/vision-fallback.test.ts`), registered in `package.json` → `pi.extensions` and the `README.md` table.

### Gate: image support check

```ts
function supportsImages(model): boolean {
  return model.input?.includes("image") ?? false
}
```

This matches pi's own stripping decision exactly (same `input` field). Models that support images — ChatGPT/GPT family, any vision model on any provider — are never touched, and `homeModel` is only recorded when a switch actually happens.

### Session state (reset on `session_start`)

```ts
{
  homeModel: { provider, id } | null   // model active when fallback engaged
  fallbackActive: boolean              // currently on a vision model we switched to
  ollamaCloudDegraded: boolean         // quota/rate-limit flag
  ollamaErrorStreak: number            // consecutive quota-pattern errors
  pendingSwitchBack: boolean           // switch back at next idle boundary
  internalSwitch: boolean              // true while we call pi.setModel ourselves
}
```

### Rule 1 — image enters → switch to vision model (`message_start`)

- Scan `event.message.content` for `image` blocks; fire for user messages and toolResult messages (covers pasted images and tool-returned images, e.g. screenshot/read).
- Act only when the current model's `supportsImages()` is false.
- Target chain: `ollama-cloud/kimi-k2.7-code` when ollama-cloud is healthy, else `minimax/MiniMax-M3`.
- Record `homeModel` = current model before switching (only when not already in fallback).
- `pi.setModel()` failure (no API key) → try next target; if all fail, notify.
- Never switch back from toolResult messages — only from user-message boundaries.
- Debounce: no repeated switches for the same state.

### Rule 2 — text-only user message → switch back (`message_start` + `agent_end`)

- New user message with no images + `fallbackActive` + current model is one we switched to → set `pendingSwitchBack`.
- If `ctx.isIdle()`, switch back to `homeModel` immediately; otherwise defer to `agent_end` so streaming vision work is not interrupted.
- Clear fallback state after switching back.
- If the user manually changes the model via `/model` (detected in `model_select` with `internalSwitch` false), cancel auto-switch-back — manual control wins.

### Rule 3 — Ollama Cloud quota detection (`message_end`)

- Match: assistant message with `provider === "ollama-cloud"`, `stopReason === "error"`, and errorMessage matching `rate limit|429|quota|exhausted` (case-insensitive).
- `ollamaErrorStreak >= 2` → `ollamaCloudDegraded = true` + notify user.
- When degraded: if currently on `ollama-cloud/kimi-k2.7-code`, switch to `minimax/MiniMax-M3`. Never touch the primary model (user controls it).
- Non-quota errors reset the streak.

### Testing

- Pure decision functions (`supportsImages`, fallback target selection, quota-pattern match, switch-back conditions) unit-tested with a mocked `ExtensionAPI` following the `workflow-shortcuts.test.ts` pattern.
- Coverage: image in user message, image in toolResult, text-only message switches back, deferral while streaming, quota streak → degraded, degraded skips kimi, manual model change cancels auto-switch-back.

### Quality Gates

`npm run check`, `npm run test`, `npm run format:check` before committing.
