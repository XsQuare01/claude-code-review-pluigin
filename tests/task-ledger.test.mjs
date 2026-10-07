import { test } from 'node:test'
import assert from 'node:assert/strict'

import { durationLimitScope, hostCapabilities } from '../scripts/lib/hosts.mjs'
import {
  MAX_ATTEMPTS, budgetOf, decideNext, decisionRecords, failureFamily, foldAttempts, haltOf, parseDuration,
  planStates, segmentOf, settleDecision, settleRecord, taskState, verifyPlan,
} from '../scripts/lib/task-ledger.mjs'

// 작업 대장(C-12)의 전이를 가짜 시계와 가짜 호스트로 본다(#88 PR 3).
//
// 가짜 호스트는 오케스트레이터와 호스트가 하는 일을 흉내 낸다 — 대장에 다음 할 일을 묻고, 받은 시도를
// "띄우고", 끝 알림을 대장에 넘긴다. 기록은 대장 CLI와 같은 함수(`decisionRecords`·`settleRecord`)로
// 남긴다. 시계는 테스트가 돌린다. 모델은 부르지 않는다 — 여기서 증명하는 것은 상태 전이이지 리뷰의
// 품질이 아니다.

const T0 = Date.parse('2026-10-07T00:00:00.000Z')
const iso = ms => new Date(ms).toISOString()
const MODULES = ['01-fsd', '02-type', '04-state', '05-effect', 'props', 'exception'].map(task => ({ task, kind: /^\d/.test(task) ? 'module' : 'pass' }))

class FakeRun {
  constructor({ limits = {}, plan = MODULES, host = 'claude-code' } = {}) {
    this.now = T0
    this.plan = plan
    this.events = []
    this.hostSeq = 0
    this.push('run.start', { host, runId: 'run-a', workflow: 'full', ...limits })
  }

  push(phase, data) {
    this.events.push({ at: iso(this.now), seq: this.events.length + 1, phase, ...data })
  }

  tick(sec) {
    this.now += sec * 1000
  }

  /** 대장에 다음 할 일을 묻고, 결정을 CLI와 같은 순서로 기록한 뒤 띄운 시도에 호스트 작업 ID를 묶는다. */
  next({ stage = 'module', inflight = 4, plan = this.plan } = {}) {
    const fold = foldAttempts(this.events)
    const decision = decideNext({ stage, plan, fold, events: this.events, now: this.now, inflight })
    for (const { phase, data } of decisionRecords({ stage, decision, plan, fold, events: this.events, runId: 'run-a', inflight })) this.push(phase, data)
    for (const one of decision.dispatch) {
      this.hostSeq += 1
      one.hostTaskId = `bg_${this.hostSeq}`
      this.push('task.bind', { stage, task: one.task, attempt: one.attempt, taskId: one.hostTaskId })
    }
    return decision
  }

  /** 호스트의 끝 알림 하나를 대장에 넘긴다. 받으면 기록하고, 판정을 돌려준다. */
  deliver({ hostTaskId, task, attempt, status = 'ok', failureClass, sha = `sha-${hostTaskId ?? task}`, stage = 'module' }) {
    const fold = foldAttempts(this.events)
    const decision = settleDecision({ fold, stage, task, attempt, hostTaskId, status, resultSha256: status === 'ok' ? sha : undefined })
    if (decision.verdict === 'accept') {
      const { phase, data } = settleRecord(decision.record.stage, decision.record.task, decision.record.attempt, {
        status, failureClass, taskId: decision.record.hostTaskId, resultSha256: status === 'ok' ? sha : undefined,
      })
      this.push(phase, data)
    }
    return decision.verdict
  }

  states(stage = 'module', plan = this.plan) {
    return Object.fromEntries(planStates({ stage, plan, fold: foldAttempts(this.events), now: this.now, staleAfterSec: segmentOf(this.events).staleAfterSec, segmentStartedAt: segmentOf(this.events).startedAt })
      .map(entry => [entry.task, entry.state]))
  }

  starts() {
    return this.events.filter(event => event.phase === 'module.start' || event.phase === 'verify.start')
  }
}

test('기간 표기를 초로 읽고, 0·음수·모르는 단위는 읽지 않는다', () => {
  assert.equal(parseDuration('90'), 90)
  assert.equal(parseDuration('90s'), 90)
  assert.equal(parseDuration('30m'), 1800)
  assert.equal(parseDuration('2h'), 7200)
  for (const bad of ['0', '0m', '-5', '1.5m', '30 m', '1d', '', undefined]) assert.equal(parseDuration(bad), null, String(bad))
})

