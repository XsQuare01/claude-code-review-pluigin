#!/usr/bin/env node
// 기존 구현 검색(C-6C) — 변경한 구현(A′)과 같은 일을 하는 diff 밖의 기존 구현(A) 후보를 찾아 05에 넘길 근거로 남긴다.
//
// Usage:
//   review-reuse.mjs register --dir D --run R [--wait-sec 1800]
//       첫 디스패치 전에 검색을 예정한다. 검색 ID를 정해 `reuse.planned`에 남기고, 계획 파일을 쓸 자리와 함께 낸다.
//   review-reuse.mjs check --dir D --run R --search-id S [--plan <계획 경로>] [--repo .]
//       search와 같은 계획 검사를 기록 없이 돌린다. 띄우기 전에 부른다 — 검색은 띄워 두고 돌아오므로, 계획이 틀린 것을
//       05가 풀린 뒤에야 알게 된다. 통과하면 0, 아니면 2. 표준 출력은 { ok, problems } 하나.
//   review-reuse.mjs search --dir D --run R --search-id S --out <reuse-context 경로> [--plan <계획 경로>] [--repo .]
//       계획을 검사하고 검색한다. `reuse.start`·`reuse.done`을 스스로 남긴다. 보통 review-tool --detach --name
//       reuse-search로 감싸 띄운다 — 다른 모듈 리뷰가 그동안 돈다.
//   review-reuse.mjs wait --dir D --run R [--timeout 초]
//       검색이 풀릴 때까지(끝·유실·시간 초과) 기다린다. 남은 일이 05뿐일 때 쓴다 — review-tool --wait는 lint·test까지
//       기다린다. 풀렸으면 0, 자기 상한에 먼저 닿으면 1. 표준 출력은 상태 JSON 하나.
//
// 무엇을 찾을지(계획)는 오케스트레이터가 쓴다. 계획 검사는 이 스크립트의 관문이다 — preflight의 scope.json에 있는
// 모든 파일에 search 또는 사유가 있는 exclude가 하나씩 있어야 하고, 대상의 anchor는 HEAD의 줄·인용과 맞고 이번
// 변경에 닿아야 한다. 하나라도 틀리면 검색하지 않고 실패로 끝을 남긴다(종료 코드 2). 빈 결과를 완료로 만들지 않는다.
//
// 결과는 `--out`에 UTF-8로 쓰고 표준 출력에는 경로·해시·상태만 낸다 — 원문이 셸을 지나지 않는다.

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { writeOutFile } from './lib/atomic-write.mjs'
import { readJsonFile, readTextFile } from './lib/read-text.mjs'
import {
  REUSE_LIMITS, REUSE_SCHEMA_VERSION, anchorProblems, changedRanges, gitReader, overallStatus, planProblems, searchTarget, sha256, summarizeTargets,
} from './lib/reuse-context.mjs'
import { reuseState } from './lib/reuse-state.mjs'
import { readEvents, recordPhase, requireStartedTimeline } from './lib/run-record.mjs'

const die = message => {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

const [mode, ...rest] = process.argv.slice(2)
if (!['register', 'check', 'search', 'wait'].includes(mode)) die('usage: review-reuse.mjs register|check|search|wait --dir D --run R …')
const VALUE_FLAGS = new Set(['dir', 'run', 'wait-sec', 'search-id', 'out', 'plan', 'repo', 'max-candidates', 'time-limit', 'timeout'])
const values = new Map()
for (let at = 0; at < rest.length; at += 1) {
  const arg = rest[at]
  if (!arg.startsWith('--')) die(`unexpected argument ${JSON.stringify(arg)} — 값에 공백이 있으면 따옴표로 감싼다`)
  const name = arg.slice(2)
  if (!VALUE_FLAGS.has(name)) die(`unknown flag ${arg}`)
  if (values.has(name)) die(`--${name}이 두 번 왔다`)
  const value = rest[at + 1]
  if (value === undefined || value.startsWith('--')) die(`${arg} needs a value`)
  values.set(name, value)
  at += 1
}

const dir = values.get('dir')
const run = values.get('run')
const sidecar = requireStartedTimeline(dir, run)

if (mode === 'wait') {
  const limitSec = Number(values.get('timeout') ?? 3600)
  if (!Number.isFinite(limitSec) || limitSec <= 0) die('--timeout은 양수(초)다')
  const until = Date.now() + limitSec * 1000
  const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  for (;;) {
    const state = reuseState(readEvents(sidecar))
    const brief = {
      state: state.state, released: state.released, searchId: state.searchId ?? null, ...(state.status ? { status: state.status } : {}),
      context: typeof state.done?.out === 'string' ? state.done.out : null, ...(state.releasedAt ? { releasedAt: state.releasedAt } : {}),
      ...(state.reason ? { reason: state.reason } : {}), ...(state.deadline ? { deadline: state.deadline } : {}),
    }
    if (state.released || Date.now() >= until) {
      process.stdout.write(`${JSON.stringify(brief)}\n`)
      process.exit(state.released ? 0 : 1)
    }
    sleep(Math.min(2000, Math.max(50, until - Date.now())))
  }
}

const events = readEvents(sidecar)
const start = events.find(event => event?.phase === 'run.start')
if (start?.reuseSearch !== 'planned') die('이 실행은 기존 구현 검색을 예정하지 않았다(run.start.reuseSearch) — preflight가 full 실행에만 남긴다')
const timing = join(dir, '.timing')
const scopePath = join(timing, `${run}.scope.json`)

/** scope.json은 정본이다. 읽지 못하면 빈 범위로 바꾸지 않고 멈춘다. */
const readScope = () => {
  let text
  try {
    text = readTextFile(scopePath)
  } catch (error) {
    return { error: `scope.json을 읽지 못했다: ${scopePath} — ${error.message}` }
  }
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { error: `scope.json이 JSON이 아니다: ${error.message}` }
  }
  if (value?.runId !== start.runId) return { error: `scope.json의 runId(${value?.runId})가 이 실행(${start.runId})과 다르다` }
  return { value, sha256: sha256(text) }
}

