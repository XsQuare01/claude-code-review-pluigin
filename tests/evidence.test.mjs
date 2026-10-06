import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  assessEntry, classifyOutcome, compareSides, entryProblems, evidenceDocProblems, executionUsability,
  EVIDENCE_SCHEMA_VERSION, parseEvidenceDoc,
} from '../scripts/lib/evidence.mjs'

// 지적별 재현 근거(#88 PR 2)의 판정 규칙을 고정한다.
//
// 지켜야 하는 것(#88 PR 2 완료 기준):
// 1. 실행하지 않은 분석에 `executed`를 붙일 수 없다 — 스크립트가 남긴 실행 기록이 있어야 한다
// 2. 다른 대상(다른 HEAD·작업 트리·실행)에서 돈 재현은 이 지적의 실행 근거가 아니다
// 3. 환경 실패·미실행·재현 실패는 서로 다르고, 셋 다 결함의 반증이 아니다

const RUN = { runId: '11111111-2222-4333-8444-555555555555', head: 'a'.repeat(40), worktree: 'clean', mergeBase: 'b'.repeat(40) }
const SHA = 'c'.repeat(64)

const record = extra => ({
  schemaVersion: EVIDENCE_SCHEMA_VERSION, kind: 'review-execution',
  id: 'exec-1', runId: RUN.runId, candidateId: 'CR-1#1', side: 'head',
  command: ['node', 'repro.js'], shell: false, cwd: '.',
  startedAt: '2026-10-06T00:00:00.000Z', durationMs: 10,
  exit: 1, signal: null, timedOut: false, spawnError: null,
  expect: { exit: [1], output: null },
  outcome: 'reproduced', outcomeReason: '종료 코드 1은 결함이 재현됐다는 뜻으로 지정한 코드다',
  target: { head: RUN.head, worktree: 'clean', dirtyFiles: 0 },
  targetAfter: { head: RUN.head, worktree: 'clean', dirtyFiles: 0 },
  mutatedTree: false,
  artifact: { path: 'run.evidence/exec-1.log', sha256: SHA, bytes: 10 },
  ...extra,
})

// ------------------------------------------------------------ 결과 분류

test('지정한 종료 코드와 출력이 맞으면 재현됨이다', () => {
  assert.equal(classifyOutcome({ exit: 1, output: 'BUG: stale', expectExit: [1], expectOutput: 'BUG' }).outcome, 'reproduced')
  assert.equal(classifyOutcome({ exit: 1, output: '', expectExit: [1] }).outcome, 'reproduced')
})

test('0으로 끝나면 재현 안 됨이다 — 반증과는 다른 값이다', () => {
  assert.equal(classifyOutcome({ exit: 0, output: '', expectExit: [1] }).outcome, 'not-reproduced')
  // 0이 "재현"으로 지정됐는데 출력이 없으면 재현 안 됨
  assert.equal(classifyOutcome({ exit: 0, output: 'ok', expectExit: [0], expectOutput: 'BUG' }).outcome, 'not-reproduced')
})

test('예상하지 않은 종료 코드는 판단 불가다 — 결함으로도 정상으로도 읽지 않는다', () => {
  assert.equal(classifyOutcome({ exit: 2, output: '', expectExit: [1] }).outcome, 'inconclusive')
  // 지정한 코드로 끝났지만 지정한 출력이 없다 — 다른 이유로 실패했을 수 있다
  assert.equal(classifyOutcome({ exit: 1, output: 'TypeError', expectExit: [1], expectOutput: 'BUG' }).outcome, 'inconclusive')
})

test('시작하지 못했거나, 시간을 넘겼거나, 신호로 죽으면 환경 실패다', () => {
  assert.equal(classifyOutcome({ spawnError: 'ENOENT', expectExit: [1] }).outcome, 'env-failure')
  assert.equal(classifyOutcome({ timedOut: true, exit: null, signal: 'SIGTERM', expectExit: [1] }).outcome, 'env-failure')
  assert.equal(classifyOutcome({ exit: null, signal: 'SIGKILL', expectExit: [1] }).outcome, 'env-failure')
})