test('실패 클래스는 결과가 왔는지로 failed와 unavailable로 갈리고, 취소는 따로다', () => {
  assert.equal(failureFamily('malformed-output'), 'failed')
  assert.equal(failureFamily(undefined), 'failed')
  for (const name of ['no-start', 'task-not-found', 'inactivity-timeout', 'queue-expiry', 'empty-result']) assert.equal(failureFamily(name), 'unavailable')
  assert.equal(failureFamily('cancelled'), 'cancelled')
})

test('상태는 queued → running → succeeded로 가고, 실패한 시도는 시도가 남으면 다시 queued다', () => {
  const run = new FakeRun()
  assert.equal(run.states()['01-fsd'], 'queued')
  const first = run.next()
  assert.deepEqual(first.dispatch.map(one => `${one.task}#${one.attempt}`), ['01-fsd#1', '02-type#1', '04-state#1', '05-effect#1'])
  assert.equal(run.states()['01-fsd'], 'running')
  assert.equal(run.states().props, 'queued')

  run.tick(60)
  assert.equal(run.deliver({ hostTaskId: first.dispatch[0].hostTaskId }), 'accept')
  assert.equal(run.states()['01-fsd'], 'succeeded')

  assert.equal(run.deliver({ hostTaskId: first.dispatch[1].hostTaskId, status: 'failed', failureClass: 'task-not-found' }), 'accept')
  assert.equal(run.states()['02-type'], 'queued')
  const retry = run.next()
  // 빈 슬롯은 둘이다(01-fsd 완료, 02-type 실패). 재시도는 계획 순서대로 그 자리에 들어간다.
  assert.deepEqual(retry.dispatch.map(one => `${one.task}#${one.attempt}`), ['02-type#2', 'props#1'])
  assert.deepEqual(retry.dispatch[0].retryOf, { attempt: 1, failureClass: 'task-not-found' })
})

test('돌고 있는 시도는 다시 내주지 않는다 — 사용자 메시지나 중복 알림에 깨어나 다시 물어도', () => {
  const run = new FakeRun()
  run.next()
  run.tick(5)
  const again = run.next()
  assert.deepEqual(again.dispatch, [])
  assert.equal(again.running.length, 4)
  assert.equal(run.starts().length, 4)
})

test('같은 끝 알림이 두 번 와도 한 번만 기록하고 한 번만 센다', () => {
  const run = new FakeRun()
  const { dispatch } = run.next()
  assert.equal(run.deliver({ hostTaskId: dispatch[0].hostTaskId }), 'accept')
  assert.equal(run.deliver({ hostTaskId: dispatch[0].hostTaskId }), 'duplicate')
  assert.equal(run.events.filter(event => event.phase === 'module.done').length, 1)
})

test('프로세스가 다시 떠도 기록을 다시 접으면 같은 결정이 나온다', () => {
  const run = new FakeRun()
  run.next()
  run.deliver({ task: '01-fsd', attempt: 1 })
  // 디스크의 JSONL을 다시 읽는 것과 같다 — 대장은 메모리에 아무것도 들고 있지 않다.
  const reloaded = JSON.parse(`[${run.events.map(event => JSON.stringify(event)).join(',')}]`)
  const before = decideNext({ stage: 'module', plan: MODULES, fold: foldAttempts(run.events), events: run.events, now: run.now })
  const after = decideNext({ stage: 'module', plan: MODULES, fold: foldAttempts(reloaded), events: reloaded, now: run.now })
  assert.deepEqual(after.dispatch, before.dispatch)
  assert.deepEqual(after.dispatch.map(one => one.task), ['props'])
})

test('재시도를 다 쓴 작업은 끝나고, 나머지는 계속 띄워 단계가 끝난다', () => {
  const run = new FakeRun({ plan: MODULES.slice(0, 2) })
  let { dispatch } = run.next()
  run.deliver({ hostTaskId: dispatch[0].hostTaskId, status: 'failed', failureClass: 'malformed-output' })
  run.deliver({ hostTaskId: dispatch[1].hostTaskId })
  ;({ dispatch } = run.next())
  assert.deepEqual(dispatch.map(one => `${one.task}#${one.attempt}`), ['01-fsd#2'])
  run.deliver({ hostTaskId: dispatch[0].hostTaskId, status: 'failed', failureClass: 'malformed-output' })
  const last = run.next()
  assert.deepEqual(last.dispatch, [])
  assert.equal(last.complete, true)
  assert.equal(run.states()['01-fsd'], 'failed')
  assert.equal(run.states()['02-type'], 'succeeded')
  assert.equal(MAX_ATTEMPTS, 2)
})

