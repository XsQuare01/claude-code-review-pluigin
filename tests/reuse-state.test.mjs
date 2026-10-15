import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_REUSE_WAIT_SEC, REUSE_MODULE, reuseState, reuseStateBefore } from '../scripts/lib/reuse-state.mjs'

// 기존 구현 검색의 상태를 기록에서 읽는다. 작업 대장은 이 값으로 05를 붙잡거나 풀고, 기록 검사는 이 값으로 05가
// 너무 일찍 시작했는지 본다 — 두 곳이 같은 기록을 다르게 읽지 않도록 정의는 하나다.

const at = sec => new Date(Date.UTC(2026, 9, 15, 0, 0, 0) + sec * 1000).toISOString()
const start = (extra = {}) => ({ at: at(0), seq: 1, phase: 'run.start', host: 't', rules: 'r', version: 'v', branch: 'b', changedFiles: 1, runId: 'r-1', reuseSearch: 'planned', ...extra })
const ev = (sec, phase, data = {}) => ({ at: at(sec), phase, ...data })

test('검색을 예정하지 않은 실행(예전 기록)은 기다릴 것이 없다', () => {
  const state = reuseState([start({ reuseSearch: undefined })], { now: Date.parse(at(10)) })
  assert.deepEqual([state.required, state.released], [false, true])
  assert.equal(REUSE_MODULE, '05-structure')
})

test('계획하고 시작했지만 끝나지 않았으면 05를 풀지 않는다', () => {
  const events = [start(), ev(5, 'reuse.planned', { searchId: 's1', scopeSha256: 'h', plan: 'p' }), ev(30, 'reuse.start', { searchId: 's1', plan: 'p' })]
  const state = reuseState(events, { now: Date.parse(at(60)) })
  assert.deepEqual([state.required, state.state, state.released, state.searchId], [true, 'running', false, 's1'])
})

test('끝(reuse.done)이 오면 상태와 함께 푼다 — 실패로 끝나도 푼다', () => {
  for (const status of ['complete', 'failed']) {
    const events = [start(), ev(5, 'reuse.planned', { searchId: 's1', scopeSha256: 'h', plan: 'p' }), ev(30, 'reuse.start', { searchId: 's1', plan: 'p' }),
      ev(90, 'reuse.done', { searchId: 's1', status })]
    const state = reuseState(events, { now: Date.parse(at(100)) })
    assert.deepEqual([state.state, state.released, state.status, state.releasedAt], ['done', true, status, at(90)])
  }
})

test('검색 프로세스가 끝을 남기지 못하고 사라지면(감싼 review-tool의 tool.done만 있다) 유실로 푼다', () => {
  const events = [start(), ev(5, 'reuse.planned', { searchId: 's1', scopeSha256: 'h', plan: 'p' }), ev(6, 'tool.start', { name: 'reuse-search', callId: 'c' }),
    ev(30, 'reuse.start', { searchId: 's1', plan: 'p' }), ev(40, 'tool.done', { name: 'reuse-search', exit: 1, treeSha: 'x', callId: 'c' })]
  const state = reuseState(events, { now: Date.parse(at(50)) })
  assert.deepEqual([state.state, state.released, state.releasedAt], ['lost', true, at(40)])
})

test('기다림에는 끝이 있다 — 계획한 때부터 waitSec이 지나면 시간 초과로 푼다', () => {
  const events = [start(), ev(5, 'reuse.planned', { searchId: 's1', scopeSha256: 'h', plan: 'p', waitSec: 100 }), ev(30, 'reuse.start', { searchId: 's1', plan: 'p' })]
  assert.equal(reuseState(events, { now: Date.parse(at(104)) }).released, false)
  const late = reuseState(events, { now: Date.parse(at(106)) })
  assert.deepEqual([late.state, late.released, late.releasedAt], ['timed-out', true, at(105)])
})

