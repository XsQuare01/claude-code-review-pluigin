#!/usr/bin/env node
// Measures what a review actually costs in tokens, per rule file and per workflow.
//
// Why this exists: every cost decision in this repo was being made on byte counts.
// Bytes are a poor stand-in for tokens and worst of all for non-English text, so
// "this module is expensive" was an impression, not a measurement.
//
// Why CI does not call the API: count_tokens is free but needs a credential, and
// fork pull requests do not get secrets. So this follows the same split as
// tests/workflow-fixtures.md — the artifact is committed, and CI only checks that
// it has not gone stale.
//
//   --write [--model <id>]  measure against the API and write the report + baseline
//   --check                 compare the tree against the baseline (no credential)
//   --dry-run               everything except the HTTP call, using a stub counter
//   --out <dir>             write somewhere other than docs/ (also makes --dry-run write,
//                           which is how --check gets tested without a credential)
//
// No dependencies, no install step — same constraint as validate-rules.mjs.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RULES = join(ROOT, 'review-rules')
const SKILLS = join(ROOT, 'skills')
const outDir = (() => {
  const i = process.argv.indexOf('--out')
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : join(ROOT, 'docs')
})()
const REPORT = join(outDir, 'token-report.md')
const BASELINE = join(outDir, 'token-baseline.json')

const DEFAULT_MODEL = 'claude-opus-5'
const WORKFLOW_NAMES = ['default', 'full', 'fast', 'commit', 'props', 'math', 'exception']

// workflow-contract.md is deliberately absent from catalog.json (it is a contract, not a
// rule module — validate-rules.mjs excludes it from the catalog-coverage check), but every
// skill reads it, so it is common context for every workflow and must be counted here.
const COMMON = ['00-rule.md', 'workflow-contract.md']

const read = p => readFileSync(p, 'utf8')
const sha = s => createHash('sha256').update(s).digest('hex').slice(0, 16)
const die = msg => { console.error(msg); process.exit(1) }

// ------------------------------------------------------------------ composition

// Which files each workflow loads comes from catalog.json, whose membership the
// validator now holds to what each skill declares. Do not hardcode the lists here:
// that is exactly the drift the catalog check was added to stop.
function composition() {
  const catalog = JSON.parse(read(join(RULES, 'catalog.json')))
  const entries = catalog.modules ?? []
  const skillDirs = readdirSync(SKILLS).filter(d => existsSync(join(SKILLS, d, 'SKILL.md')))

  const dispatchByWorkflow = new Map()
  for (const dir of skillDirs) {
    const text = read(join(SKILLS, dir, 'SKILL.md'))
    const wf = (/`workflow-name`(?:은|는)?\s*\|?\s*`([a-z]+)`/.exec(text) ?? [])[1]
    if (!wf) continue
    const declared = (/^\|\s*분할 방식\s*\|\s*(.+?)\s*\|\s*$/m.exec(text) ?? [])[1]
    if (declared === undefined) {
      // Specialist workflows read a single document, so one pass is the only shape
      // available to them; treat a missing row as consolidated and verify below.
      dispatchByWorkflow.set(wf, { kind: 'consolidated', source: 'no 분할 방식 row' })
    } else if (/모듈별 sub-agent/.test(declared)) {
      dispatchByWorkflow.set(wf, { kind: 'per-module', source: declared })
    } else if (/단일/.test(declared)) {
      dispatchByWorkflow.set(wf, { kind: 'consolidated', source: declared })
    } else {
      // Guessing here would silently misreport a fan-out multiplier — the same class of
      // error the catalog membership bug was. Fail instead of widening the pattern.
      die(`skills/${dir}/SKILL.md: 분할 방식 "${declared}" is not a recognized form.\n` +
          `Phrase it with "모듈별 sub-agent" or "단일 …", or teach token-report.mjs the new form.`)
    }
  }

  const workflows = {}
  for (const wf of WORKFLOW_NAMES) {
    const files = entries
      .filter(e => (e.workflows ?? []).includes(wf) && e.role !== 'common-context')
      .map(e => e.path)
      .sort()
    const dispatch = dispatchByWorkflow.get(wf)
    if (!dispatch) die(`no skill declares workflow-name "${wf}" — cannot determine its dispatch`)
    if (dispatch.kind === 'consolidated' && dispatch.source === 'no 분할 방식 row' && files.length > 1) {
      die(`workflow "${wf}" loads ${files.length} rule documents but declares no 분할 방식 — ` +
          `add the row so the dispatch shape is not assumed`)
    }
    workflows[wf] = { files, dispatch: dispatch.kind, passes: dispatch.kind === 'per-module' ? files.length : 1 }
  }

  const measured = [...new Set([...COMMON, ...Object.values(workflows).flatMap(w => w.files)])].sort()
  return { workflows, measured }
}

