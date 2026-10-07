#!/usr/bin/env node
// 작업 대장 — 무엇을 띄울지 정하고, 띄운 작업의 결과를 받는다(C-12).
//
// 왜 있는가: 띄울 작업과 돌고 있는 작업은 오케스트레이터 모델의 기억에만 있었다. 기억은 컨텍스트
// 압축과 세션 재시작에 지워지고, 지워진 뒤의 모델은 남은 일을 추측한다. 2026-09-30의 한 실행은
// 끝나지 않는 검증자 하나 때문에 37시간을 멈췄고, 남은 일이 무엇인지는 압축 요약에만 있었다.
//
// 이 스크립트는 작업을 띄우지 않는다 — 띄우는 것은 여전히 호스트와 모델이다. 대신 두 자리를 갖는다.
//   next  띄워도 되는 시도를 정하고, 띄우기 **전에** 그 시도를 기록에 남긴다. 그래서 같은 시도를
//         두 번 내주지 않는다 — 사용자 메시지에 깨어나도, 알림이 두 번 와도, 프로세스가 다시 떠도.
//         시간·호출 한도를 여기서 지킨다.
//   done  호스트가 돌려준 결과를 받는다. 지금 돌고 있는 그 시도의 결과만 정해진 자리에 쓰고, 늦게
//         온 앞 시도의 응답은 받지 않는다. 받은 내용의 해시를 기록에 남겨 나중에 바뀌면 드러나게 한다.
//
// 상태는 실행 타임라인(C-9)을 접어서 계산한다(`lib/task-ledger.mjs`). 따로 저장하는 상태 파일이 없다.
//
// Usage:
//   review-tasks.mjs next   --dir D --run R --stage module|verify [--rules RULES_DIR] [--targets routed.json] [--inflight 4]
//   review-tasks.mjs bind   --dir D --run R --task T --attempt N --host-task ID
//   review-tasks.mjs done   --dir D --run R (--host-task ID | --task T --attempt N) --status ok|failed [--failure-class C] [--result 파일] [--note 사유]
//   review-tasks.mjs cancel --dir D --run R (--task T | --all) --reason user
//   review-tasks.mjs status --dir D --run R [--rules RULES_DIR] [--targets routed.json] [--json]
//   review-tasks.mjs resume --dir D --run R [--repo .] [--max-tasks N] [--max-duration 30m] [--stale-after 20m]
//
// 종료 코드: 0 처리함 · 1 받은 결과가 계약에 맞지 않아 실패로 기록함(교정 차례) · 2 사용법·읽기 실패 ·
// 3 받지 않음(늦은 응답, 이 실행의 작업이 아님, 대상이 바뀜).

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { writeTextAtomic } from './lib/atomic-write.mjs'
import { durationLimitScope, hostCapabilities } from './lib/hosts.mjs'
import { moduleScope, plannedModules } from './lib/review-snapshot.mjs'
import { readEvents, recordPhase, requireStartedTimeline } from './lib/run-record.mjs'
import { currentTarget } from './lib/run-identity.mjs'
import {
  CANCEL_REASONS, DEFAULT_INFLIGHT, MAX_ATTEMPTS, STAGES, attemptsOf, budgetOf, claimOf, decideNext, decisionRecords,
  foldAttempts, haltOf, isTerminal, parseDuration, planStates, segmentOf, settleDecision, settleRecord, verifyPlan,
  endState, verifyRoundOf, verifyRoundStart,
} from './lib/task-ledger.mjs'
import { checkTaskVerdict, loadVerdictValidator } from './lib/verdicts.mjs'
import { buildRetryPrompt } from './lib/verifier-tasks.mjs'

class LedgerError extends Error {
  constructor(message, code = 2) {
    super(message)
    this.code = code
  }
}

const COMMANDS = new Set(['next', 'bind', 'done', 'cancel', 'status', 'resume'])
const VALUE_FLAGS = new Set([
  'dir', 'run', 'rules', 'targets', 'stage', 'inflight', 'task', 'attempt', 'host-task', 'status',
  'failure-class', 'result', 'note', 'reason', 'repo', 'max-tasks', 'max-duration', 'stale-after',
])
const BOOL_FLAGS = new Set(['all', 'json'])

