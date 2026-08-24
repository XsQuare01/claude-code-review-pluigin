import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extractDetailSection, parseLocation, parseFindings } from '../scripts/lib/eval-grade.mjs'

// 리포트 골격은 workflow-contract C-7이 고정한다. 파서는 그 골격만 신뢰하고,
// 셀 내용은 신뢰하지 않는다 — 이슈/개선 제안 칸에는 `a || b` 같은 코드 인용이 들어온다.
const REPORT = `# \`feature/x\` 코드 리뷰 리포트

## 리뷰 기준

> **기준**: abc123 | **대상**: HEAD

## 판정

머지 보류.

## 실행 계획

위치 대조: 2건 — 확인 2 · counts 출처: \`prepare-verification.mjs\`

## 상세 지적

### React 규칙

| 심각도 | 규칙 | 위치 | 이슈 | 개선 제안 |
|--------|------|------|------|----------|
| 🔴 | 03-3 | \`src/a.tsx:31\` | 정렬되는 리스트에 index key | id를 쓴다 |
| 🟡 | 06-1 | src/a.tsx:12-14 | \`count && <Badge/>\` 는 0을 렌더 | \`count > 0 &&\` |

### 타입 안전성

| 심각도 | 규칙 | 위치 | 이슈 | 개선 제안 |
|--------|------|------|------|----------|
| 🔴 | 02-1 | 위치 미확인 (파일을 읽지 못함) | \`as any\` | 스키마 검증 |

## 요약

| 모듈 | 🔴 | 🟡 | 🔵 | 결과 |
|------|-----|-----|-----|------|
| React 규칙 | 1 | 1 | 0 | ⚠️ |
`

test('상세 지적 섹션만 잘라낸다', () => {
  const lines = extractDetailSection(REPORT)
  assert.ok(lines.some(line => line.includes('03-3')))
  assert.ok(!lines.some(line => line.includes('머지 보류')), '판정 섹션이 섞였다')
  assert.ok(!lines.some(line => line.includes('⚠️')), '요약 섹션이 섞였다')
})

test('상세 지적이 없으면 빈 배열을 준다', () => {
  assert.deepEqual(extractDetailSection('# 제목\n\n## 판정\n\n없음\n'), [])
})

test('위치 셀을 경로와 줄로 나눈다', () => {
  assert.deepEqual(parseLocation('`src/a.tsx:31`'), { path: 'src/a.tsx', line: 31, endLine: undefined })
  assert.deepEqual(parseLocation('src/a.tsx:12-14'), { path: 'src/a.tsx', line: 12, endLine: 14 })
})

test('위치를 확인하지 못한 셀은 unverified로 표시한다', () => {
  assert.equal(parseLocation('위치 미확인 (파일을 읽지 못함)').unverified, true)
  assert.equal(parseLocation('').unverified, true)
  assert.equal(parseLocation('src/a.tsx').unverified, true)
})

test('줄 번호 뒤의 괄호 주석을 무시한다', () => {
  assert.deepEqual(parseLocation('src/a.tsx:24-30 (삭제 전)'), { path: 'src/a.tsx', line: 24, endLine: 30 })
})

test('표에서 지적을 뽑고 모듈을 붙인다', () => {
  const findings = parseFindings(REPORT)
  assert.equal(findings.length, 3)
  assert.deepEqual(
    findings.map(f => [f.module, f.ruleId, f.severity]),
    [
      ['React 규칙', '03-3', '🔴'],
      ['React 규칙', '06-1', '🟡'],
      ['타입 안전성', '02-1', '🔴'],
    ],
  )
  assert.equal(findings[0].location.line, 31)
  assert.equal(findings[2].location.unverified, true)
})

test('헤더 행과 구분 행을 지적으로 세지 않는다', () => {
  const onlyHeader = `## 상세 지적

### M

| 심각도 | 규칙 | 위치 | 이슈 | 개선 제안 |
|--------|------|------|------|----------|

## 요약
`
  assert.deepEqual(parseFindings(onlyHeader), [])
})

