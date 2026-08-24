import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyExit } from '../scripts/lib/eval-run.mjs'

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