const fail = (message, code = 2) => {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

const command = process.argv[2]
if (!COMMANDS.has(command)) fail(`usage: review-tasks.mjs <${[...COMMANDS].join('|')}> --dir <리포트 디렉터리> --run <리포트 basename> …`)

// 소비되지 않는 인자와 두 번 온 플래그를 거부한다 — 값에 공백이 있어 셸이 쪼갠 것을 조용히 버리면
// 잘린 값으로 결정한다(review-timeline.mjs와 같은 이유).
const values = new Map()
const switches = new Set()
{
  const argv = process.argv.slice(3)
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at]
    if (!arg.startsWith('--')) fail(`unexpected argument ${JSON.stringify(arg)} — 값에 공백이 있으면 따옴표로 감싸라`)
    const name = arg.slice(2)
    if (BOOL_FLAGS.has(name)) {
      switches.add(name)
      continue
    }
    if (!VALUE_FLAGS.has(name)) fail(`unknown flag ${arg}`)
    if (values.has(name)) fail(`--${name}이 두 번 왔다`)
    const value = argv[at + 1]
    if (value === undefined || value.startsWith('--')) fail(`${arg} needs a value`)
    values.set(name, value)
    at += 1
  }
}
const flag = name => values.get(name)

const dir = flag('dir')
const run = flag('run')
const sidecar = requireStartedTimeline(dir, run)
const timing = join(dir, '.timing')

const sha256 = text => createHash('sha256').update(text).digest('hex')
const startOf = events => events.find(event => event?.phase === 'run.start')

// ------------------------------------------------------------------ 잠금
//
// 결정과 기록 사이에 다른 호출이 끼면 둘 다 같은 시도를 띄워도 된다고 본다. 그래서 읽기 → 결정 →
// 기록을 잠금 안에서 한다. 잠금은 파일 하나를 배타적으로 만드는 것이고, 주인이 죽어 남은 잠금은
// 60초가 지나면 걷는다.
const LOCK = join(timing, `${run}.tasks.lock`)
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const withLock = fn => {
  mkdirSync(timing, { recursive: true })
  const giveUp = Date.now() + 15_000
  for (;;) {
    try {
      writeFileSync(LOCK, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' })
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > 60_000) {
          unlinkSync(LOCK)
          continue
        }
      } catch {
        continue
      }
      if (Date.now() > giveUp) throw new LedgerError(`작업 대장 잠금을 얻지 못했다: ${LOCK} — 다른 호출이 아직 쓰고 있다. 잠시 뒤 다시 부른다`)
      sleep(50)
    }
  }
  try {
    return fn()
  } finally {
    try {
      unlinkSync(LOCK)
    } catch {
      // 잠금을 못 지운 것은 결과를 바꾸지 않는다. 60초 뒤 다음 호출이 걷는다.
    }
  }
}

// ------------------------------------------------------------------ 계획

const rulesDirOf = start => flag('rules') ?? start.rules

/** 모듈 단계의 계획 — 이 실행의 적용 대상 모듈. 스냅숏과 같은 함수로 정한다. */
const modulePlan = (events, start) => {
  if (!events.some(event => event?.phase === 'modules.planned')) {
    throw new LedgerError('modules.planned가 없다 — 적용 대상과 SKIPPED를 정한 기록을 먼저 남긴다(SKILL 3a(4)). 그 기록 없이는 무엇을 띄워야 하는지 정할 수 없다')
  }
  const rulesDir = rulesDirOf(start)
  let catalog
  try {
    catalog = JSON.parse(readFileSync(join(rulesDir, 'catalog.json'), 'utf8'))
  } catch (error) {
    throw new LedgerError(`catalog.json을 읽지 못했다(--rules ${rulesDir}): ${error.message}`)
  }
  const modules = plannedModules(catalog, start.workflow)
  const { scope } = moduleScope({ modules, events, start })
  return scope.filter(entry => entry.scope === 'applied').map(({ module }) => ({ task: module.name, kind: module.kind }))
}

const routedPath = () => flag('targets') ?? join(timing, `${run}.routed.json`)

const readRouted = ({ required }) => {
  const path = routedPath()
  if (!existsSync(path)) {
    if (required) throw new LedgerError(`검증 작업 목록이 없다: ${path} — prepare-verification.mjs --collect의 출력을 그 자리에 두거나 --targets로 준다`)
    return null
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new LedgerError(`${path}를 JSON으로 읽지 못했다: ${error.message}`)
  }
}

const validatorFor = start => {
  try {
    return loadVerdictValidator(rulesDirOf(start))
  } catch (error) {
    throw new LedgerError(error.message)
  }
}

/** routed 출력에서 검증 작업 하나를 찾는다 — 승격 작업까지. */
const verifyEntryOf = (routed, task) => {
  const direct = (routed?.verifierTasks ?? []).find(entry => entry.taskId === task)
  if (direct) return { task, kind: direct.route, prompt: direct.prompt, verdict: direct.verdict, candidateIds: direct.candidateIds }
  for (const [candidateId, promotion] of Object.entries(routed?.promotions ?? {})) {
    if (promotion.taskId === task) return { task, kind: 'promotion', prompt: promotion.prompt, verdict: promotion.verdict, candidateIds: [candidateId] }
  }
  return null
}

