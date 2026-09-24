#!/usr/bin/env node
/**
 * Re-measure Command Code model capabilities.
 *
 * The upstream /v1/models endpoint only returns identity fields, so the
 * reasoning metadata in extensions/provider-commandcode.ts is pinned from
 * measurements. Run this after upstream adds or changes models:
 *
 *   COMMANDCODE_API_KEY=... node scripts/probe-commandcode-capabilities.mjs
 *   node scripts/probe-commandcode-capabilities.mjs --only gpt-6
 *
 * The API key falls back to the `commandcode` entry in ~/.pi/agent/auth.json.
 * Rejected values (HTTP 400) cost nothing; accepted probes generate a few
 * tokens each.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE_URL = 'https://api.commandcode.ai/provider/v1'
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'none', 'minimal']
const CONCURRENCY = 4

function resolveApiKey() {
  if (process.env.COMMANDCODE_API_KEY) return process.env.COMMANDCODE_API_KEY
  const authPath = join(homedir(), '.pi', 'agent', 'auth.json')
  try {
    const auth = JSON.parse(readFileSync(authPath, 'utf8'))
    if (auth.commandcode?.key) return auth.commandcode.key
  } catch {
    // fall through to the error below
  }
  throw new Error('No API key: set COMMANDCODE_API_KEY or log in with /login')
}

function parseArgs(argv) {
  const onlyIndex = argv.indexOf('--only')
  return {
    only: onlyIndex === -1 ? undefined : argv[onlyIndex + 1],
    json: argv.includes('--json')
  }
}

async function request(path, apiKey, init = {}, timeoutMs = 45_000) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...init.headers
    }
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body }
}

async function listModels(apiKey) {
  const { status, body } = await request('/models', apiKey)
  if (status !== 200) throw new Error(`GET /models failed: HTTP ${status}`)
  return (body.data ?? []).map((model) => model.id)
}

async function probeEffort(apiKey, modelId, effort, maxTokens = 16, prompt = 'hi') {
  for (let attempt = 0; ; attempt++) {
    let result
    try {
      const { status, body } = await request(
        '/chat/completions',
        apiKey,
        {
          method: 'POST',
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: maxTokens,
            reasoning_effort: effort
          })
        },
        maxTokens > 16 ? 120_000 : 45_000
      )
      result = {
        effort,
        status,
        reasoningTokens: body?.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
        error: body?.error?.message ?? ''
      }
    } catch (requestError) {
      // A hung or dropped connection must not abort the whole sweep.
      result = { effort, status: 0, reasoningTokens: 0, error: `request failed: ${requestError}` }
    }
    // Upstream providers throttle and flake under load; back off instead of losing the signal.
    const retriable = result.status === 0 || result.status === 429 || result.status >= 500
    if (retriable && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt))
      continue
    }
    return result
  }
}

/** Reasoning probes prefer a level that is fast but still representative. */
const REASONING_EFFORT_ORDER = ['high', 'medium', 'max', 'xhigh', 'low']
/** Trivial prompts make some models skip reasoning entirely, which reads as "no thinking". */
const REASONING_PROMPT = 'Solve 17*23 step by step.'

async function probeModel(apiKey, modelId) {
  const attempts = []
  for (const effort of EFFORTS) {
    attempts.push(await probeEffort(apiKey, modelId, effort))
  }
  const rejectedForPlan = attempts.filter(
    (a) => a.status === 403 && a.error.includes('MODEL_NOT_IN_PLAN')
  )
  const accepted = attempts.filter((a) => a.status === 200).map((a) => a.effort)
  // Only explicit 400s count as rejections; throttled levels stay unknown.
  const rejected = attempts.filter((a) => a.status === 400).map((a) => a.effort)
  const failed = attempts.filter(
    (a) =>
      a.status !== 200 &&
      a.status !== 400 &&
      !a.error.includes('must be called via') &&
      !rejectedForPlan.includes(a)
  )
  // A 16-token cap can spend the whole budget on reasoning and report nothing,
  // so reasoning support gets its own probe with room to answer.
  const highest = REASONING_EFFORT_ORDER.find((effort) => accepted.includes(effort))
  const reasoningProbe = highest
    ? await probeEffort(apiKey, modelId, highest, 256, REASONING_PROMPT)
    : undefined
  return {
    id: modelId,
    accepted,
    rejected,
    reasoning: (reasoningProbe?.reasoningTokens ?? 0) > 0,
    needsMessages: attempts.some((a) => String(a.error).includes('must be called via')),
    blockedByPlan: accepted.length === 0 && rejectedForPlan.length > 0,
    errors: [...new Set(failed.map((a) => `HTTP ${a.status}: ${a.error.slice(0, 120)}`))]
  }
}

async function mapPool(items, mapper) {
  const results = []
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await mapper(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))
  return results
}

function printReport(reports) {
  const reasoning = reports.filter((r) => r.reasoning).map((r) => r.id)
  const nonReasoning = reports
    .filter((r) => !r.reasoning && !r.needsMessages && !r.blockedByPlan && r.accepted.length > 0)
    .map((r) => r.id)
  const messagesOnly = reports.filter((r) => r.needsMessages).map((r) => r.id)
  const blockedByPlan = reports.filter((r) => r.blockedByPlan).map((r) => r.id)
  const measurable = ['low', 'medium', 'high', 'xhigh', 'max']
  const levelExceptions = reports
    .filter((r) => r.reasoning)
    .map((r) => ({ id: r.id, rejected: measurable.filter((e) => r.rejected.includes(e)) }))
    .filter((r) => r.rejected.length > 0)

  console.log('\nAccepted efforts per model')
  for (const report of reports) {
    const note = report.blockedByPlan
      ? 'blocked by plan'
      : report.needsMessages
        ? '/messages only'
        : ''
    console.log(`  ${report.id.padEnd(42)} ${report.accepted.join(',') || '-'} ${note}`)
  }

  console.log(`\nREASONING_MODEL_IDS (${reasoning.length})`)
  for (const id of reasoning) console.log(`  '${id}',`)

  console.log(`\nClaude models that require /messages (${messagesOnly.length})`)
  for (const id of messagesOnly) console.log(`  ${id}`)

  console.log(`\nMeasured level exceptions (${levelExceptions.length})`)
  for (const { id, rejected } of levelExceptions) {
    console.log(`  '${id}': { ${rejected.map((e) => `${e}: null`).join(', ')} },`)
  }

  console.log(`\nNo measured reasoning (${nonReasoning.length})`)
  for (const id of nonReasoning) console.log(`  ${id}`)

  console.log(`\nBlocked by plan, not measurable here (${blockedByPlan.length})`)
  for (const id of blockedByPlan) console.log(`  ${id}`)

  const withErrors = reports.filter((r) => r.errors.length > 0)
  if (withErrors.length > 0) {
    console.log('\nNot cleanly probed (transient failures, rerun these)')
    for (const report of withErrors) {
      console.log(`  ${report.id}: ${report.errors.join(' | ')}`)
    }
  }
}

const apiKey = resolveApiKey()
const { only, json } = parseArgs(process.argv.slice(2))
const all = await listModels(apiKey)
const targets = only ? all.filter((id) => id.includes(only)) : all
if (targets.length === 0) throw new Error(`No models matched ${only}`)

console.log(`Probing ${targets.length} of ${all.length} models (${EFFORTS.length} efforts each)`)
const reports = await mapPool(targets, (id) => probeModel(apiKey, id))
const sorted = reports.sort((a, b) => a.id.localeCompare(b.id))

if (json) {
  console.log(JSON.stringify(sorted, null, 2))
} else {
  printReport(sorted)
}