test('시도를 다 쓴 작업은 결과를 얻지 못한 이유로 끝 상태가 갈린다', () => {
  const ended = failureClass => taskState([
    { attempt: 1, startedAt: T0, lastSeenAt: T0, settled: { status: 'failed', failureClass } },
    { attempt: 2, startedAt: T0, lastSeenAt: T0, settled: { status: 'failed', failureClass } },
  ], { now: T0 }).state
  assert.equal(ended('malformed-output'), 'failed')
  assert.equal(ended('queue-expiry'), 'unavailable')
  assert.equal(taskState([{ attempt: 1, startedAt: T0, lastSeenAt: T0, settled: { status: 'failed', failureClass: 'cancelled' } }], { now: T0 }).state, 'cancelled')
})

test('호출 한도는 재시도까지 세고, 닿으면 멈춘 사실과 띄우지 못한 작업을 남긴다', () => {
  const run = new FakeRun({ limits: { maxTasks: 5 } })
  let { dispatch } = run.next()
  assert.equal(dispatch.length, 4)
  run.deliver({ hostTaskId: dispatch[0].hostTaskId, status: 'failed', failureClass: 'no-start' })
  ;({ dispatch } = run.next())
  // 남은 호출은 하나다. 재시도(01-fsd#2)가 계획 순서대로 먼저 그 하나를 쓴다.
  assert.deepEqual(dispatch.map(one => `${one.task}#${one.attempt}`), ['01-fsd#2'])
  run.deliver({ hostTaskId: dispatch[0].hostTaskId })
  const stopped = run.next()
  assert.deepEqual(stopped.dispatch, [])
  assert.equal(stopped.halt, 'max-tasks')
  const halt = haltOf(run.events)
  assert.equal(halt.reason, 'max-tasks')
  assert.deepEqual(halt.queuedTasks, ['props', 'exception'])
  assert.equal(budgetOf(run.events, run.now).used, 5)

  // 멈춘 뒤에는 다시 물어도 띄우지 않고, 돌던 작업이 끝나면 단계가 끝난다. 띄우지 못한 작업은 queued로 남는다.
  for (const one of stopped.running) run.deliver({ task: one.task, attempt: one.attempt })
  const after = run.next()
  assert.deepEqual(after.dispatch, [])
  assert.equal(after.complete, true)
  assert.equal(run.states().props, 'queued')
  assert.equal(run.events.filter(event => event.phase === 'dispatch.halt').length, 1)
})

test('시간 상한이 지나면 새로 띄우지 않고, 돌던 시도를 취소하며, 그 뒤에 온 결과는 받지 않는다', () => {
  const run = new FakeRun({ limits: { maxDurationSec: 600 } })
  const { dispatch } = run.next()
  run.tick(300)
  run.deliver({ hostTaskId: dispatch[0].hostTaskId })
  run.tick(301)
  const late = run.next()
  assert.equal(late.halt, 'max-duration')
  assert.deepEqual(late.dispatch, [])
  assert.deepEqual(late.cancel.map(one => one.task), ['02-type', '04-state', '05-effect'])
  assert.equal(late.complete, true)
  assert.equal(run.states()['02-type'], 'cancelled')
  // 취소 뒤에 도착한 응답 — 결과 자리를 덮지 않는다.
  assert.equal(run.deliver({ hostTaskId: dispatch[1].hostTaskId }), 'late')
  assert.equal(run.states()['02-type'], 'cancelled')
})

test('시간 상한으로 취소된 작업은 새 구간에서 다시 차례가 오고, 취소된 시도는 재시도 횟수에 세지 않는다', () => {
  // 취소를 끝으로만 두면 "나중에 이어서"가 취소된 범위를 영영 검토하지 않는다.
  const run = new FakeRun({ limits: { maxDurationSec: 600 }, plan: MODULES.slice(0, 2) })
  const first = run.next()
  run.deliver({ hostTaskId: first.dispatch[0].hostTaskId, status: 'failed', failureClass: 'no-start' })
  run.next()
  run.tick(601)
  assert.deepEqual(run.next().cancel.map(one => `${one.task}#${one.attempt}`), ['01-fsd#2', '02-type#1'])
  // 같은 구간에서는 다시 띄우지 않는다.
  assert.deepEqual(run.next().dispatch, [])

  run.tick(60)
  run.push('run.resume', { maxDurationSec: 600 })
  const resumed = run.next()
  assert.deepEqual(resumed.dispatch.map(one => `${one.task}#${one.attempt}`), ['01-fsd#3', '02-type#2'])
  assert.deepEqual(resumed.dispatch[1].retryOf, { attempt: 1, failureClass: 'cancelled' })
  // 01-fsd는 스스로 한 번 실패(no-start)했고 한 번 취소됐다. 세 번째 시도가 실패하면 그것으로 끝이다.
  run.deliver({ hostTaskId: resumed.dispatch[0].hostTaskId, status: 'failed', failureClass: 'no-start' })
  assert.equal(run.states()['01-fsd'], 'unavailable')
})

