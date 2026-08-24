import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyExit, parseEnvelope } from '../scripts/lib/eval-run.mjs'

// Windows에는 POSIX 시그널이 없어서, harness가 .kill('SIGKILL')로 죽인 프로세스도
// close 이벤트의 signal이 null로 온다. killedByTimeout 플래그가 아니라 signal로
// 분류하면 이 저장소가 실제로 돌아가는 플랫폼에서 타임아웃을 절대 못 잡는다 — 이
// 네 테스트는 그 버그를 재현하고 고정한다.

test('harness가 타임아웃으로 kill했으면 signal이 무엇이든 timeout으로 분류한다', () => {
  // Windows 재현: SIGKILL로 죽여도 close 이벤트는 signal: null, code: 1로 온다.
  assert.equal(classifyExit({ killedByTimeout: true, code: 1, signal: null }), 'timeout')
})

test('정상 종료(exit 0)는 true로 분류한다', () => {
  assert.equal(classifyExit({ killedByTimeout: false, code: 0, signal: null }), true)
})

test('타임아웃이 아닌 비정상 종료(exit != 0)는 failed로 분류한다', () => {
  assert.equal(classifyExit({ killedByTimeout: false, code: 1, signal: null }), 'failed')
})

test('harness가 kill하지 않았다면 SIGKILL 신호만으로는 timeout으로 보지 않는다', () => {
  // signal을 신뢰하지 않는다는 것을 반대 방향에서도 고정한다: 외부에서 온
  // SIGKILL은 killedByTimeout이 없으면 timeout이 아니라 failed다.
  assert.equal(classifyExit({ killedByTimeout: false, code: null, signal: 'SIGKILL' }), 'failed')
})

// claude -p --output-format json이 stdout에 남기는 결과 봉투를 파싱한다. 크래시나
// 부분 출력이면 stdout이 JSON이 아닐 수 있다 — 그 경우 예외를 던지는 대신 null로
// 접어야, grading 배치 전체가 파싱 실패 하나로 멈추지 않는다.

test('유효한 JSON 봉투는 그대로 파싱된다', () => {
  const raw = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '## 리뷰 기준\n...' })
  const envelope = parseEnvelope(raw)
  assert.equal(envelope.type, 'result')
  assert.equal(envelope.result, '## 리뷰 기준\n...')
})

test('JSON이 아닌 stdout은 던지지 않고 null로 접힌다', () => {
  assert.equal(parseEnvelope('claude: command not found\n(and a stack trace below)'), null)
})

test('result가 없는 JSON도 파싱은 되고 result만 undefined다', () => {
  const raw = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true })
  const envelope = parseEnvelope(raw)
  assert.equal(envelope.is_error, true)
  assert.equal(envelope.result, undefined)
})