// ------------------------------------------------------------ 실행 기록을 근거로 쓸 수 있는가

test('이 실행의 같은 대상에서, 로그가 그대로이고 트리를 바꾸지 않은 기록만 쓴다', () => {
  assert.deepEqual(executionUsability(record(), { run: RUN, artifactSha256: SHA }), { usable: true })
  const cases = [
    [record({ runId: '99999999-2222-4333-8444-555555555555' }), SHA, 'other-run'],
    [record({ target: { head: 'd'.repeat(40), worktree: 'clean', dirtyFiles: 0 } }), SHA, 'other-target'],
    [record({ target: { head: RUN.head, worktree: `sha256:${'e'.repeat(64)}`, dirtyFiles: 1 } }), SHA, 'other-target'],
    [record({ mutatedTree: true }), SHA, 'tree-mutated'],
    [record(), null, 'artifact-missing'],
    [record(), 'f'.repeat(64), 'artifact-changed'],
  ]
  for (const [entry, sha, reason] of cases) {
    assert.equal(executionUsability(entry, { run: RUN, artifactSha256: sha }).reason, reason)
  }
})

test('base 쪽 기록은 merge-base의 깨끗한 트리에서 돈 것만 쓴다', () => {
  const base = record({ side: 'base', target: { head: RUN.mergeBase, worktree: 'clean', dirtyFiles: 0 }, targetAfter: { head: RUN.mergeBase, worktree: 'clean', dirtyFiles: 0 } })
  assert.equal(executionUsability(base, { run: RUN, artifactSha256: SHA }).usable, true)
  const atHead = record({ side: 'base' })
  assert.equal(executionUsability(atHead, { run: RUN, artifactSha256: SHA }).reason, 'other-target')
})

// ------------------------------------------------------------ 기존 결함과 신규 회귀

test('base 비교는 양쪽을 실제로 잰 경우에만 결론을 낸다 — 미측정을 정상으로 읽지 않는다', () => {
  const reproduced = { usable: true, outcome: 'reproduced' }
  assert.equal(compareSides(reproduced, { usable: true, outcome: 'reproduced' }), 'pre-existing')
  assert.equal(compareSides(reproduced, { usable: true, outcome: 'not-reproduced' }), 'new-regression')
  assert.equal(compareSides(reproduced, null), 'base-unmeasured')
  assert.equal(compareSides(reproduced, { usable: true, outcome: 'env-failure' }), 'base-unmeasured')
  assert.equal(compareSides(reproduced, { usable: false, outcome: 'not-reproduced' }), 'base-unmeasured')
  assert.equal(compareSides({ usable: true, outcome: 'not-reproduced' }, { usable: true, outcome: 'not-reproduced' }), null)
})

// ------------------------------------------------------------ 항목

const known = new Set(['CR-1#1', '04-3#1'])
const usable = new Map([['exec-1', { record: record(), usability: { usable: true } }]])

test('코드 경로 분석은 조건·절차·기대·관찰을 다 적는다', () => {
  const entry = { candidateId: '04-3#1', method: 'static-trace', condition: 'c', procedure: 'p', expected: 'e', observed: 'o' }
  assert.deepEqual(entryProblems(entry, { candidateIds: known, executions: usable }), [])
  assert.ok(entryProblems({ ...entry, observed: '' }, { candidateIds: known, executions: usable }).some(problem => /observed/.test(problem)))
})

test('미실행은 사유를 적는다', () => {
  assert.deepEqual(entryProblems({ candidateId: '04-3#1', method: 'not-run', reason: '테스트 환경이 없다' }, { candidateIds: known, executions: usable }), [])
  assert.ok(entryProblems({ candidateId: '04-3#1', method: 'not-run' }, { candidateIds: known, executions: usable }).some(problem => /reason/.test(problem)))
})