test('계획 줄이 아예 없어도 05가 영원히 기다리지 않는다 — 첫 디스패치부터 기본 상한을 잰다', () => {
  const events = [start(), ev(10, 'dispatch.start', { modules: 20, inflight: 4 })]
  const waiting = reuseState(events, { now: Date.parse(at(20)) })
  assert.deepEqual([waiting.state, waiting.released], ['unplanned', false])
  const late = reuseState(events, { now: Date.parse(at(10 + DEFAULT_REUSE_WAIT_SEC + 1)) })
  assert.deepEqual([late.state, late.released, late.releasedAt], ['timed-out', true, at(10 + DEFAULT_REUSE_WAIT_SEC)])
})

test('앞 시도의 끝은 새 시도를 풀지 않는다 — 시도는 searchId로 가른다', () => {
  const events = [start(),
    ev(5, 'reuse.planned', { searchId: 's1', scopeSha256: 'h', plan: 'p' }), ev(6, 'reuse.start', { searchId: 's1', plan: 'p' }), ev(9, 'reuse.done', { searchId: 's1', status: 'failed' }),
    ev(20, 'reuse.planned', { searchId: 's2', scopeSha256: 'h', plan: 'p' }), ev(21, 'reuse.start', { searchId: 's2', plan: 'p' })]
  const state = reuseState(events, { now: Date.parse(at(30)) })
  assert.deepEqual([state.searchId, state.state, state.released], ['s2', 'running', false])
})

// 풀린 시각은 가장 먼저 온 사건이다. 상한이 먼저 지났으면 작업 대장은 그때 05를 풀었다 — 그 뒤에 온 끝(reuse.done)이나
// 감싼 review-tool의 끝은 풀린 시각을 뒤로 미루지 않는다. 미루면 정상으로 돈 05가 "풀리기 전에 시작했다"로 짚힌다.
test('상한 뒤에 끝이 와도 풀린 시각은 상한이다', () => {
  const planned = ev(5, 'reuse.planned', { searchId: 's1', scopeSha256: 'h', plan: 'p', waitSec: 60 })
  const late = reuseState([start(), planned, ev(30, 'reuse.start', { searchId: 's1', plan: 'p' }), ev(200, 'reuse.done', { searchId: 's1', status: 'complete' })], { now: Date.parse(at(300)) })
  assert.deepEqual([late.state, late.releasedAt], ['done', at(65)])
  const lost = reuseState([start(), planned, ev(30, 'reuse.start', { searchId: 's1', plan: 'p' }), ev(1900, 'tool.done', { name: 'reuse-search', exit: null, treeSha: 'x', callId: 'c' })], { now: Date.parse(at(2000)) })
  assert.deepEqual([lost.state, lost.releasedAt], ['lost', at(65)])
})

// 05를 띄운 순간의 상태 — 그 뒤의 기록(다시 등록한 검색, 늦게 온 끝)은 05가 무엇을 받고 돌았는지를 바꾸지 않는다.
test('05를 띄운 순간의 상태는 그 줄 앞의 기록과 그 시각으로 읽는다', () => {
  const events = [start(), ev(5, 'reuse.planned', { searchId: 's1', scopeSha256: 'h', plan: 'p' }), ev(6, 'reuse.start', { searchId: 's1', plan: 'p' }),
    ev(9, 'reuse.done', { searchId: 's1', status: 'failed', reason: 'plan-invalid' }), ev(10, 'module.start', { module: REUSE_MODULE, attempt: 1 }),
    ev(20, 'reuse.planned', { searchId: 's2', scopeSha256: 'h', plan: 'p' }), ev(21, 'reuse.start', { searchId: 's2', plan: 'p' }), ev(50, 'reuse.done', { searchId: 's2', status: 'complete' })]
  const atDispatch = reuseStateBefore(events, events[4])
  assert.deepEqual([atDispatch.searchId, atDispatch.state, atDispatch.status, atDispatch.released], ['s1', 'done', 'failed', true])
  assert.equal(reuseState(events, { now: Date.parse(at(60)) }).searchId, 's2')
})