/**
 * 검증 단계의 계획. bundle이 받은 판정에서 `needs-context` 후보를 읽어 승격 작업을 더한다.
 *
 * 이 실행에서 교차검증을 시작하지 않았으면(`crossverify.start`가 없으면) 띄울 검증 작업이 없다.
 */
const verifyPlanOf = (events, start, { required }) => {
  const routed = readRouted({ required })
  if (!routed || verifyRoundStart(events) === -1) return { plan: [], routed }
  const validate = validatorFor(start)
  const fold = foldAttempts(events)
  const needs = new Map()
  for (const task of routed.verifierTasks ?? []) {
    if (task.route !== 'bundle' || !existsSync(task.verdict)) continue
    const { payload } = checkTaskVerdict(readFileSync(task.verdict, 'utf8'), task.candidateIds, validate)
    if (payload) needs.set(task.taskId, payload.verdicts.filter(verdict => verdict.disposition === 'needs-context').map(verdict => verdict.candidateId))
  }
  const plan = verifyPlan(routed, needs).map(entry => (
    !attemptsOf(fold, 'verify', entry.task).length && existsSync(entry.verdict) ? { ...entry, preexisting: true } : entry
  ))
  return { plan, routed }
}

// ------------------------------------------------------------------ 기록

// 검증 작업의 응답 자리는 라운드마다 다르다 — 검증을 다시 준비해 같은 작업이 다시 시도 1로 떠도, 앞 라운드의
// 늦은 응답이 새 시도의 자리에 쓰이지 않는다(PR #93 리뷰). 모듈 작업은 라운드가 없다.
const attemptPath = (task, attempt, round = null) => join(timing, `${run}.attempts`, ...(round ? [round] : []), `${task}.a${attempt}.json`)
const canonicalPath = (stage, entry) => (stage === 'module' ? join(timing, `${run}.${entry.task}.json`) : entry.verdict)
const retryPromptOf = prompt => prompt.replace(/\.md$/, '.retry.md')

const record = (phase, data) => {
  try {
    recordPhase(dir, run, phase, data)
  } catch (error) {
    throw new LedgerError(`${phase}를 기록하지 못했다 — 아무것도 내주지 않는다: ${String(error.stderr || error.message).trim()}`)
  }
}

/** 시도 하나를 끝낸다. 모듈은 `module.done`, 검증은 `verify.done`이다. */
const settle = (stage, task, attempt, fields) => {
  const { phase, data } = settleRecord(stage, task, attempt, fields)
  record(phase, data)
}

// ------------------------------------------------------------------ 출력

const minutes = sec => (sec === null || sec === undefined ? '?' : sec < 120 ? `${sec}초` : `${Math.round(sec / 60)}분`)

const budgetText = budget => {
  const parts = []
  parts.push(budget.maxTasks === null ? `호출 ${budget.used}개(한도 없음)` : `호출 ${budget.used}/${budget.maxTasks}`)
  if (budget.maxDurationSec !== null) parts.push(`시간 ${minutes(budget.maxDurationSec)} 중 남은 ${minutes(budget.remainingSec)}${budget.expired ? ' — 지났다' : ''}`)
  return parts.join(' · ')
}

const STATE_TEXT = { succeeded: '완료', running: '실행 중', queued: '대기', failed: '실패', unavailable: '결과 못 받음', cancelled: '취소' }

const stageSummary = (stage, states, halted) => {
  const count = state => states.filter(entry => entry.state === state).length
  const notRun = halted ? states.filter(entry => entry.state === 'queued') : []
  return {
    stage,
    tasks: states.length,
    counts: Object.fromEntries(Object.keys(STATE_TEXT).map(state => [state, count(state)])),
    running: states.filter(entry => entry.state === 'running').map(entry => ({
      task: entry.task, attempt: entry.attempt, startedAt: entry.startedAt, quietSec: entry.quietSec, stale: entry.stale,
      ...(entry.hostTaskId ? { hostTaskId: entry.hostTaskId } : {}),
    })),
    queued: states.filter(entry => entry.state === 'queued').map(entry => entry.task),
    notRun: notRun.map(entry => entry.task),
    ended: states.filter(entry => ['failed', 'unavailable', 'cancelled'].includes(entry.state)).map(entry => ({
      task: entry.task, state: entry.state, attempt: entry.attempt,
      ...(entry.failureClass !== undefined ? { failureClass: entry.failureClass } : {}),
      ...(entry.cancelReason !== undefined ? { cancelReason: entry.cancelReason } : {}),
    })),
    complete: states.every(entry => isTerminal(entry.state)) || (Boolean(halted) && !states.some(entry => entry.state === 'running')),
  }
}

const print = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)

// ------------------------------------------------------------------ next