if (mode === 'register') {
  const scope = readScope()
  if (scope.error) die(scope.error)
  const waitSec = values.has('wait-sec') ? Number(values.get('wait-sec')) : null
  if (waitSec !== null && (!Number.isInteger(waitSec) || waitSec <= 0)) die('--wait-sec은 양의 정수(초)다')
  const searchId = `s-${randomBytes(4).toString('hex')}`
  const plan = values.get('plan') ?? join(timing, `${run}.reuse-plan.json`)
  try {
    recordPhase(dir, run, 'reuse.planned', {
      searchId, scopeSha256: scope.sha256, plan, runId: start.runId, head: start.head,
      ...(start.baseHead ? { baseHead: start.baseHead } : {}), ...(waitSec !== null ? { waitSec } : {}),
    })
  } catch (error) {
    die(`reuse.planned를 남기지 못했다 — ${String(error.stderr || error.message).trim()}`)
  }
  // 계획의 머리와 결정할 파일 목록을 함께 낸다 — 오케스트레이터가 preflight 출력에서 옮겨 적다 틀리면 계획 검사가
  // 검색 전체를 실패로 끝낸다. 파일 목록은 scope.json의 files 그대로다(다시 세지 않는다).
  const planHeader = { schemaVersion: REUSE_SCHEMA_VERSION, runId: start.runId, searchId, head: start.head, mergeBase: start.mergeBase, scopeSha256: scope.sha256 }
  process.stdout.write(`${JSON.stringify({
    searchId, plan, scopeSha256: scope.sha256, out: join(timing, `${run}.reuse-context.json`), planHeader, files: scope.value.files ?? [],
  }, null, 2)}\n`)
  process.exit(0)
}

// ── check · search ───────────────────────────────────────────────────────
const searchId = values.get('search-id')
const outPath = values.get('out')
if (!searchId) die(`${mode}에는 --search-id가 필요하다`)
if (mode === 'search' && !outPath) die('search에는 --out이 필요하다')
const planned = events.filter(event => event?.phase === 'reuse.planned').at(-1)
if (!planned || planned.searchId !== searchId) die(`등록되지 않은 검색 ID다(${searchId}) — 지금 시도는 ${planned?.searchId ?? '없음'}이다. register가 낸 ID로 부른다`)
const planPath = values.get('plan') ?? planned.plan

/**
 * 계획 검사 — search의 관문이고, check는 같은 검사를 띄우기 전에 한다. 기록을 남기지 않는다.
 * 통과하면 `{ plan, repoGit }`, 아니면 `{ reason, problems }`.
 */