// A fingerprint of the *shape* of the corpus: which files exist and how each workflow
// composes them. Content edits move token counts a little; shape changes move them a lot,
// and only the latter is worth failing a pull request over.
function structureHash({ workflows, measured }) {
  const shape = {
    measured,
    workflows: Object.fromEntries(
      Object.entries(workflows).map(([w, v]) => [w, { files: v.files, dispatch: v.dispatch }])),
  }
  return { hash: sha(JSON.stringify(shape)), shape }
}

// ---------------------------------------------------------------------- counting

function credentials() {
  if (process.env.ANTHROPIC_API_KEY) {
    return { 'x-api-key': process.env.ANTHROPIC_API_KEY }
  }
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    // OAuth tokens go on Authorization, not x-api-key, and /v1/messages rejects them
    // without this beta header.
    return {
      Authorization: `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`,
      'anthropic-beta': 'oauth-2025-04-20',
    }
  }
  try {
    // --access-token is required: with no flag, print-credentials emits the whole JSON
    // document, which produces an empty response when pasted into a header.
    const token = execFileSync('ant', ['auth', 'print-credentials', '--access-token'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (token) {
      return { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }
    }
  } catch { /* ant not installed or no active profile */ }
  die('no credential found for --write.\n' +
      '  set ANTHROPIC_API_KEY, or run `ant auth login` (then `ant auth status` to confirm).\n' +
      '  --check and --dry-run need no credential.')
}

function apiCounter(model) {
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...credentials() }
  let calls = 0
  return {
    get calls() { return calls },
    async count(text) {
      calls++
      const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages: [{ role: 'user', content: text }] }),
      })
      if (!res.ok) {
        die(`count_tokens failed: ${res.status} ${res.statusText}\n${await res.text()}`)
      }
      const body = await res.json()
      if (typeof body.input_tokens !== 'number') {
        die(`count_tokens returned no input_tokens:\n${JSON.stringify(body)}`)
      }
      return body.input_tokens
    },
  }
}

// Exercises every code path except the network, so composition and reporting can be
// verified without a credential. Its numbers are NOT tokens and the report says so.
function stubCounter() {
  let calls = 0
  return {
    get calls() { return calls },
    async count(text) { calls++; return Math.ceil(text.length / 3) },
  }
}

// ----------------------------------------------------------------------- measure

async function measure(counter, { workflows, measured }) {
  // Every count is of a *request*, so each carries a constant wrapper cost. Report it
  // rather than hiding it: per-file numbers below each include it once.
  const overhead = await counter.count('.')

  const files = {}
  for (const name of measured) {
    const text = read(join(RULES, name))
    files[name] = { tokens: await counter.count(text), sha256: sha(text) }
  }

  const body = name => read(join(RULES, name))
  const commonText = COMMON.map(body).join('\n\n')
  const commonTokens = await counter.count(commonText)

  const results = {}
  for (const [wf, { files: wfFiles, dispatch, passes }] of Object.entries(workflows)) {
    if (dispatch === 'consolidated') {
      // Measure the composed prompt rather than summing per-file counts: tokenization is
      // not strictly additive across a concatenation, and the sum is what we are replacing.
      const tokens = await counter.count([commonText, ...wfFiles.map(body)].join('\n\n'))
      results[wf] = { tokens, passes, dispatch, commonTokens }
    } else {
      // One sub-agent per document, each carrying the common context again.
      let tokens = 0
      for (const f of wfFiles) tokens += await counter.count([commonText, body(f)].join('\n\n'))
      const consolidated = await counter.count([commonText, ...wfFiles.map(body)].join('\n\n'))
      results[wf] = { tokens, passes, dispatch, commonTokens, consolidated }
    }
  }
  return { overhead, files, commonTokens, workflows: results, calls: counter.calls }
}