test('실행 기록 없이 executed를 붙일 수 없다', () => {
  const base = { candidateId: 'CR-1#1', method: 'executed', condition: 'c', expected: 'e' }
  assert.ok(entryProblems(base, { candidateIds: known, executions: usable }).some(problem => /executions/.test(problem)))
  assert.ok(entryProblems({ ...base, executions: ['exec-9'] }, { candidateIds: known, executions: usable }).some(problem => /exec-9/.test(problem)))
  assert.deepEqual(entryProblems({ ...base, executions: ['exec-1'] }, { candidateIds: known, executions: usable }), [])
})

test('다른 지적의 실행 기록이나 쓸 수 없는 기록으로는 executed를 붙일 수 없다', () => {
  const other = new Map([['exec-1', { record: record({ candidateId: '04-3#1' }), usability: { usable: true } }]])
  const entry = { candidateId: 'CR-1#1', method: 'executed', condition: 'c', expected: 'e', executions: ['exec-1'] }
  assert.ok(entryProblems(entry, { candidateIds: known, executions: other }).some(problem => /04-3#1/.test(problem)))
  const stale = new Map([['exec-1', { record: record(), usability: { usable: false, reason: 'other-target' } }]])
  assert.ok(entryProblems(entry, { candidateIds: known, executions: stale }).some(problem => /쓸 수 있는/.test(problem)))
})

test('모르는 지적, 모르는 방법, 계약 밖 키는 거부한다', () => {
  const opts = { candidateIds: known, executions: usable }
  assert.ok(entryProblems({ candidateId: 'X-1#1', method: 'not-run', reason: 'r' }, opts).some(problem => /X-1#1/.test(problem)))
  assert.ok(entryProblems({ candidateId: '04-3#1', method: 'guessed', reason: 'r' }, opts).some(problem => /method/.test(problem)))
  assert.ok(entryProblems({ candidateId: '04-3#1', method: 'not-run', reason: 'r', confidence: 'high' }, opts).some(problem => /confidence/.test(problem)))
})

// ------------------------------------------------------------ 항목 평가

test('executed 항목은 쓸 수 있는 HEAD 기록과 base 기록으로 평가한다', () => {
  const base = record({ id: 'exec-2', side: 'base', outcome: 'not-reproduced', exit: 0, target: { head: RUN.mergeBase, worktree: 'clean', dirtyFiles: 0 } })
  const executions = new Map([
    ['exec-1', { record: record(), usability: { usable: true } }],
    ['exec-2', { record: base, usability: { usable: true } }],
  ])
  const assessed = assessEntry({ candidateId: 'CR-1#1', method: 'executed', condition: 'c', expected: 'e', executions: ['exec-1', 'exec-2'] }, executions)
  assert.equal(assessed.head.outcome, 'reproduced')
  assert.equal(assessed.base.outcome, 'not-reproduced')
  assert.equal(assessed.comparison, 'new-regression')
})

test('쓸 수 있는 HEAD 기록이 없는 executed 항목은 실행 근거로 평가하지 않는다', () => {
  const executions = new Map([['exec-1', { record: record(), usability: { usable: false, reason: 'other-target' } }]])
  const assessed = assessEntry({ candidateId: 'CR-1#1', method: 'executed', condition: 'c', expected: 'e', executions: ['exec-1'] }, executions)
  assert.equal(assessed.head.usable, false)
  assert.equal(assessed.head.reason, 'other-target')
  assert.equal(assessed.comparison, null)
})

// ------------------------------------------------------------ 근거 파일

test('근거 파일은 버전·실행 식별·항목 배열을 가진다. 잘리거나 모르는 버전이면 읽지 않는다', () => {
  const doc = { schemaVersion: 1, kind: 'review-evidence', run: RUN, entries: [] }
  assert.deepEqual(evidenceDocProblems(doc), [])
  assert.ok(parseEvidenceDoc(JSON.stringify(doc)).value)
  assert.match(parseEvidenceDoc(JSON.stringify({ ...doc, schemaVersion: 2 })).error, /schemaVersion 2/)
  assert.ok(parseEvidenceDoc(JSON.stringify(doc).slice(0, 20)).error)
  assert.ok(parseEvidenceDoc('').error)
})
