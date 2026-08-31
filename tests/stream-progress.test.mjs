import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  buildClaudeArgs,
  diagnoseStall,
  envelopeFromStream,
  parseStreamEvents,
  summarizeOpFailures,
  summarizeProgress,
} from '../scripts/lib/eval-run.mjs'

// 죽은 프로세스에서 진행 상황을 읽는 규칙을 고정한다.
//
// 2026-08-31 render-throughput run은 타임아웃을 재현하는 데는 성공했지만
// (completed=timeout, 2400s, reportFound=false) 원인을 가르지 못했다.
// opFailures·numTurns·stopReason이 전부 비어 있었고, 그 값들은 프로세스가
// 정상 종료할 때만 나오는 결과 봉투에서 온다 — kill된 프로세스에는 없다.
// 타임아웃을 재는 데 성공한 순간 진단 정보를 잃는 구조였다.
//
// 이 파일은 그 구멍을 메운 규칙들을 리뷰 실행 없이 지킨다. 리뷰 실행은
// 사용자 지시로 금지돼 있다 — evals/README.md의 "돌리지 않는다" 절.

const STREAMS = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'streams')
const streamOf = name => readFileSync(join(STREAMS, `${name}.ndjson`), 'utf8')
const eventsOf = name => parseStreamEvents(streamOf(name)).events
const progressOf = name => summarizeProgress(eventsOf(name))
const verdictOf = name => diagnoseStall(progressOf(name)).verdict

// ── 끊긴 것과 깨진 것을 가른다 ─────────────────────────────────────────────

test('kill로 잘린 마지막 줄은 truncated이지 malformed가 아니다', () => {
  // kill된 프로세스의 마지막 줄은 거의 항상 쓰다 만 JSON이다. 이것을 파싱
  // 실패로 세면 "형식이 깨졌다"(파서가 틀렸다)와 "중간에 죽었다"(정상)가
  // 같은 숫자로 뭉개지고, 대응이 정반대인 두 사건을 구분할 수 없게 된다.
  const parsed = parseStreamEvents(streamOf('render-stall'))
  assert.equal(parsed.truncated, true)
  assert.equal(parsed.malformed, 0)
  // 잘린 줄 앞의 이벤트는 전부 살아 있어야 한다 — 그것이 캡처의 목적이다.
  assert.equal(parsed.events.length, 6)
})

test('중간 줄이 깨지면 malformed로 세고 truncated로는 세지 않는다', () => {
  const parsed = parseStreamEvents(streamOf('malformed-middle'))
  assert.equal(parsed.malformed, 1)
  assert.equal(parsed.truncated, false)
})

test('빈 스트림은 던지지 않고 빈 결과를 낸다', () => {
  const parsed = parseStreamEvents(streamOf('empty'))
  assert.deepEqual(parsed, { events: [], malformed: 0, truncated: false })
})

test('null이나 undefined를 받아도 던지지 않는다', () => {
  // 배치 전체가 한 run의 이상한 stdout 때문에 멈추면 안 된다.
  assert.equal(parseStreamEvents(null).events.length, 0)
  assert.equal(parseStreamEvents(undefined).events.length, 0)
})

// ── 완주한 run이 잃는 것이 없어야 한다 ─────────────────────────────────────

test('완주한 스트림의 마지막 result 이벤트가 종전 봉투와 같은 자리다', () => {
  // 이것이 깨지면 스트림 전환은 정보를 더하는 것이 아니라 바꿔치기가 된다.
  const envelope = envelopeFromStream(eventsOf('completed'))
  assert.equal(envelope.num_turns, 41)
  assert.equal(envelope.stop_reason, 'end_turn')
  assert.equal(envelope.total_cost_usd, 3.42)
  assert.deepEqual(envelope.permission_denials, [])
  assert.equal(typeof envelope.result, 'string')
})

test('스트림에서 건진 봉투로 opFailures가 종전대로 계산된다', () => {
  const envelope = envelopeFromStream(eventsOf('completed'))
  assert.deepEqual(summarizeOpFailures(envelope.subagent_stats), {
    spawned: 2, failed: 0, killed: 1, refused: 0, total: 1,
  })
})

test('완주하지 못한 스트림에는 봉투가 없다', () => {
  // 없는 것을 0으로 접지 않는다. 봉투가 없다는 사실 자체가 신호다.
  assert.equal(envelopeFromStream(eventsOf('render-stall')), null)
  assert.equal(envelopeFromStream(eventsOf('fanout-stall')), null)
})

// ── 진행 상황을 센다 ───────────────────────────────────────────────────────