const inferStage = (fold, task) => {
  const explicit = flag('stage')
  if (explicit !== undefined) {
    if (!STAGES.includes(explicit)) throw new LedgerError(`--stage는 ${STAGES.join(' 또는 ')}다`)
    return explicit
  }
  const found = STAGES.filter(stage => attemptsOf(fold, stage, task).length)
  if (found.length === 1) return found[0]
  if (!found.length) throw new LedgerError(`${task}는 이 실행에서 띄운 적이 없다 — next가 내준 이름과 시도 번호를 쓴다`, 3)
  throw new LedgerError(`${task}가 두 단계에 다 있다 — --stage로 정한다`)
}

const intFlag = (name, fallback) => {
  const raw = flag(name)
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new LedgerError(`--${name}는 양의 정수다 (받은 값: ${JSON.stringify(raw)})`)
  return Number(raw)
}

const next = () => {
  const stage = flag('stage')
  if (!STAGES.includes(stage)) throw new LedgerError(`next에는 --stage ${STAGES.join('|')}가 필요하다`)
  const inflight = intFlag('inflight', DEFAULT_INFLIGHT)
  return withLock(() => {
    const events = readEvents(sidecar)
    const start = startOf(events)
    const end = endState(events)
    if (end.ended) {
      throw new LedgerError(end.resumable
        ? '부분 보고로 닫은 실행이다(run.end) — 이어 가려면 review-tasks.mjs resume으로 새 구간을 먼저 연다'
        : '이미 끝난 실행이다(run.end가 있다) — 새 작업을 띄우지 않는다')
    }
    const { plan } = stage === 'module' ? { plan: modulePlan(events, start) } : verifyPlanOf(events, start, { required: true })
    const fold = foldAttempts(events)
    const now = Date.now()
    const decision = decideNext({ stage, plan, fold, events, now, inflight })
    const host = hostCapabilities(start.host)
    const byTask = new Map(plan.map(entry => [entry.task, entry]))
    const runId = start.runId ?? run

    // 죽은 시도·취소·멈춤·디스패치의 시작과 끝·시도마다의 시작을 결정한 순서대로 남긴다. 디스패치의
    // 시작과 끝을 오케스트레이터가 남기던 때 끝이 빠진 실행이 있었고, 그 수치는 리포트에 손으로
    // 옮겨졌다(C-9).
    const round = stage === 'verify' ? verifyRoundOf(events) : null
    if (decision.dispatch.length) mkdirSync(join(timing, `${run}.attempts`, ...(round ? [round] : [])), { recursive: true })
    for (const { phase, data } of decisionRecords({ stage, decision, plan, fold, events, runId, inflight })) record(phase, data)

    const claims = decision.dispatch.map(one => {
      const entry = byTask.get(one.task)
      const correction = one.retryOf?.failureClass === 'malformed-output'
      return {
        task: one.task,
        attempt: one.attempt,
        kind: entry.kind,
        label: `${one.task}#${one.attempt}`,
        claim: claimOf(runId, stage, one.task, one.attempt, round),
        resultPath: attemptPath(one.task, one.attempt, round),
        ...(stage === 'verify' ? { prompt: correction && existsSync(retryPromptOf(entry.prompt)) ? retryPromptOf(entry.prompt) : entry.prompt } : {}),
        ...(one.retryOf ? { retryOf: one.retryOf } : {}),
        ...(correction ? { correction: true } : {}),
      }
    })

    const advice = []
    if (claims.length && !host.perTaskNotification) {
      advice.push('이 호스트는 작업 하나가 끝나도 깨우지 않는다 — dispatch를 전부 한 번에 foreground 병렬로 부른다')
    }
    if (decision.cancel.length) {
      advice.push(host.cancel
        ? '시간 상한이 지났다 — cancelled의 작업을 호스트에서 멈춘다. 그 결과는 받지 않는다'
        : '시간 상한이 지났다 — 이 호스트는 작업을 멈추지 못한다. 그 결과는 받지 않는다')
    }
    if (decision.expire.length) advice.push('expired의 시도는 응답이 없어 끝냈다 — 그 결과가 나중에 와도 done이 받지 않는다')
    return {
      code: 0,
      out: {
        stage,
        runId: start.runId ?? null,
        dispatch: claims,
        expired: decision.expire,
        cancelled: decision.cancel,
        running: decision.running.map(entry => ({ task: entry.task, attempt: entry.attempt, startedAt: entry.startedAt, quietSec: entry.quietSec, ...(entry.hostTaskId ? { hostTaskId: entry.hostTaskId } : {}) })),
        waiting: decision.waiting.map(entry => entry.task),
        halted: decision.halt ?? decision.halted?.reason ?? null,
        complete: decision.complete,
        budget: decision.budget,
        host: { name: host.name, perTaskNotification: host.perTaskNotification, cancel: host.cancel },
        ...(advice.length ? { advice } : {}),
      },
    }
  })
}

