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