test('이슈 칸에 파이프가 들어와도 앞 세 칸이 밀리지 않는다', () => {
  const report = `## 상세 지적

### M

| 심각도 | 규칙 | 위치 | 이슈 | 개선 제안 |
|--------|------|------|------|----------|
| 🔴 | 09-13 | src/a.ts:5 | \`a | b\` 가 항상 참 | 괄호를 넣는다 |

## 요약
`
  const findings = parseFindings(report)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].ruleId, '09-13')
  assert.equal(findings[0].location.line, 5)
})

// 실제 리포트는 지적마다 표를 따로 낸다 — 같은 `### 모듈` 아래서 헤더/구분 행이
// 지적 개수만큼 반복된다. 위쪽 테스트들은 표 경계가 모듈 경계와 겹치는 경우만
// 확인했으니, 모듈 하나 안에서 표가 세 번 반복되는 더 촉박한 모양도 고정해 둔다.
test('한 모듈 아래 표가 지적마다 따로 나와도(헤더/구분 행이 여러 번 반복돼도) 모두 지적으로 뽑는다', () => {
  const report = `## 상세 지적

### React 규칙

| 심각도 | 규칙 | 위치 | 이슈 | 개선 제안 |
|--------|------|------|------|----------|
| 🔴 | 규칙 미확인 | \`src/order-list.tsx:31\` | index를 key로 쓴다 | id를 쓴다 |

| 심각도 | 규칙 | 위치 | 이슈 | 개선 제안 |
|--------|------|------|------|----------|
| 🟡 | 06-1 | \`src/order-list.tsx:40\` | 조건부 렌더에 0이 샌다 | \`> 0\` 비교 |

| 심각도 | 규칙 | 위치 | 이슈 | 개선 제안 |
|--------|------|------|------|----------|
| 🔵 | 09-2 | \`src/order-list.tsx:55\` | 사소한 스타일 | 정리 |

## 요약
`
  const findings = parseFindings(report)
  assert.equal(findings.length, 3)
  assert.deepEqual(findings.map(f => f.ruleId), ['규칙 미확인', '06-1', '09-2'])
  assert.deepEqual(findings.map(f => f.location.line), [31, 40, 55])
  assert.ok(findings.every(f => f.module === 'React 규칙'))
})

import { assertNoPathOverlap, gradeFindings } from '../scripts/lib/eval-grade.mjs'

const EXPECTED = {
  mustFind: [
    { id: 'key-index', ruleIds: ['03-3', '06-3'], path: 'src/a.tsx', line: 31, lineTolerance: 1 },
    { id: 'falsy-render', ruleIds: ['06-1'], path: 'src/a.tsx', line: 12, lineTolerance: 1 },
    { id: 'missing-cleanup', ruleIds: ['04-1'], path: 'src/b.ts', line: 8, lineTolerance: 2 },
  ],
  mustNotFlag: [
    { id: 'violation-in-test', path: 'src/a.test.tsx', why: 'C-5 제외 경로' },
  ],
}

const BLOBS = {
  head: {
    'src/a.tsx': new Array(40).fill('x'),
    'src/b.ts': new Array(10).fill('x'),
    'src/a.test.tsx': new Array(20).fill('x'),
  },
  base: {},
}

const finding = (ruleId, path, line) => ({
  module: 'M', severity: '🔴', ruleId,
  location: path === null ? { unverified: true, raw: '위치 미확인' } : { path, line, endLine: undefined },
})

test('기대한 결함을 규칙과 경로로 맞춘다', () => {
  const result = gradeFindings(
    [finding('03-3', 'src/a.tsx', 31), finding('06-1', 'src/a.tsx', 12)],
    EXPECTED, BLOBS,
  )
  assert.equal(result.recall.found, 2)
  assert.equal(result.recall.of, 3)
  assert.deepEqual(result.recall.missed, ['missing-cleanup'])
})

