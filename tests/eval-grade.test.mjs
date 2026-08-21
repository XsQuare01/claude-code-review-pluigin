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

test('C-7 골격 섹션이 다 있으면 통과한다', () => {
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