// ------------------------------------------------------------------------ render

function renderReport(m, { workflows, measured }, { model, measuredAt, stub }) {
  const pct = (n, d) => (d ? (n / d * 100).toFixed(1) + '%' : '—')
  const baseline = m.workflows.default.tokens
  const L = []

  L.push('# Token report')
  L.push('')
  if (stub) {
    L.push('> **STUB NUMBERS — NOT TOKENS.** Generated with `--dry-run`, which replaces the API')
    L.push('> call with a character-count stub so the composition logic can be checked without a')
    L.push('> credential. Run `--write` for real measurements.')
    L.push('')
  }
  L.push(`Generated by \`scripts/token-report.mjs\`. Do not edit by hand — re-run \`--write\`.`)
  L.push('')
  L.push('| | |')
  L.push('|---|---|')
  L.push(`| Model | \`${model}\` |`)
  L.push(`| Measured | ${measuredAt} |`)
  L.push(`| Request overhead | ${m.overhead} tokens — every per-file number below includes it once |`)
  L.push(`| count_tokens calls | ${m.calls} |`)
  L.push('')
  L.push('Token counts are **per model**: the same text tokenizes differently across models, so')
  L.push('these numbers mean nothing without the model above. Re-measure after a model change.')
  L.push('')

  L.push('## Per workflow')
  L.push('')
  L.push('Payloads are measured on the composed prompt, not summed from the per-file table —')
  L.push('tokenization is not strictly additive across a concatenation.')
  L.push('')
  L.push('| Workflow | Dispatch | Passes | Rule docs | Tokens | vs `default` |')
  L.push('|---|---|---|---|---|---|')
  for (const wf of WORKFLOW_NAMES) {
    const r = m.workflows[wf]
    const ratio = baseline ? (r.tokens / baseline).toFixed(2) + '×' : '—'
    L.push(`| \`${wf}\` | ${r.dispatch} | ${r.passes} | ${workflows[wf].files.length} | ${r.tokens.toLocaleString()} | ${ratio} |`)
  }
  L.push('')
  L.push(`Common context (\`${COMMON.join('` + `')}\`) is **${m.commonTokens.toLocaleString()} tokens**.`)
  const fanout = Object.entries(m.workflows).filter(([, r]) => r.dispatch === 'per-module')
  for (const [wf, r] of fanout) {
    const redundant = m.commonTokens * (r.passes - 1)
    L.push('')
    L.push(`\`${wf}\` re-sends it once per pass: **${r.passes} × ${m.commonTokens.toLocaleString()} = ${(m.commonTokens * r.passes).toLocaleString()} tokens** of common context, ` +
           `of which **${redundant.toLocaleString()} is redundant** across passes. Consolidating the same documents into one prompt would be ${r.consolidated.toLocaleString()} tokens.`)
  }
  L.push('')

  L.push('## Per file')
  L.push('')
  L.push('| File | Tokens | Share of `default` |')
  L.push('|---|---|---|')
  for (const name of [...measured].sort((a, b) => m.files[b].tokens - m.files[a].tokens)) {
    L.push(`| \`${name}\` | ${m.files[name].tokens.toLocaleString()} | ${pct(m.files[name].tokens, baseline)} |`)
  }
  L.push('')
  L.push('## Korean / English ratio')
  L.push('')
  L.push('_Not measured yet._ Run a paired sample — one module and a faithful English translation —')
  L.push('and record both counts plus the model here, so the question stops being answered from')
  L.push('folklore. Note that roughly two thirds of this corpus is already ASCII (rule IDs, paths,')
  L.push('code, Markdown), which bounds what a language change can reach.')
  L.push('')
  return L.join('\n')
}

// -------------------------------------------------------------------------- main

const args = process.argv.slice(2)
const mode = args.find(a => ['--write', '--check', '--dry-run'].includes(a))
const model = (args[args.indexOf('--model') + 1] && args.includes('--model')) ? args[args.indexOf('--model') + 1] : DEFAULT_MODEL