test('허용 규칙 ID 중 하나만 맞아도 탐지로 센다', () => {
  const result = gradeFindings([finding('06-3', 'src/a.tsx', 31)], EXPECTED, BLOBS)
  assert.equal(result.recall.found, 1)
})

test('줄 번호가 tolerance를 벗어나면 재현율은 인정하고 정확도만 깎는다', () => {
  const result = gradeFindings([finding('03-3', 'src/a.tsx', 23)], EXPECTED, BLOBS)
  assert.equal(result.recall.found, 1, '결함은 찾았다')
  assert.equal(result.locationsOnTarget.ok, 0, '위치는 틀렸다')
  assert.equal(result.locationsOnTarget.of, 1)
})

test('위치를 못 잡은 지적도 규칙만으로 탐지에 센다 — 다만 따로 표시한다', () => {
  const result = gradeFindings([finding('04-1', null, null)], EXPECTED, BLOBS)
  assert.equal(result.recall.found, 1)
  assert.equal(result.recall.ruleOnly, 1)
  assert.equal(result.locationsInRange.of, 0, '경로가 없으니 존재성 검사 대상이 아니다')
})

test('금지 대상을 지적하면 오탐으로 센다', () => {
  const result = gradeFindings([finding('03-3', 'src/a.test.tsx', 4)], EXPECTED, BLOBS)
  assert.equal(result.falsePositives.count, 1)
  assert.deepEqual(result.falsePositives.hits.map(h => h.target), ['violation-in-test'])
  assert.equal(result.unclassified, 0, '오탐은 unclassified가 아니다')
})

test('심지 않은 진짜 문제는 오탐이 아니라 unclassified다', () => {
  const result = gradeFindings([finding('15-2', 'src/b.ts', 3)], EXPECTED, BLOBS)
  assert.equal(result.falsePositives.count, 0)
  assert.equal(result.unclassified, 1)
})

test('파일 길이를 넘는 줄 번호를 잡아낸다', () => {
  const result = gradeFindings([finding('03-3', 'src/a.tsx', 999)], EXPECTED, BLOBS)
  assert.equal(result.locationsInRange.ok, 0)
  assert.equal(result.locationsInRange.of, 1)
  assert.deepEqual(result.locationsInRange.bad, [{ path: 'src/a.tsx', line: 999, reason: 'line beyond file length' }])
})

test('없는 경로를 잡아낸다', () => {
  const result = gradeFindings([finding('03-3', 'src/nope.tsx', 1)], EXPECTED, BLOBS)
  assert.deepEqual(result.locationsInRange.bad, [{ path: 'src/nope.tsx', line: 1, reason: 'path not in fixture' }])
})

test('삭제된 위치는 merge base 쪽에서 찾는다', () => {
  const blobs = { head: {}, base: { 'src/gone.ts': new Array(5).fill('x') } }
  const result = gradeFindings([finding('20-2', 'src/gone.ts', 3)], { mustFind: [], mustNotFlag: [] }, blobs)
  assert.equal(result.locationsInRange.ok, 1)
})

test('하나의 지적이 두 기대값을 동시에 채우지 않는다', () => {
  const expected = {
    mustFind: [
      { id: 'first', ruleIds: ['03-3'], path: 'src/a.tsx', line: 31, lineTolerance: 1 },
      { id: 'second', ruleIds: ['03-3'], path: 'src/a.tsx', line: 31, lineTolerance: 1 },
    ],
    mustNotFlag: [],
  }
  const result = gradeFindings([finding('03-3', 'src/a.tsx', 31)], expected, BLOBS)
  assert.equal(result.recall.found, 1)
  assert.deepEqual(result.recall.missed, ['second'])
})