// ------------------------------------------------------------------ bind

const bind = () => {
  const task = flag('task')
  const hostTask = flag('host-task')
  if (task === undefined || hostTask === undefined) throw new LedgerError('bind에는 --task, --attempt, --host-task가 필요하다')
  const attempt = intFlag('attempt')
  if (attempt === undefined) throw new LedgerError('bind에는 --attempt가 필요하다')
  return withLock(() => {
    const events = readEvents(sidecar)
    const fold = foldAttempts(events)
    const stage = inferStage(fold, task)
    const attempts = attemptsOf(fold, stage, task)
    const target = attempts.find(one => one.attempt === attempt)
    if (!target) throw new LedgerError(`${task}의 시도 ${attempt}는 띄운 적이 없다`, 3)
    if (target.settled) throw new LedgerError(`${task}의 시도 ${attempt}는 이미 끝났다 — 묶지 않는다`, 3)
    if (attempts.at(-1) !== target) throw new LedgerError(`${task}의 시도 ${attempts.at(-1).attempt}가 이미 떴다 — 시도 ${attempt}에 묶지 않는다`, 3)
    const owner = fold.hosts.get(hostTask)
    if (owner && owner !== target) throw new LedgerError(`호스트 작업 ${hostTask}는 이미 ${owner.task}의 시도 ${owner.attempt}에 묶였다`, 3)
    record('task.bind', { stage, task, attempt, taskId: hostTask })
    return { code: 0, out: { bound: { stage, task, attempt, hostTaskId: hostTask }, refreshed: Boolean(owner) } }
  })
}

// ------------------------------------------------------------------ done

const FAILURE_CLASSES = new Set([
  'no-start', 'task-not-found', 'inactivity-timeout', 'queue-expiry', 'empty-result',
  'skill-injection-invalid', 'malformed-output', 'provider-model-not-found', 'poll-timeout', 'unknown',
])

