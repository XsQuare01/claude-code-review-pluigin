import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  checkSkeleton,
  checkSummaryArithmetic,
  parseFindings,
} from '../scripts/lib/eval-grade.mjs'

// 실물 리포트가 내는 레이아웃을 채점기가 어떻게 읽는지 고정한다.
//
// A2 기준선에서 summaryArithmetic이 "2회 중 2회 OK"였다. fixture 리포트가
// 우연히 한 형식만 썼기 때문이고, 2.6.2로 돌린 실사용 리포트 두 건에서 처음
// 갈렸다. 계측기가 자기 fixture에만 맞춰져 있었던 것이다.
//
// **이 파일의 일부 단언은 현재의 틀린 동작을 고정한다.** 고치기 전에 무엇이
// 깨지는지 못박아야, 고친 뒤에 무엇이 나아졌는지 diff로 말할 수 있다.
// 고쳐야 할 자리는 DEFECT로 표시했다.

const SHAPES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'report-shapes')
const shape = name => readFileSync(join(SHAPES, `${name}.md`), 'utf8')
const summaryOf = name => {
  const text = shape(name)
  return checkSummaryArithmetic(text, parseFindings(text))
}

// 모든 fixture는 같은 지적 2건(🔴 1, 🟡 1)을 담는다. 변수는 요약 형식과
// 실행 계획 내용뿐이므로, 채점기 결과의 차이는 그 둘에서만 온다.

for (const name of [
  'summary-numeric-table',
  'summary-per-finding-table',
  'summary-no-counts',
  'plan-contract-shaped',
  'plan-renders-itself',
]) {
  test(`${name}: 지적 2건이 파싱되고 골격 섹션이 갖춰져 있다`, () => {
    const text = shape(name)
    assert.equal(parseFindings(text).length, 2)
    assert.deepEqual(checkSkeleton(text).problems, [])
  })
}

// ---------------------------------------------------------------------------
// 요약 집계 — 형식 세 가지

test('숫자 열 표는 읽는다', () => {
  const result = summaryOf('summary-numeric-table')
  assert.equal(result.ok, true)
  assert.deepEqual(result.summary, { red: 1, yellow: 1, blue: 0 })
})

test('finding별 표 + 산문 총계를 읽는다', () => {
  // 한때 이 fixture가 거짓 경보를 냈다. 파서가 숫자 열 표만 알아서 요약을
  // 0으로 읽고 불일치로 판정했고, 계약을 지킨 리포트가 벌점을 받았다.
  const result = summaryOf('summary-per-finding-table')
  assert.equal(result.present, true)
  assert.equal(result.ok, true)
  assert.deepEqual(result.summary, { red: 1, yellow: 1, blue: 0 })
  assert.deepEqual(result.sources, ['per-finding-table', 'prose-total'])
})

test('집계가 없는 것과 집계가 맞는 것이 구분된다', () => {
  // 한때 이 둘이 같은 값을 냈다. 원인이 정반대인데 — 하나는 요약이 없는 것이고
  // 하나는 파서가 못 읽은 것인데 — 출력이 똑같아서, 리포트를 고쳐야 할지
  // 파서를 고쳐야 할지 알 수 없었다. 0을 잘못 읽는 것이 이 저장소의 단골
  // 실패이고 여기서 또 나왔다.
  const missing = summaryOf('summary-no-counts')
  const sound = summaryOf('summary-per-finding-table')

  assert.equal(missing.present, false, '집계가 없다')
  assert.equal(sound.present, true, '집계가 있고 맞는다')
  assert.match(missing.why, /집계가 없다/)
})

// ---------------------------------------------------------------------------
// 섹션 내용 — 실행 계획

test('DEFECT: 실행 계획이 렌더링 절차를 담아도 채점기가 알아채지 못한다', () => {
  // C-7은 실행 계획에 "후보 N / 적용 M / SKIPPED·UNKNOWN 목록과 사유 /
  // 실패 클래스별 건수"를 요구한다. plan-renders-itself는 그 대신
  // 오케스트레이터의 내부 렌더링 절차를 적는다 — 실물 리포트에서 관측된 형태다.
  //
  // checkSkeleton은 `## ` 헤딩의 이름과 순서만 본다. 섹션이 자리만 지키고
  // 역할을 안 해도 통과한다.
  //
  // 고친 뒤 기대: 새 축 sectionContent가 두 fixture를 가른다
  const contractShaped = shape('plan-contract-shaped')
  const rendersItself = shape('plan-renders-itself')

  assert.deepEqual(
    checkSkeleton(contractShaped),
    checkSkeleton(rendersItself),
    '지금은 두 리포트가 구조적으로 구분되지 않는다',
  )

  // 내용은 실제로 다르다 — 계측기가 못 보는 것이지 없는 것이 아니다.
  assert.match(contractShaped, /후보: `N=20`|numbered 후보/)
  assert.ok(!/후보: `N=|numbered 후보/.test(rendersItself))
})