test('발견된 모듈을 모은다', () => {
  const result = gradeFindings(
    [{ ...finding('03-3', 'src/a.tsx', 31), module: 'React 규칙' },
     { ...finding('02-1', 'src/b.ts', 2), module: '타입 안전성' }],
    EXPECTED, BLOBS,
  )
  assert.deepEqual(result.modulesWithFindings, ['React 규칙', '타입 안전성'])
})

test('mustFind와 mustNotFlag가 같은 경로를 쓰면 채점 대신 던진다', () => {
  const bad = {
    mustFind: [{ id: 'a', ruleIds: ['03-3'], path: 'src/x.tsx', line: 1, lineTolerance: 0 }],
    mustNotFlag: [{ id: 'b', path: 'src/x.tsx', why: '겹침' }],
  }
  assert.throws(() => assertNoPathOverlap(bad), /src\/x\.tsx/)
})

test('collectBlobs()의 원시 문자열을 그대로 넘기면 채점 대신 던진다', () => {
  const blobs = { head: { 'src/a.tsx': 'line one\nline two' }, base: {} }
  assert.throws(
    () => gradeFindings([finding('03-3', 'src/a.tsx', 1)], { mustFind: [], mustNotFlag: [] }, blobs),
    /array of lines/,
  )
})

import { checkSkeleton, checkScriptRan, checkSummaryArithmetic, grade } from '../scripts/lib/eval-grade.mjs'

test('C-7 골격에서 빠진 섹션을 잡아낸다', () => {
  assert.equal(checkSkeleton(REPORT).ok, false, '샘플 리포트에는 뒤쪽 섹션이 없다')
  assert.ok(checkSkeleton(REPORT).problems.some(p => p.includes('도구 실행 결과')))
})

test('섹션 순서가 뒤바뀌면 잡아낸다', () => {
  const swapped = [
    '# t', '## 리뷰 기준', '## 실행 계획', '## 판정', '## 상세 지적',
    '## 요약', '## 도구 실행 결과', '## 미해결 / 후속 확인',
  ].join('\n\n')
  const result = checkSkeleton(swapped)
  assert.equal(result.ok, false)
  assert.ok(result.problems.some(p => p.includes('순서')))
})

test('모든 섹션이 순서대로 있으면 ok다', () => {
  const good = [
    '# t', '## 리뷰 기준', '## 판정', '## 실행 계획', '## 상세 지적',
    '## 요약', '## 도구 실행 결과', '## 미해결 / 후속 확인',
  ].join('\n\n')
  assert.deepEqual(checkSkeleton(good), { ok: true, problems: [] })
})

test('counts 출처가 적혀 있으면 스크립트가 돈 것으로 본다', () => {
  const result = checkScriptRan(REPORT)
  assert.equal(result.countsAttributed, true)
  assert.equal(result.declaredSkipped, false)
  assert.equal(result.ran, true)
})

test('대조 미실행이라고 적었으면 돈 것이 아니다', () => {
  const result = checkScriptRan('## 실행 계획\n\n위치 대조: 대조 미실행 (REVIEW_LOCATIONS 블록 없음)\n')
  assert.equal(result.declaredSkipped, true)
  assert.equal(result.ran, false)
})

test('아무 언급도 없으면 돈 것이 아니고 건너뛴다고 선언한 것도 아니다', () => {
  const result = checkScriptRan('## 실행 계획\n\n모듈 21개 검토\n')
  assert.equal(result.ran, false)
  assert.equal(result.declaredSkipped, false)
  assert.equal(result.manifestBlock, false)
})

// C1 회귀 테스트: 라벨(`counts 출처`)만 보고 판단하던 첫 구현은 아래 두 줄을
// 구분하지 못했다 — 둘 다 라벨을 담기 때문이다. workflow-contract.md:295-296의
// 두 줄을 그대로 복사해, 값까지 읽어야 진짜로 돈 것과 정직하게 안 돌렸다고
// 적은 것이 서로 다른 결과로 나오는지 고정한다.
test('workflow-contract의 실제 실행 줄은 ran:true를 낸다', () => {
  const result = checkScriptRan('Verification coverage: 대상 10 중 7 검증 … · counts 출처: `prepare-verification.mjs`')
  assert.deepEqual(result, { ran: true, manifestBlock: false, countsAttributed: true, declaredSkipped: false })
})