function checkPlan() {
  const scope = readScope()
  if (scope.error) return { reason: 'scope-unreadable', problems: [scope.error] }
  let plan
  try {
    plan = readJsonFile(planPath)
  } catch (error) {
    return { reason: 'plan-unreadable', problems: [`계획을 읽지 못했다: ${planPath} — ${error.message}`] }
  }
  const root = gitReader(values.get('repo') ?? process.cwd()).root()
  if (!root) return { reason: 'git-failed', problems: ['저장소를 읽지 못했다(--repo)'] }
  const repoGit = gitReader(root)
  const problems = planProblems(plan, { scope: scope.value, runId: start.runId, head: start.head, mergeBase: start.mergeBase, searchId, scopeSha256: planned.scopeSha256 })
  if (scope.sha256 !== planned.scopeSha256) problems.push('scope.json이 예정을 등록한 뒤 바뀌었다')
  if (!problems.length) {
    for (const target of plan.targets) {
      const headText = repoGit.show(start.head, target.anchor.path)
      const diff = repoGit.diff(start.mergeBase, start.head, target.anchor.path)
      problems.push(...anchorProblems(target, { headText, ranges: diff.ok ? changedRanges(diff.out) : [] }))
      if (!diff.ok) problems.push(`${target.targetId}의 변경 범위를 읽지 못했다 — ${diff.error}`)
    }
  }
  return problems.length ? { reason: 'plan-invalid', problems } : { plan, repoGit }
}

if (mode === 'check') {
  const checked = checkPlan()
  const problems = checked.problems ?? []
  process.stdout.write(`${JSON.stringify({ ok: !problems.length, problems })}\n`)
  process.exit(problems.length ? 2 : 0)
}
const startedAt = Date.now()
const planSha256 = existsSync(planPath) ? sha256(readFileSync(planPath)) : null
try {
  recordPhase(dir, run, 'reuse.start', { searchId, plan: planPath, ...(planSha256 ? { planSha256 } : {}) })
} catch (error) {
  die(`reuse.start를 남기지 못했다 — ${String(error.stderr || error.message).trim()}`)
}

const limits = {
  ...REUSE_LIMITS,
  ...(values.has('max-candidates') ? { candidatesPerTarget: Number(values.get('max-candidates')) } : {}),
  ...(values.has('time-limit') ? { timeLimitSec: Number(values.get('time-limit')) } : {}),
}
const base = {
  schemaVersion: REUSE_SCHEMA_VERSION, kind: 'reuse-context', runId: start.runId, searchId,
  head: start.head, mergeBase: start.mergeBase, baseHead: start.baseHead ?? null,
  ...(start.worktree && start.worktree !== 'clean' ? { dirtyWorktree: true } : {}),
  planSha256, limits,
}

/** 결과를 쓰고 끝을 남긴다. 계획이 틀렸거나 git이 실패해도 끝은 남긴다 — 오케스트레이터가 대신 채우지 않는다. */
const finish = (doc, exitCode) => {
  const text = `${JSON.stringify(doc, null, 2)}\n`
  let written = null
  try {
    written = writeOutFile(outPath, text)
  } catch (error) {
    process.stderr.write(`검색 결과를 쓰지 못했다: ${outPath} — ${error.message}\n`)
  }
  const durationSec = Math.round((Date.now() - startedAt) / 100) / 10
  try {
    recordPhase(dir, run, 'reuse.done', {
      searchId, status: written ? doc.status : 'failed', ...(doc.reason || !written ? { reason: written ? doc.reason : 'write-failed' } : {}),
      targets: summarizeTargets(doc.targets), ...(written ? { out: written.out, outSha256: written.sha256 } : {}),
      ...(planSha256 ? { planSha256 } : {}), durationSec,
    })
  } catch (error) {
    process.stderr.write(`reuse.done을 남기지 못했다 — ${String(error.stderr || error.message).trim()}\n`)
  }
  process.stdout.write(`${JSON.stringify({ out: written?.out ?? null, sha256: written?.sha256 ?? null, status: written ? doc.status : 'failed', targets: summarizeTargets(doc.targets) })}\n`)
  process.exit(written ? exitCode : 2)
}

const fail = (reason, problems) => {
  process.stderr.write(`기존 구현 검색을 하지 않았다(${reason}):\n${problems.map(problem => `  - ${problem}`).join('\n')}\n`)
  finish({ ...base, status: 'failed', reason, problems, targets: [] }, 2)
}

const checked = checkPlan()
if (checked.problems) fail(checked.reason, checked.problems)
const { plan, repoGit } = checked

const deadline = startedAt + limits.timeLimitSec * 1000
const budget = { remaining: limits.candidatesTotal }
const targets = plan.targets.map(target => searchTarget(target, { git: repoGit, head: start.head, mergeBase: start.mergeBase, baseHead: start.baseHead ?? null, limits, deadline, budget }))
const status = overallStatus(targets, { planOk: true })
const decisions = plan.fileDecisions.map(({ path, decision, reason, targetIds }) => ({ path, decision, ...(reason ? { reason } : {}), ...(targetIds ? { targetIds } : {}) }))
finish({ ...base, status, ...(status === 'partial' ? { reason: 'limits-or-errors' } : {}), scopeSha256: planned.scopeSha256, fileDecisions: decisions, targets }, 0)
