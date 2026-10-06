import { test } from 'node:test'
import assert from 'node:assert/strict'

import { moduleOutcomes } from '../scripts/lib/run-record.mjs'

// 모듈마다 최종 결과를 기록에서 정하는 규칙을 고정한다.
//
// 결과 스냅숏(#88 PR 0)은 "어느 모듈이 성공했고 어느 모듈이 실패했나"를 이 함수로
// 정한다. 정본은 **가장 큰 attempt**다 — 파일의 마지막 줄이 아니다. 시도 1을 나중에
// `failed`로 정정한 줄이 시도 2의 성공을 덮으면, 성공한 모듈이 실패로 기록된다
// (PR #87 리뷰에서 재현한 사례).

const done = (module, attempt, status, extra = {}) => ({ phase: 'module.done', module, attempt, status, ...extra })

test('모듈마다 마지막 시도의 결과를 낸다', () => {
  const outcomes = moduleOutcomes([
    { phase: 'run.start' },
    done('04-state', 1, 'failed', { failureClass: 'inactivity-timeout' }),
    done('04-state', 2, 'ok'),
    done('props', 1, 'ok'),
  ])
  assert.deepEqual(outcomes.get('04-state'), { status: 'ok', attempt: 2, failureClass: undefined })
  assert.deepEqual(outcomes.get('props'), { status: 'ok', attempt: 1, failureClass: undefined })
  assert.equal(outcomes.has('01-fsd'), false, '기록이 없는 모듈은 결과도 없다 — 0건이나 성공으로 채우지 않는다')
})

test('앞 시도를 나중에 정정한 줄은 뒤 시도의 결과를 덮지 않는다', () => {
  const outcomes = moduleOutcomes([
    done('04-state', 1, 'ERROR'),
    done('04-state', 2, 'ok'),
    done('04-state', 1, 'failed', { note: '시도 1의 어휘를 바로잡는다', failureClass: 'unknown' }),
  ])
  assert.equal(outcomes.get('04-state').status, 'ok')
  assert.equal(outcomes.get('04-state').attempt, 2)
})

test('같은 시도의 정정 줄은 앞 줄을 대신한다', () => {
  const outcomes = moduleOutcomes([
    done('04-state', 1, 'COMPLETED'),
    done('04-state', 1, 'ok', { note: '어휘 정정' }),
  ])
  assert.equal(outcomes.get('04-state').status, 'ok')
})

test('attempt가 없거나 숫자가 아닌 줄은 0번 시도로 본다', () => {
  const outcomes = moduleOutcomes([
    done('04-state', 1, 'ok'),
    { phase: 'module.done', module: '04-state', status: 'failed' },
  ])
  assert.equal(outcomes.get('04-state').status, 'ok', '시도 번호가 있는 성공을 번호 없는 줄이 덮지 않는다')
})