test('workflow-contract의 미실행 줄은 ran:false를 낸다 — 라벨은 실행 줄과 똑같이 있다', () => {
  const result = checkScriptRan('Verification coverage: 대상 10 중 7 검증 … · counts 출처: 미실행 (모델 판정)')
  assert.deepEqual(result, { ran: false, manifestBlock: false, countsAttributed: true, declaredSkipped: true })
})

test('실행 줄과 미실행 줄은 서로 다른 결과를 낸다 — 라벨만 보면 둘이 같아진다', () => {
  const ran = checkScriptRan('Verification coverage: 대상 10 중 7 검증 … · counts 출처: `prepare-verification.mjs`')
  const skipped = checkScriptRan('Verification coverage: 대상 10 중 7 검증 … · counts 출처: 미실행 (모델 판정)')
  assert.notDeepEqual(ran, skipped)
  assert.equal(ran.countsAttributed, skipped.countsAttributed, '라벨 존재 여부는 둘 다 true — 이것만 보면 구분이 안 된다')
  assert.notEqual(ran.ran, skipped.ran)
})

test('counts 출처 줄 자체가 없으면 countsAttributed가 false다', () => {
  const result = checkScriptRan('## 실행 계획\n\n위치 대조는 언급하지 않는다\n')
  assert.equal(result.countsAttributed, false)
  assert.equal(result.declaredSkipped, false)
  assert.equal(result.ran, false)
})

test('대조 미실행 산문만 있고 counts 출처 라벨이 없어도 declaredSkipped는 true다', () => {
  const result = checkScriptRan('위치 대조: 대조 미실행 (prepare-verification.mjs 실행 권한 거부)')
  assert.equal(result.countsAttributed, false)
  assert.equal(result.declaredSkipped, true)
  assert.equal(result.ran, false)
})

test('요약 표 합계가 상세 지적과 맞는지 본다', () => {
  const findings = parseFindings(REPORT)
  const result = checkSummaryArithmetic(REPORT, findings)
  assert.deepEqual(result.summary, { red: 1, yellow: 1, blue: 0 })
  assert.deepEqual(result.detail, { red: 2, yellow: 1, blue: 0 })
  assert.equal(result.ok, false, '샘플은 02-1이 요약에서 빠져 있다')
})

test('grade가 모든 축을 한 객체로 준다', () => {
  const blobs = { head: { 'src/a.tsx': new Array(40).fill('x') }, base: {} }
  const expected = {
    mustFind: [{ id: 'key-index', ruleIds: ['03-3'], path: 'src/a.tsx', line: 31, lineTolerance: 1 }],
    mustNotFlag: [],
  }
  const result = grade(REPORT, expected, blobs)
  assert.equal(result.recall.found, 1)
  assert.equal(result.scriptRan.ran, true)
  assert.equal(result.skeletonOk.ok, false)
  assert.equal(typeof result.summaryArithmetic.ok, 'boolean')
})

// D4/D5 — 실제로 실행된 리뷰가 만든 두 형태. 위치 칸/줄이 path:line만 담는다고
// 가정한 것과, 지적이 항상 표라고 가정한 것이 둘 다 틀렸다. 실물 리포트는
// 위치와 코드 인용을 한 칸/한 줄에 같이 담고, 표 대신 `#### ` 블록을 쓰기도
// 한다.

test('위치 칸에 코드 인용이 백틱으로 같이 들어와도 첫 위치만 읽는다', () => {
  assert.deepEqual(
    parseLocation('`src/features/order-list/ui/order-list.tsx:31` — `<li key={index} onClick={() => onSelect(order.id)}>`'),
    { path: 'src/features/order-list/ui/order-list.tsx', line: 31, endLine: undefined },
  )
})