test('끝 알림 없이 staleAfterSec를 넘긴 시도는 죽은 것으로 끝내고 새 시도를 띄우며, 앞 시도의 늦은 응답은 받지 않는다', () => {
  const run = new FakeRun({ limits: { staleAfterSec: 600 }, plan: MODULES.slice(0, 1) })
  const first = run.next()
  run.tick(601)
  const second = run.next()
  assert.deepEqual(second.expire.map(one => `${one.task}#${one.attempt}`), ['01-fsd#1'])
  assert.deepEqual(second.dispatch.map(one => `${one.task}#${one.attempt}`), ['01-fsd#2'])
  assert.deepEqual(second.dispatch[0].retryOf, { attempt: 1, failureClass: 'inactivity-timeout' })
  // 앞 시도의 응답이 이제야 왔다 — 새 시도의 결과를 덮지 않는다.
  assert.equal(run.deliver({ hostTaskId: first.dispatch[0].hostTaskId }), 'late')
  assert.equal(run.deliver({ hostTaskId: second.dispatch[0].hostTaskId }), 'accept')
  assert.equal(run.states()['01-fsd'], 'succeeded')
})

test('호스트가 살아 있다고 다시 묶으면 죽은 시도로 보는 시계가 다시 간다', () => {
  const run = new FakeRun({ limits: { staleAfterSec: 600 }, plan: MODULES.slice(0, 1) })
  const { dispatch } = run.next()
  run.tick(500)
  run.push('task.bind', { stage: 'module', task: '01-fsd', attempt: 1, taskId: dispatch[0].hostTaskId })
  run.tick(500)
  assert.deepEqual(run.next().expire, [])
  run.tick(101)
  assert.equal(run.next().expire.length, 1)
})

test('다른 실행이 띄운 호스트 작업의 응답은 이 실행의 것으로 받지 않는다', () => {
  const run = new FakeRun()
  run.next()
  assert.equal(run.deliver({ hostTaskId: 'bg_from_another_run' }), 'unknown')
  assert.equal(run.deliver({ task: 'never-planned', attempt: 1 }), 'unknown')
})

test('호스트 작업 ID와 다른 시도 번호를 함께 주면 호스트의 말을 따른다', () => {
  const run = new FakeRun({ limits: { staleAfterSec: 60 }, plan: MODULES.slice(0, 1) })
  const first = run.next()
  run.tick(61)
  run.next()
  // 오케스트레이터는 시도 2의 응답이라고 믿지만, 알림은 시도 1의 호스트 작업에서 왔다.
  assert.equal(run.deliver({ hostTaskId: first.dispatch[0].hostTaskId, task: '01-fsd', attempt: 2 }), 'late')
})

test('검증 단계의 승격은 bundle이 needs-context로 돌린 후보에만 생기고, 호출 수에 들어간다', () => {
  const routed = {
    verifierTasks: [
      { taskId: 'bundle-1', route: 'bundle', candidateIds: ['04-3#1', '04-3#2'], prompt: 'b1.md', verdict: 'b1.verdict.json' },
      { taskId: 'isolated-02-1-1', route: 'isolated', candidateIds: ['02-1#1'], prompt: 'i1.md', verdict: 'i1.verdict.json' },
    ],
    promotions: {
      '04-3#1': { taskId: 'isolated-04-3-1', prompt: 'p1.md', verdict: 'p1.verdict.json' },
      '04-3#2': { taskId: 'isolated-04-3-2', prompt: 'p2.md', verdict: 'p2.verdict.json' },
    },
  }
  assert.deepEqual(verifyPlan(routed).map(entry => entry.task), ['bundle-1', 'isolated-02-1-1'])
  const plan = verifyPlan(routed, new Map([['bundle-1', ['04-3#2']]]))
  assert.deepEqual(plan.map(entry => `${entry.task}:${entry.kind}`), ['bundle-1:bundle', 'isolated-02-1-1:isolated', 'isolated-04-3-2:promotion'])

  const run = new FakeRun({ limits: { maxTasks: 3 } })
  run.push('crossverify.start', { targets: 3 })
  const first = run.next({ stage: 'verify', plan: verifyPlan(routed) })
  assert.equal(first.dispatch.length, 2)
  run.deliver({ stage: 'verify', hostTaskId: first.dispatch[0].hostTaskId })
  const promoted = run.next({ stage: 'verify', plan })
  assert.deepEqual(promoted.dispatch.map(one => one.task), ['isolated-04-3-2'])
  assert.equal(budgetOf(run.events, run.now).remaining, 0)
  assert.ok(run.events.some(event => event.phase === 'verify.start' && event.kind === 'promotion'))
})