const done = () => {
  const status = flag('status')
  if (!['ok', 'failed'].includes(status)) throw new LedgerError('done에는 --status ok|failed가 필요하다')
  const failureClass = flag('failure-class')
  if (status === 'failed' && !FAILURE_CLASSES.has(failureClass)) {
    throw new LedgerError(`--status failed에는 --failure-class가 필요하다: ${[...FAILURE_CLASSES].join(', ')}`)
  }
  if (status === 'ok' && failureClass !== undefined) throw new LedgerError('--failure-class는 --status failed에만 준다')
  const hostTask = flag('host-task')
  const givenTask = flag('task')
  const givenAttempt = intFlag('attempt')
  if (hostTask === undefined && (givenTask === undefined || givenAttempt === undefined)) {
    throw new LedgerError('done에는 --host-task 또는 --task와 --attempt가 필요하다')
  }

  return withLock(() => {
    const events = readEvents(sidecar)
    const start = startOf(events)
    const fold = foldAttempts(events)
    const owner = hostTask === undefined ? null : fold.hosts.get(hostTask)
    // 이 실행에 묶이지 않은 호스트 작업이다. 다른 실행이나 앞 라운드가 띄운 작업의 늦은 응답일 수
    // 있으므로, 결과 파일을 찾기 전에 거절한다.
    if (hostTask !== undefined && !owner) {
      return { code: 3, out: { outcome: 'unknown', reason: `호스트 작업 ${hostTask}는 이 실행의 대장에 묶이지 않았다`, note: '받지 않았다 — 정해진 결과 자리에 쓰지 않았고 기록도 남기지 않았다' } }
    }
    const task = givenTask ?? owner?.task
    const stage = owner?.stage ?? (task === undefined ? undefined : inferStage(fold, task))
    const attempt = givenAttempt ?? owner?.attempt

    let text
    if (status === 'ok') {
      const round = stage === 'verify' ? verifyRoundOf(events) : null
      const path = flag('result') ?? (task !== undefined && attempt !== undefined ? attemptPath(task, attempt, round) : undefined)
      if (path === undefined || !existsSync(path)) {
        throw new LedgerError(`받은 결과 파일이 없다: ${path ?? '(경로를 정할 수 없다)'} — 호스트가 돌려준 응답을 next가 준 resultPath에 그대로 쓰거나 --result로 준다`)
      }
      // BOM은 내용이 아니라 인코딩이다. 남겨 두면 JSON으로 읽히지 않는다(PowerShell 5.1은 BOM을 붙인다).
      text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
    }
    const decision = settleDecision({
      fold, stage, task, attempt, hostTaskId: hostTask, status, resultSha256: text === undefined ? undefined : sha256(text),
    })
    if (decision.verdict === 'duplicate') {
      return { code: 0, out: { outcome: 'duplicate', task: decision.record.task, attempt: decision.record.attempt, note: '이미 받은 끝이다 — 다시 기록하지 않았다' } }
    }
    if (decision.verdict !== 'accept') {
      return { code: 3, out: { outcome: decision.verdict, ...(decision.record ? { task: decision.record.task, attempt: decision.record.attempt } : {}), reason: decision.reason, note: '받지 않았다 — 정해진 결과 자리에 쓰지 않았고 기록도 남기지 않았다' } }
    }
    const target = decision.record
    const hostTaskId = hostTask ?? target.hostTaskId ?? undefined
    const note = flag('note')

    if (status === 'failed') {
      settle(target.stage, target.task, target.attempt, { status: 'failed', failureClass, taskId: hostTaskId, note })
      return { code: 0, out: { outcome: 'recorded', task: target.task, attempt: target.attempt, status, failureClass } }
    }

    const sha = sha256(text)
    // 이 시도까지 쓴 횟수. 취소된 시도는 세지 않는다(C-12) — 교정 차례가 남았는지가 여기서 갈린다.
    const spent = attemptsOf(fold, target.stage, target.task).filter(one => one.settled?.failureClass !== 'cancelled').length
    const retryLeft = spent < MAX_ATTEMPTS
    let entry = { task: target.task }
    let problems = null
    let retryPrompt
    if (target.stage === 'module') {
      try {
        JSON.parse(text)
      } catch (error) {
        problems = [`JSON으로 읽지 못했다: ${error.message} — 코드펜스나 서문 없이 JSON 객체 하나만 돌려준다`]
      }
    } else {
      const routed = readRouted({ required: true })
      entry = verifyEntryOf(routed, target.task)
      if (!entry) throw new LedgerError(`${target.task}는 routed 출력의 검증 작업이 아니다: ${routedPath()}`)
      const checked = checkTaskVerdict(text, entry.candidateIds, validatorFor(start))
      problems = checked.problems ?? null
      if (problems && retryLeft && existsSync(entry.prompt)) {
        // 교정 프롬프트는 원래 지시에 오류 목록과 직전 응답을 붙인 것이다. tally-verdicts.mjs
        // --validate와 같은 함수로 만든다 — 교정을 오케스트레이터가 쓰면 판정을 그가 쓴 것이 된다.
        retryPrompt = retryPromptOf(entry.prompt)
        writeFileSync(retryPrompt, buildRetryPrompt(readFileSync(entry.prompt, 'utf8'), problems, text), 'utf8')
      }
    }
    if (problems) {
      settle(target.stage, target.task, target.attempt, {
        status: 'failed', failureClass: 'malformed-output', taskId: hostTaskId, resultSha256: sha,
        note: note ?? `받은 결과가 계약에 맞지 않는다: ${problems[0].slice(0, 200)}`,
      })
      return {
        code: 1,
        out: {
          outcome: 'rejected', task: target.task, attempt: target.attempt, problems,
          ...(retryPrompt ? { retryPrompt } : {}),
          note: retryLeft
            ? '실패(malformed-output)로 기록했다. next가 교정 시도를 내준다'
            : '실패(malformed-output)로 기록했다. 시도를 다 썼다 — 이 작업은 끝났다',
        },
      }
    }
    const destination = canonicalPath(target.stage, entry)
    mkdirSync(dirname(destination), { recursive: true })
    writeTextAtomic(destination, text)
    let findings
    if (target.stage === 'module') {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed?.findings)) findings = parsed.findings.length
    }
    settle(target.stage, target.task, target.attempt, { status: 'ok', taskId: hostTaskId, resultSha256: sha, findings, note })
    return { code: 0, out: { outcome: 'accepted', task: target.task, attempt: target.attempt, wrote: destination } }
  })
}

// ------------------------------------------------------------------ cancel

const cancel = () => {
  const reason = flag('reason')
  if (reason !== 'user') throw new LedgerError(`cancel의 --reason은 user다 — ${CANCEL_REASONS.filter(one => one !== 'user').join(', ')}는 next가 정한다`)
  const task = flag('task')
  const all = switches.has('all')
  if (Boolean(task) === all) throw new LedgerError('cancel에는 --task <이름> 또는 --all 중 하나를 준다')
  return withLock(() => {
    const events = readEvents(sidecar)
    const fold = foldAttempts(events)
    const cancelled = []
    for (const [key, attempts] of fold.tasks) {
      const [stage, name] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
      if (!all && name !== task) continue
      const last = [...attempts.values()].sort((left, right) => left.attempt - right.attempt).at(-1)
      if (!last || last.settled) continue
      settle(stage, name, last.attempt, { status: 'failed', failureClass: 'cancelled', cancelReason: 'user', taskId: last.hostTaskId ?? undefined })
      cancelled.push({ stage, task: name, attempt: last.attempt, ...(last.hostTaskId ? { hostTaskId: last.hostTaskId } : {}) })
    }
    if (all && !haltOf(events)) record('dispatch.halt', { reason: 'user', running: 0 })
    if (!all && !cancelled.length) throw new LedgerError(`${task}에는 돌고 있는 시도가 없다`, 3)
    const host = hostCapabilities(startOf(events).host)
    return {
      code: 0,
      out: {
        cancelled,
        halted: all,
        note: host.cancel ? '호스트에서 이 작업들을 멈춘다. 그 결과는 받지 않는다' : '이 호스트는 작업을 멈추지 못한다 — 그 결과를 받지 않을 뿐이다',
      },
    }
  })
}