test('범위 위치도 백틱 코드 인용과 함께 오면 여전히 읽는다', () => {
  assert.deepEqual(
    parseLocation('`src/features/order-list/ui/order-list.tsx:21-24` — `() => sortOrders(orders, sortKey)`'),
    { path: 'src/features/order-list/ui/order-list.tsx', line: 21, endLine: 24 },
  )
})

// 실제 pr52 리포트의 02-3 행 그대로 — 위치 칸의 코드 인용 안에 마크다운이
// `\|`로 이스케이프한 파이프가 있다. splitRow는 이스케이프를 모르고 그 자리에서
// 칸을 자르지만, 위치 자신을 담은 첫 백틱 조각은 그 파이프보다 앞에 있어 온전하다.
test('위치 칸 안의 코드 인용에 이스케이프된 파이프(\\|)가 있어 표가 그 자리에서 잘려도 위치는 산다', () => {
  const report = `## 상세 지적

### 02 타입 안전성

| 심각도 | 규칙 | 위치 | 이슈 | 개선 제안 |
|--------|------|------|------|----------|
| 🟡 | \`02-3\` | \`src/features/order-list/ui/order-list.tsx:10\` — \`function sortOrders(orders: Order[], sortBy: 'date' \\| 'total'): Order[] {\` | 문제 | 제안 |

## 요약
`
  const findings = parseFindings(report)
  assert.equal(findings.length, 1)
  assert.deepEqual(findings[0].location, { path: 'src/features/order-list/ui/order-list.tsx', line: 10, endLine: undefined })
})

// 실제 pr52 리포트의 14-3 행 그대로 — 대표 줄(22) 뒤에 괄호로 실제 범위
// (`21-24`)를 따로 적어 둔다. 첫 백틱 조각(대표 줄)을 위치로 삼고 괄호 안의
// 범위 표기는 무시한다.
test('위치 칸이 대표 줄 뒤에 괄호로 범위를 따로 적어도 대표 줄을 위치로 삼는다', () => {
  const report = `## 상세 지적

### 14 React 성능

| 심각도 | 규칙 | 위치 | 이슈 | 개선 제안 |
|--------|------|------|------|----------|
| 🟡 | \`14-3\` | \`src/features/order-list/ui/order-list.tsx:22\` (범위 \`21-24\`) — \`() => sortOrders(orders, sortBy)\` | 문제 | 제안 |

## 요약
`
  const findings = parseFindings(report)
  assert.equal(findings.length, 1)
  assert.deepEqual(findings[0].location, { path: 'src/features/order-list/ui/order-list.tsx', line: 22, endLine: undefined })
})

// 실제 main 리포트의 03-3 블록 그대로 — 헤딩 다음 줄부터 빈 줄 없이
// 영향/확신, 위치, 본문·근거·개선 제안이 바로 이어진다.
test('블록 형태 지적도 헤딩과 첫 위치 줄에서 심각도·규칙·위치를 읽는다', () => {
  const report = `## 상세 지적

### 03 React 규칙 위반

#### 🟡 \`03-3\` 정렬·필터가 함께 일어나는 리스트의 key가 \`order.id\`에서 배열 인덱스로 바뀌었다
영향: 낮음 · 확신: 높음
\`src/features/order-list/ui/order-list.tsx:31\` — \`<li key={index} onClick={() => onSelect(order.id)}>\`
본문: …
근거: …
개선 제안: …

## 요약
`
  const findings = parseFindings(report)
  assert.equal(findings.length, 1)
  assert.deepEqual(findings[0], {
    module: '03 React 규칙 위반',
    severity: '🟡',
    ruleId: '03-3',
    location: { path: 'src/features/order-list/ui/order-list.tsx', line: 31, endLine: undefined },
  })
})