test('producer의 dispatch와 반환을 따로 센다', () => {
  // 합쳐서 "fan-out이 돌았다"로 접으면 producer가 다 끝났는지 아직인지가
  // 사라지는데, 그 구분이 이 계측 전부의 이유다.
  assert.deepEqual(
    (({ dispatched, returned, producersDone }) => ({ dispatched, returned, producersDone }))(progressOf('render-stall')),
    { dispatched: 3, returned: 3, producersDone: true },
  )
  assert.deepEqual(
    (({ dispatched, returned, producersDone }) => ({ dispatched, returned, producersDone }))(progressOf('fanout-stall')),
    { dispatched: 3, returned: 1, producersDone: false },
  )
})

test('dispatch가 0이면 producersDone은 참이 아니다', () => {
  // 0/0을 참으로 접으면 fan-out이 아예 없었던 run이 "producer 완료"로 보인다.
  assert.equal(progressOf('no-dispatch').producersDone, false)
})

test('멈춘 순간 기다리던 일이 pending에 남는다', () => {
  // 도구 이름만으로는 어느 모듈이었는지 알 수 없다. 무엇을 하다 멈췄는지가
  // 병목의 위치 그 자체다.
  const { pending } = progressOf('render-stall')
  assert.deepEqual(pending, [{ name: 'Write', target: 'review-reports/code-review-full-x.md' }])
})

test('반환된 tool_use는 pending에 남지 않는다', () => {
  assert.deepEqual(progressOf('completed').pending, [])
})

test('리포트 쓰기의 시작과 완료를 따로 센다', () => {
  const stalled = progressOf('render-stall')
  assert.equal(stalled.writesStarted, 1)
  assert.equal(stalled.writesFinished, 0)
  const done = progressOf('completed')
  assert.equal(done.writesStarted, 1)
  assert.equal(done.writesFinished, 1)
})

// ── 사전 등록한 판별 규칙 ──────────────────────────────────────────────────
//
// case.json에 실행 전에 적어둔 문장을 값에 적용할 뿐이다:
//   producer가 전부 끝났는데 리포트가 없으면 병목은 렌더 단계다.
//   producer 쪽에서 멈췄으면 병목은 fan-out이고 렌더러 처방은 헛다리다.

test('producer가 전부 끝나고 쓰기에서 멈췄으면 렌더 병목이다', () => {
  assert.equal(verdictOf('render-stall'), 'render')
})

test('producer가 덜 돌아왔으면 fan-out 병목이고 렌더러 처방은 헛다리다', () => {
  const { verdict, why } = diagnoseStall(progressOf('fanout-stall'))
  assert.equal(verdict, 'fanout')
  assert.match(why, /3개 중 1개/)
})

test('dispatch가 없었던 run은 어느 쪽으로도 판정하지 않는다', () => {
  // 근거가 없는데 판정하면, fan-out이 재현되지 않은 run을 렌더 병목의
  // 증거로 쓰게 된다. 이 저장소가 이미 여러 번 그렇게 틀렸다.
  assert.equal(verdictOf('no-dispatch'), 'unknown')
})

test('빈 스트림은 판정하지 않는다', () => {
  assert.equal(verdictOf('empty'), 'unknown')
})

test('progress가 아예 없으면(캡처 꺼짐) 판정하지 않는다', () => {
  // 2026-08-31 run이 정확히 이 상태였다 — 스트림이 없어서 진단 자체가 불가.
  // "재지 않았다"를 "진행이 없었다"로 읽으면 안 된다.
  const { verdict, why } = diagnoseStall(null)
  assert.equal(verdict, 'unknown')
  assert.match(why, /스트림이 비었다/)
})

test('쓰기까지 끝났는데 리포트가 없으면 렌더 지연으로 접지 않는다', () => {
  // 렌더러가 느린 것이 아니라 다른 데로 썼다는 뜻이다. 이것을 render로
  // 접으면 엉뚱한 처방을 검증 없이 확신하게 된다.
  const progress = summarizeProgress(eventsOf('completed'))
  assert.equal(diagnoseStall(progress).verdict, 'unknown')
})

// ── CLI 인자 ───────────────────────────────────────────────────────────────

test('출력 형식의 기본값은 json이고 --verbose를 붙이지 않는다', () => {
  const args = buildClaudeArgs({
    command: '/x', pluginDir: 'p', fixtureRoot: 'f', permissionMode: 'bypassPermissions',
  })
  assert.equal(args[args.indexOf('--output-format') + 1], 'json')
  assert.ok(!args.includes('--verbose'))
})

test('stream-json에는 --verbose를 함께 넘긴다', () => {
  // -p와 함께 쓸 때 요구된다. 빠뜨리면 claude가 바로 종료한다.
  const args = buildClaudeArgs({
    command: '/x', pluginDir: 'p', fixtureRoot: 'f', permissionMode: 'bypassPermissions',
    outputFormat: 'stream-json',
  })
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json')
  assert.ok(args.includes('--verbose'))
})