// ------------------------------------------------------------------ status

const statusOf = events => {
  const start = startOf(events)
  const now = Date.now()
  const budget = budgetOf(events, now)
  const halt = haltOf(events)
  const host = hostCapabilities(start.host)
  const fold = foldAttempts(events)
  const clock = { now, staleAfterSec: budget.staleAfterSec, segmentStartedAt: segmentOf(events).startedAt }
  const stages = {}
  if (events.some(event => event?.phase === 'modules.planned')) {
    const plan = modulePlan(events, start)
    stages.module = stageSummary('module', planStates({ stage: 'module', plan, fold, ...clock }), halt)
  }
  const { plan: verify } = verifyPlanOf(events, start, { required: false })
  if (verify.length) stages.verify = stageSummary('verify', planStates({ stage: 'verify', plan: verify, fold, ...clock }), halt)
  return {
    run,
    runId: start.runId ?? null,
    ...(({ ended, resumable }) => ({ ended, resumable }))(endState(events)),
    budget,
    halted: halt ? { reason: halt.reason, at: halt.at } : null,
    host: { ...host, durationScope: durationLimitScope(host) },
    stages,
  }
}

const statusText = status => {
  const lines = [`작업 대장 — ${status.run}${status.runId ? ` (실행 ID ${status.runId})` : ''}${status.ended ? (status.resumable ? ' · 부분 보고로 닫은 실행(이어 갈 수 있다)' : ' · 끝난 실행') : ''}`]
  lines.push(`한도      ${budgetText(status.budget)} · 응답 없이 ${minutes(status.budget.staleAfterSec)}이 지나면 죽은 시도로 본다`)
  lines.push(`호스트    ${status.host.name}${status.host.known ? '' : ' (알려지지 않은 호스트)'} — ${status.host.durationScope}`)
  if (status.halted) lines.push(`멈춤      ${status.halted.reason} (${status.halted.at}) — 띄우지 못한 작업은 미검토 범위로 남는다`)
  for (const stage of STAGES) {
    const summary = status.stages[stage]
    const label = stage === 'module' ? '모듈' : '검증'
    if (!summary) {
      lines.push(`${label}      ${stage === 'module' ? 'modules.planned가 아직 없다' : '교차검증을 시작하지 않았다'}`)
      continue
    }
    lines.push(`${label}      ${summary.tasks}개 — ${Object.entries(STATE_TEXT).map(([state, text]) => `${text} ${summary.counts[state]}`).join(' · ')}`)
    for (const one of summary.running) {
      lines.push(`          실행 중 ${one.task}#${one.attempt}${one.hostTaskId ? ` (호스트 ${one.hostTaskId})` : ''} — ${minutes(one.quietSec)}째 소식 없음${one.stale ? ' · 죽은 것으로 볼 시간이 지났다(다음 next가 끝낸다)' : ''}`)
    }
    if (summary.notRun.length) lines.push(`          멈춰서 띄우지 못함: ${summary.notRun.join(', ')}`)
    for (const one of summary.ended) {
      lines.push(`          ${STATE_TEXT[one.state]} ${one.task} (시도 ${one.attempt}${one.failureClass ? ` · ${one.failureClass}` : ''}${one.cancelReason ? ` · ${one.cancelReason}` : ''})`)
    }
  }
  const pending = STAGES.find(stage => status.stages[stage] && !status.stages[stage].complete)
  lines.push(status.ended
    ? (status.resumable ? '다음      더 돌리려면 review-tasks.mjs resume — 멈춰서 띄우지 못한 작업이 이어서 뜬다' : '다음      없음 — 끝난 실행이다')
    : pending
      ? `다음      review-tasks.mjs next --stage ${pending}`
      : '다음      띄울 작업이 없다 — 다음 단계(수집·집계·렌더)로 간다')
  return lines.join('\n')
}

const status = () => {
  const events = readEvents(sidecar)
  const value = statusOf(events)
  if (switches.has('json')) return { code: 0, out: value }
  return { code: 0, text: statusText(value) }
}

// ------------------------------------------------------------------ resume