// 실제 main 리포트처럼 같은 `###` 아래 `#### ` 블록이 두 번 연달아 온다 —
// 하나를 다 읽고 다음 헤딩에서 flush 해야 첫 블록이 두 번째 블록에 먹히지 않는다.
test('같은 모듈 아래 블록이 연달아 와도 각각 따로 지적으로 뽑는다', () => {
  const report = `## 상세 지적

### 19 의도 & 선택 근거

#### 🟡 \`19-2\` 기본값 \`sortBy = 'date'\`가 호출자가 넘긴 배열 순서를 조용히 덮는다
영향: 낮음 · 확신: 높음
\`src/features/order-list/ui/order-list.tsx:18\` — \`export function OrderList({ orders, onSelect, sortBy = 'date' }: OrderListProps) {\`
본문: …
근거: …
개선 제안: …

#### 🟡 \`19-5\` 날짜 정렬이 \`Order.date\` 문자열 포맷에 대한 문서화되지 않은 전제 위에 서 있다
영향: 낮음 · 확신: 높음
\`src/features/order-list/ui/order-list.tsx:13\` — \`sortBy === 'total' ? right.total - left.total : right.date.localeCompare(left.date),\`
본문: …
근거: …
개선 제안: …

## 요약
`
  const findings = parseFindings(report)
  assert.equal(findings.length, 2)
  assert.deepEqual(findings.map(f => [f.ruleId, f.location.line]), [
    ['19-2', 18],
    ['19-5', 13],
  ])
  assert.ok(findings.every(f => f.module === '19 의도 & 선택 근거'))
})

test('한 리포트에 표를 쓰는 모듈과 블록을 쓰는 모듈이 섞여 있어도 둘 다 읽는다', () => {
  const report = `## 상세 지적

### 표 모듈

| 심각도 | 규칙 | 위치 | 이슈 | 개선 제안 |
|--------|------|------|------|----------|
| 🔴 | 02-1 | \`src/b.ts:8\` | \`as any\` | 스키마 검증 |

### 블록 모듈

#### 🔵 \`09-2\` 사소한 스타일

\`src/c.ts:5\` — \`padding: 4\`

## 요약
`
  const findings = parseFindings(report)
  assert.equal(findings.length, 2)
  assert.deepEqual(findings.map(f => [f.module, f.ruleId, f.severity, f.location.line]), [
    ['표 모듈', '02-1', '🔴', 8],
    ['블록 모듈', '09-2', '🔵', 5],
  ])
})

// 표와 블록이 같은 모듈에 동시에 있으면 이중 집계가 된다. 규칙: 표가 하나라도
// 있으면 그 모듈은 표만 신뢰하고 블록은 무시한다 — 표가 더 엄격하게 구조화된
// 원래 형식이기 때문이다.
test('같은 모듈에 표와 블록이 동시에 있으면 표만 세고 블록은 무시한다', () => {
  const report = `## 상세 지적

### 뒤섞인 모듈

| 심각도 | 규칙 | 위치 | 이슈 | 개선 제안 |
|--------|------|------|------|----------|
| 🔴 | 02-1 | \`src/b.ts:8\` | \`as any\` | 스키마 검증 |

#### 🔵 \`09-2\` 사소한 스타일

\`src/c.ts:5\` — \`padding: 4\`

## 요약
`
  const findings = parseFindings(report)
  assert.equal(findings.length, 1, '표가 있으면 같은 모듈의 블록은 세지 않는다')
  assert.equal(findings[0].ruleId, '02-1')
})

test('블록에 위치 백틱 줄이 없으면 위치를 못 찾은 것으로 남긴다', () => {
  const report = `## 상세 지적

### 모듈

#### 🔴 \`10-1\` 위치를 특정하지 못한 지적

본문: 파일을 특정하지 못했다

## 요약
`
  const findings = parseFindings(report)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].location.unverified, true)
})
