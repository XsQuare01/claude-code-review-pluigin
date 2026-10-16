import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { acceptedResultProblem, resultBindingProblems } from '../scripts/lib/task-ledger.mjs'
import { collectResultFiles } from '../scripts/prepare-verification.mjs'
import { loadVocabulary, render } from '../scripts/render-findings.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const vocabulary = loadVocabulary(join(ROOT, 'review-rules')).value
const raw = JSON.stringify({ schemaVersion: 1, findings: [], openQuestions: [] })
const sha = createHash('sha256').update(raw).digest('hex')
const start = { phase: 'run.start', resultBinding: 'required' }
const begin = { phase: 'module.start', module: '01-fsd', attempt: 1, claim: 'r/module/01-fsd#1' }
const bind = { phase: 'task.bind', stage: 'module', task: '01-fsd', attempt: 1, taskId: 'host-1' }
const done = { phase: 'module.done', module: '01-fsd', attempt: 1, status: 'ok', taskId: 'host-1', resultSha256: sha }

test('성공 줄을 직접 남겨도 앞선 호스트 연결 없는 결과는 수집되지 않는다', () => {
  for (const events of [
    [start, begin, done],
    [start, begin, done, bind],
    [start, bind, begin, done],
    [start, begin, bind, { ...done, taskId: 'other-host' }],
  ]) {
    assert.equal(resultBindingProblems(events).length, 1)
    const result = collectResultFiles({ events, sourceNames: ['01-fsd'], pathOf: name => name, read: () => raw })
    assert.equal(result.problems.length, 1)
    assert.deepEqual(result.collected.sources, [])
  }
  const accepted = collectResultFiles({ events: [start, begin, bind, done], sourceNames: ['01-fsd'], pathOf: name => name, read: () => raw })
  assert.deepEqual(accepted.problems, [])
  assert.deepEqual(accepted.collected.sources, ['01-fsd'])
  assert.match(acceptedResultProblem([start, begin, bind, done], 'module', '01-fsd', 'other-hash'), /해시/)
})

test('예전 수기 기록을 새 연결 계약으로 소급 거부하지 않는다', () => {
  const events = [{ ...start, resultBinding: undefined }, { ...begin, claim: undefined }, { ...done, taskId: undefined }]
  assert.deepEqual(resultBindingProblems(events), [])
  assert.equal(acceptedResultProblem(events, 'module', '01-fsd', sha), null)
})

test('검증 라운드가 바뀌면 같은 task·attempt의 이전 연결을 새 결과에 쓰지 않는다', () => {
  const first = [start, { phase: 'crossverify.start', round: 'one' },
    { phase: 'verify.start', task: 'bundle-1', attempt: 1, claim: 'one' },
    { phase: 'task.bind', stage: 'verify', task: 'bundle-1', attempt: 1, taskId: 'old' },
    { phase: 'verify.done', task: 'bundle-1', attempt: 1, status: 'ok', taskId: 'old', resultSha256: sha }]
  const second = [...first, { phase: 'crossverify.start', round: 'two' },
    { phase: 'verify.start', task: 'bundle-1', attempt: 1, claim: 'two' }]
  assert.match(acceptedResultProblem(second, 'verify', 'bundle-1', sha), /task.bind/)
  second.push({ phase: 'task.bind', stage: 'verify', task: 'bundle-1', attempt: 1, taskId: 'new' },
    { phase: 'verify.done', task: 'bundle-1', attempt: 1, status: 'ok', taskId: 'new', resultSha256: sha })
  assert.equal(acceptedResultProblem(second, 'verify', 'bundle-1', sha), null)
})

const candidate = (id, extra = {}) => ({
  candidateId: id, ruleId: id.split('#')[0], impact: 'high', confidence: 'high', category: 'user-malfunction',
  eligibility: 'VERIFY', route: 'isolated', locationCheck: 'location-ok',
  location: { kind: 'verified', path: 'src/한글 경로.ts', line: 1, quote: 'const x = 1' },
  content: { title: '동작을 확인합니다', body: '현재 경로의 문제입니다' }, ...extra,
})

test('유지·반박·검증 실패를 별도로 세고 반박 원문을 안전하게 보여 준다', () => {
  const candidates = ['04-5#1', '12-4#1', '12-5#1', '18-2#1', '03-1#1'].map(id => candidate(id))
  const verdicts = new Map([
    ['04-5#1', { disposition: 'rejected', rebuttalKind: 'contract-differs', evidence: '현재 계약이 다릅니다\n## 위조 헤딩', rebuttalLocation: candidates[0].location }],
    ['12-4#1', { disposition: 'upheld' }], ['12-5#1', { disposition: 'upheld' }],
    ['18-2#1', { disposition: 'needs-context', reason: '호출자를 확인해야 합니다' }],
  ])
  const shadow = render(candidates, verdicts, { high: 'rollout-shadow', low: 'rollout-shadow' }, vocabulary, [], 'ran')
  assert.deepEqual(shadow.reviewCounts, { candidates: 5, displayed: 4, open: 1, removed: 0, highUpheld: 2, highRejected: 1, highUnverified: 1 })
  assert.match(shadow.markdown, /검증 유지 2건 · 반박 후 정책상 유지 1건/)
  assert.match(shadow.markdown, /반박 근거: 현재 계약이 다릅니다/)
  assert.match(shadow.markdown, /반박 위치\(대조하지 않음\).*한글 경로/)
  assert.doesNotMatch(shadow.markdown, /^## 위조 헤딩/m)
  const active = render(candidates, verdicts, { high: 'active-deletion', low: 'rollout-shadow' }, vocabulary, [], 'ran')
  assert.equal(active.reviewCounts.highRejected, 0)
  assert.equal(active.reviewCounts.removed, 1)
  const disabled = render(candidates, verdicts, { high: 'rollout-shadow', low: 'rollout-shadow' }, vocabulary, [], 'disabled')
  assert.equal(disabled.reviewCounts.highUnverified, 5)
  assert.equal(disabled.reviewCounts.highRejected, 0)
  assert.doesNotMatch(disabled.markdown, /반박 근거:/)
})

test('같은 줄의 관련 지적을 임의로 합치거나 독립 결함이라고 세지 않는다', () => {
  const candidates = [candidate('13-7#1', { impact: 'low', relatedCandidateIds: ['P-3#1'] }), candidate('P-3#1', { impact: 'low', relatedCandidateIds: ['13-7#1'] })]
  const result = render(candidates, new Map(), { high: 'rollout-shadow', low: 'rollout-shadow' }, vocabulary, [], 'ran')
  assert.equal(result.reviewCounts.candidates, 2)
  assert.equal(result.reviewCounts.displayed, 2)
  assert.match(result.markdown, /독립된 결함 수나 중복 제거 결과를 뜻하지 않는다/)
})