test('검증을 처음부터 다시 하면 앞 라운드의 시도는 이번 라운드의 상태가 아니다', () => {
  const run = new FakeRun()
  const plan = [{ task: 'bundle-1', kind: 'bundle' }]
  run.push('crossverify.start', { targets: 1 })
  run.next({ stage: 'verify', plan })
  run.push('crossverify.start', { targets: 1 })
  assert.equal(run.states('verify', plan)['bundle-1'], 'queued')
})

test('새 한도 구간은 호출 수와 시간을 다시 재고, 앞 구간의 멈춤을 걷는다', () => {
  const run = new FakeRun({ limits: { maxTasks: 2 } })
  // 슬롯은 넷이지만 호출은 둘뿐이다. 둘을 띄우고 그 자리에서 멈춘다 — 띄운 둘은 돌고 있다.
  const first = run.next()
  assert.deepEqual(first.dispatch.map(one => one.task), ['01-fsd', '02-type'])
  assert.equal(first.halt, 'max-tasks')
  assert.equal(haltOf(run.events).running, 2)
  run.deliver({ task: '01-fsd', attempt: 1 })
  run.deliver({ task: '02-type', attempt: 1 })
  assert.deepEqual(run.next().dispatch, [])
  run.tick(3600)
  run.push('run.resume', { maxTasks: 2, maxDurationSec: 600 })
  assert.equal(haltOf(run.events), null)
  const resumed = run.next()
  assert.deepEqual(resumed.dispatch.map(one => one.task), ['04-state', '05-effect'])
  // 새 구간의 호출 둘도 그 자리에서 다 썼다 — 남은 두 작업 때문에 이 구간도 멈춘다.
  assert.deepEqual(haltOf(run.events).queuedTasks, ['props', 'exception'])
  assert.equal(segmentOf(run.events).maxDurationSec, 600)
  assert.equal(budgetOf(run.events, run.now).used, 2)
})

test('디스패치의 시작과 끝은 대장이 남긴다 — 끝의 수치는 기록에서 센다', () => {
  const run = new FakeRun({ plan: MODULES.slice(0, 1) })
  const { dispatch } = run.next()
  assert.deepEqual(run.events.filter(event => event.phase === 'dispatch.start').map(event => event.modules), [1])
  run.deliver({ hostTaskId: dispatch[0].hostTaskId })
  run.next()
  run.next()
  assert.equal(run.events.filter(event => event.phase === 'dispatch.end').length, 1)
})

test('결정은 아무것도 쓰지 않는다 — 같은 입력이면 같은 결정이다', () => {
  const run = new FakeRun()
  const snapshot = JSON.stringify(run.events)
  const once = decideNext({ stage: 'module', plan: MODULES, fold: foldAttempts(run.events), events: run.events, now: run.now })
  const twice = decideNext({ stage: 'module', plan: MODULES, fold: foldAttempts(run.events), events: run.events, now: run.now })
  assert.deepEqual(once, twice)
  assert.equal(JSON.stringify(run.events), snapshot)
})

test('호스트 능력은 확인한 것만 참이고, 모르는 호스트는 아무 능력도 없다', () => {
  assert.equal(hostCapabilities('claude-code').cancel, true)
  assert.equal(hostCapabilities('opencode').perTaskNotification, false)
  const unknown = hostCapabilities('my-harness')
  assert.equal(unknown.known, false)
  assert.equal(unknown.cancel, false)
  assert.match(durationLimitScope(unknown), /멈추지 못한다/)
  assert.match(durationLimitScope(hostCapabilities('opencode')), /전부 끝나야/)
  assert.doesNotMatch(durationLimitScope(hostCapabilities('claude-code')), /멈추지 못한다/)
})

test('끝 줄은 값이 없는 필드를 싣지 않는다', () => {
  assert.deepEqual(settleRecord('verify', 'bundle-1', 1, { status: 'ok', taskId: undefined, failureClass: null }), {
    phase: 'verify.done', data: { task: 'bundle-1', attempt: 1, status: 'ok' },
  })
})
