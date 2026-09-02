import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  candidatesFromResults,
  dedupKey,
  exactDedup,
  normalizeRuleId,
} from '../scripts/prepare-verification.mjs'

// 계약이 요구하는 순서 — 위치 대조 → exact dedup → candidate ID — 중 가운데가
// 구현돼 있지 않았다. 흐름도와 주석은 "스크립트가 exact dedup을 한다"고 적었지만
// `candidatesFromResults`는 모든 finding을 그대로 candidate로 만들었다.
//
// 2.8.0 실행에서 같은 규칙이 `17-3 (1/3)`·`(2/3)`·`(3/3)`으로 갈라져 들어왔고,
// 셋은 서로 다른 rule id라 묶이지도 않았다. 그 id가 그대로 `17-3 (1/3)#1` 같은
// candidateId가 되어 어느 규칙 문서에도 없는 식별자로 리포트에 나갔다.

const finding = (over = {}) => ({
  ruleId: '17-3',
  title: '경쟁 조건',
  body: '두 이펙트가 같은 상태를 쓴다',
  impact: 'high',
  confidence: 'high',
  category: 'correctness',
  location: { kind: 'verified', path: 'src/a.tsx', line: 10, quote: 'x' },
  ...over,
})

// ── rule id 정규화 ─────────────────────────────────────────────────────────

test('producer가 붙인 instance 표기를 떼고 무엇을 고쳤는지 남긴다', () => {
  assert.deepEqual(normalizeRuleId('17-3 (1/3)'), { ruleId: '17-3', repairedFrom: '17-3 (1/3)' })
  assert.deepEqual(normalizeRuleId('17-3 (10/12)'), { ruleId: '17-3', repairedFrom: '17-3 (10/12)' })
})

test('정상 id는 건드리지 않는다', () => {
  for (const id of ['17-3', '10-SSOT', 'EX-2', 'P-3', 'A-1', 'CR-4']) {
    assert.deepEqual(normalizeRuleId(id), { ruleId: id, repairedFrom: null })
  }
})

test('떼어내도 유효한 id가 아니면 고치지 않는다', () => {
  // 조용히 그럴듯한 id를 만들어내는 것이 원래 문제보다 나쁘다.
  assert.deepEqual(normalizeRuleId('무언가 (1/3)'), { ruleId: '무언가 (1/3)', repairedFrom: null })
})

test('빈 id는 unknown으로 남긴다', () => {
  assert.equal(normalizeRuleId(undefined).ruleId, 'unknown')
})

// ── dedup key ──────────────────────────────────────────────────────────────

test('unverified 위치는 자동 병합하지 않는다', () => {
  // anchor가 없으므로 서술이 같다는 것만으로 같은 사실이라고 단정하지 않는다.
  assert.equal(dedupKey(finding({ location: { kind: 'unverified', reason: '확인 못 함' } })), null)
})

test('삭제 위치는 lineBefore로 키를 만든다', () => {
  const key = dedupKey(finding({ location: { kind: 'deleted', path: 'src/a.tsx', lineBefore: 4 } }))
  assert.ok(key)
  assert.match(key, /"deleted"/)
})

test('축이 하나라도 다르면 다른 키다', () => {
  const base = dedupKey(finding())
  for (const over of [
    { ruleId: '17-4' },
    { impact: 'low' },
    { confidence: 'low' },
    { category: 'clarity' },
    { title: '다른 제목' },
    { body: '다른 본문' },
    { location: { kind: 'verified', path: 'src/b.tsx', line: 10 } },
    { location: { kind: 'verified', path: 'src/a.tsx', line: 11 } },
  ]) {
    assert.notEqual(dedupKey(finding(over)), base, JSON.stringify(over))
  }
})

// ── 병합 ───────────────────────────────────────────────────────────────────

test('글자까지 같은 finding만 합치고 instance를 전부 남긴다', () => {
  const { findings, merged } = exactDedup([finding(), finding(), finding()])
  assert.equal(findings.length, 1)
  assert.equal(merged, 2)
  assert.deepEqual(findings[0].memberInstanceIds, ['i1', 'i2', 'i3'])
})

test('표현만 비슷하면 합치지 않는다', () => {
  // 같은 말을 다르게 쓴 둘을 코드가 같다고 단정하면, 비교되지 않은 주장이 사라진다.
  const { findings, merged } = exactDedup([finding(), finding({ body: '같은 말을 다르게' })])
  assert.equal(findings.length, 2)
  assert.equal(merged, 0)
})

test('병합해도 기여한 source label을 잃지 않는다', () => {
  const { findings } = exactDedup([
    finding({ source: 'general' }),
    finding({ source: 'props' }),
  ])
  assert.equal(findings.length, 1)
  assert.deepEqual(findings[0].sources, ['general', 'props'])
})

test('unverified는 여러 건이어도 각각 남는다', () => {
  const unverified = finding({ location: { kind: 'unverified', reason: 'x' } })
  const { findings, merged } = exactDedup([unverified, unverified])
  assert.equal(findings.length, 2)
  assert.equal(merged, 0)
})

// ── 실제로 관측된 입력 ─────────────────────────────────────────────────────

test('갈라진 instance id가 하나의 규칙으로 다시 묶인다', () => {
  // 2.8.0 실행에서 들어온 모양 그대로.
  const candidates = candidatesFromResults([{
    findings: [
      finding({ ruleId: '17-3 (1/3)', location: { kind: 'verified', path: 'src/a.tsx', line: 10 } }),
      finding({ ruleId: '17-3 (2/3)', location: { kind: 'verified', path: 'src/b.tsx', line: 20 } }),
      finding({ ruleId: '17-3 (3/3)', location: { kind: 'verified', path: 'src/c.tsx', line: 30 } }),
    ],
  }])

  assert.deepEqual(candidates.map(c => c.candidateId), ['17-3#1', '17-3#2', '17-3#3'])
  assert.deepEqual([...new Set(candidates.map(c => c.ruleId))], ['17-3'])
  assert.equal(candidates.ruleIdRepairs.length, 3)
  assert.deepEqual(candidates.ruleIdRepairs[0], { from: '17-3 (1/3)', to: '17-3' })
})

test('중복이 verifier로 나가기 전에 줄어든다', () => {
  // 검증은 exact dedup 이후에 한다 — 같은 결함을 여러 번 반박하는 낭비를 막는다.
  const candidates = candidatesFromResults([
    { findings: [finding()] },
    { findings: [finding()] },
  ])
  assert.equal(candidates.length, 1)
  assert.equal(candidates.dedupMerged, 1)
  assert.deepEqual(candidates[0].memberInstanceIds, ['i1', 'i2'])
})

test('합친 건수를 숨기지 않는다', () => {
  // 후보 수가 줄어든 이유가 보이지 않으면 producer가 덜 찾은 것으로 읽힌다.
  const none = candidatesFromResults([{ findings: [finding()] }])
  assert.equal(none.dedupMerged, 0)
  assert.deepEqual(none.ruleIdRepairs, [])
})