/**
 * 이어 가기 전에 대상이 그대로인지 본다.
 *
 * HEAD나 작업 트리가 바뀌었으면 이 실행을 이어 가지 않는다. 앞에서 받은 결과는 바뀌기 전의 코드에
 * 대한 것이고, 이어서 받는 결과는 바뀐 코드에 대한 것이라 한 리포트에 섞으면 어느 시점의 리뷰인지
 * 말할 수 없다. 새 실행으로 시작하고, preflight의 `--continues`로 앞 실행을 가리킨다.
 *
 * 한도에 닿아 멈춘 실행이거나 새 한도를 줬을 때만 새 구간(`run.resume`)을 연다. 압축 뒤에 다시
 * 들어온 것만으로 구간을 열면 한도가 매번 처음부터 다시 잰다.
 */
const resume = () => {
  const repo = flag('repo') ?? process.cwd()
  return withLock(() => {
    const events = readEvents(sidecar)
    const start = startOf(events)
    const end = endState(events)
    if (end.ended && !end.resumable) throw new LedgerError('정상으로 끝난 실행이다 — 이어 가지 않는다. 새로 리뷰하려면 새 --run으로 preflight부터 시작한다')
    // 대상 기록이 없으면 그대로인지 확인할 수 없다. 확인하지 못한 것을 "그대로다"로 읽지 않는다.
    if (start.head === undefined || start.worktree === undefined) {
      throw new LedgerError('run.start에 HEAD·작업 트리 기록이 없다(2.16.0 이전 preflight) — 대상이 그대로인지 확인할 수 없어 이어 가지 않는다. 새 --run으로 preflight부터 시작한다', 3)
    }
    let current
    try {
      current = currentTarget(repo, { exclude: [resolve(dir)] })
    } catch (error) {
      throw new LedgerError(`리뷰 대상의 지금 상태를 읽지 못했다(--repo ${repo}): ${String(error.stderr || error.message).trim()}`)
    }
    const drift = ['head', 'worktree'].filter(field => current[field] !== start[field])
    if (drift.length) {
      return {
        code: 3,
        text: [
          `대상이 바뀌었다 — 이 실행(${start.runId ?? run})을 이어 가지 않는다.`,
          ...drift.map(field => `  ${field}: ${start[field]} → ${current[field]}`),
          '앞에서 받은 결과는 바뀌기 전의 코드에 대한 것이다. 새 --run 이름으로 preflight를 다시 돌리고',
          `\`--continues ${start.runId ?? run}\`를 준다.`,
        ].join('\n'),
      }
    }
    const segment = segmentOf(events)
    const halted = haltOf(events)
    // 아직 멈춘 기록은 없어도 한도를 이미 다 썼으면 이어 갈 구간이 없다 — 다음 next가 바로 멈춘다.
    const budget = budgetOf(events, Date.now())
    const spentOut = budget.expired || budget.exhausted
    const given = ['max-tasks', 'max-duration', 'stale-after'].filter(name => flag(name) !== undefined)
    let opened = false
    // 부분 보고로 닫은 실행은 언제나 새 구간을 연다 — run.end 뒤에 이어 쓰는 첫 줄이 run.resume이어야 한다.
    if (end.ended || halted || spentOut || given.length) {
      const read = (name, parse, fallback) => {
        const raw = flag(name)
        if (raw === undefined) return fallback
        const value = parse(raw)
        if (value === null) throw new LedgerError(`--${name}를 읽지 못했다: ${JSON.stringify(raw)}`)
        return value
      }
      const positiveInt = raw => (/^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null)
      const fields = {
        maxTasks: read('max-tasks', positiveInt, segment.maxTasks),
        maxDurationSec: read('max-duration', parseDuration, segment.maxDurationSec),
        staleAfterSec: read('stale-after', parseDuration, segment.staleAfterSec),
        head: current.head,
        worktree: current.worktree,
      }
      record('run.resume', Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null)))
      opened = true
    }
    const value = statusOf(readEvents(sidecar))
    return {
      code: 0,
      text: [
        opened
          ? `새 한도 구간을 열었다${halted ? ` — 앞 구간은 ${halted.reason}로 멈췄다` : spentOut ? ' — 앞 구간의 한도를 다 썼다' : ''}. 대상은 그대로다.`
          : '대상은 그대로다. 같은 구간을 이어 간다.',
        statusText(value),
      ].join('\n'),
    }
  })
}

// ------------------------------------------------------------------ main

const handlers = { next, bind, done, cancel, status, resume }
let result
try {
  result = handlers[command]()
} catch (error) {
  if (error instanceof LedgerError) fail(error.message, error.code)
  throw error
}
if (result.text !== undefined) process.stdout.write(`${result.text}\n`)
else print(result.out)
process.exit(result.code)