if (!mode) {
  console.error('usage: token-report.mjs (--write [--model <id>] | --check | --dry-run)')
  process.exit(2)
}

const comp = composition()
const { hash, shape } = structureHash(comp)

if (mode === '--check') {
  if (!existsSync(BASELINE)) {
    if (existsSync(REPORT)) {
      die(`docs/token-report.md exists but docs/token-baseline.json does not.\n` +
          `  The baseline is what makes the report checkable — restore it or re-run --write.`)
    }
    console.log('token-report: no baseline yet — run `node scripts/token-report.mjs --write` to create one.')
    process.exit(0)
  }
  const base = JSON.parse(read(BASELINE))

  if (base.stub) {
    die('token-report: the baseline holds stub numbers, not tokens.\n' +
        '  It was produced by --dry-run. Re-run --write with a credential.')
  }

  if (base.structure?.hash !== hash) {
    const was = new Set(base.structure?.shape?.measured ?? [])
    const now = new Set(shape.measured)
    const added = [...now].filter(f => !was.has(f))
    const removed = [...was].filter(f => !now.has(f))
    const moved = WORKFLOW_NAMES.filter(w =>
      JSON.stringify(base.structure?.shape?.workflows?.[w]) !== JSON.stringify(shape.workflows[w]))
    console.error('token-report: the corpus changed shape since the report was written.')
    if (added.length) console.error(`  added:   ${added.join(', ')}`)
    if (removed.length) console.error(`  removed: ${removed.join(', ')}`)
    if (moved.length) console.error(`  workflow composition changed: ${moved.join(', ')}`)
    console.error('  Token counts are no longer meaningful — re-run `--write`.')
    process.exit(1)
  }

  const drifted = shape.measured.filter(f => sha(read(join(RULES, f))) !== base.files?.[f]?.sha256)
  if (drifted.length) {
    // Content edits shift counts a little. Failing here would block every rule-wording pull
    // request behind a credentialled re-measurement, and rule wording is the most common
    // change in this repo — so this reports and passes.
    console.log(`token-report: ${drifted.length} file(s) edited since measurement — counts are approximate:`)
    for (const f of drifted) console.log(`  ${f}`)
    console.log(`  Model: ${base.model}, measured ${base.measuredAt}. Re-run --write to refresh.`)
    process.exit(0)
  }

  console.log(`token-report: current — ${shape.measured.length} files, model ${base.model}, measured ${base.measuredAt}`)
  process.exit(0)
}

const stub = mode === '--dry-run'
const counter = stub ? stubCounter() : apiCounter(model)
const m = await measure(counter, comp)

if (stub) {
  console.log(`--dry-run: composition resolved, ${m.calls} count_tokens calls would be made.\n`)
  for (const wf of WORKFLOW_NAMES) {
    const r = m.workflows[wf]
    console.log(`  ${wf.padEnd(10)} ${r.dispatch.padEnd(12)} passes=${String(r.passes).padStart(2)}  docs=${String(comp.workflows[wf].files.length).padStart(2)}  stub=${r.tokens}`)
  }
  console.log('\nStub values are character counts, not tokens.')
}

const measuredAt = new Date().toISOString().slice(0, 10)
const wroteExplicitly = process.argv.includes('--out')

if (!stub || wroteExplicitly) {
  writeFileSync(REPORT, renderReport(m, comp, { model, measuredAt, stub }))
  writeFileSync(BASELINE, JSON.stringify({
    $comment: 'Written by scripts/token-report.mjs --write. `--check` compares the tree against this.',
    ...(stub ? { stub: true } : {}),
    model: stub ? 'stub' : model,
    measuredAt,
    requestOverheadTokens: m.overhead,
    structure: { hash, shape },
    files: m.files,
    workflows: m.workflows,
  }, null, 2) + '\n')
  console.log(`wrote ${REPORT} and ${BASELINE} (${m.calls} calls${stub ? ', STUB' : `, model ${model}`})`)
} else {
  console.log('Nothing was written — pass --out <dir> to write stub artifacts.')
}
