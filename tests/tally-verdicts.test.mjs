import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 교차검증 결과를 모델이 손으로 세지 않게 한다.
//
// 2026-09-11 실행은 `crossverify.end`를 `upheld:13, rejected:3`으로 적고,
// 44초 뒤 `upheld:12, rejected:4`로 정정했다. 후보 수는 이미 스크립트가
// 결정적으로 내는데 검증 결과만 눈으로 세고 있었다. 같은 논증이 여기에도 그대로
// 적용된다 — 숫자가 맞더라도 그것이 결정적으로 계산된 것인지 알 수 없다.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(ROOT, 'scripts', 'tally-verdicts.mjs')
const RUN = 'code-review-full-feat-x-2026-09-11'

const started = t => {
  const dir = mkdtempSync(join(tmpdir(), 'tally-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, '.timing'), { recursive: true })
  writeFileSync(join(dir, '.timing', `${RUN}.jsonl`), `${JSON.stringify({
    at: '2026-09-11T00:00:00.000Z', seq: 1, phase: 'run.start',
    host: 'test', rules: 'review-rules', version: '2.13.0', branch: 'b', changedFiles: 68,
  })}\n`, 'utf8')
  return dir
}

const verdict = (candidateId, disposition) => ({
  candidateId, disposition, evidence: '확인했습니다',
  location: { kind: 'verified', path: 'src/a.ts', line: 1, quote: 'q' },
  ...(disposition === 'rejected' ? { rebuttal: { kind: 'other', note: '분류 밖' } } : {}),
  ...(disposition === 'needs-context' ? { reason: '파일 밖을 봐야 합니다' } : {}),
})

const tally = (dir, payload, extra = []) => {
  const input = join(dir, 'verdicts.json')
  writeFileSync(input, JSON.stringify(payload), 'utf8')
  return spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--input', input, ...extra],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

const timelineOf = dir => readFileSync(join(dir, '.timing', `${RUN}.jsonl`), 'utf8')
  .split('\n').filter(Boolean).map(line => JSON.parse(line))

test('disposition별로 센다', t => {
  const dir = started(t)
  const out = tally(dir, { schemaVersion: 1, verdicts: [
    verdict('04-3#1', 'upheld'), verdict('17-1#1', 'upheld'), verdict('16-1#1', 'rejected'),
  ] })
  assert.equal(out.status, 0, out.stderr)
  const counts = JSON.parse(out.stdout)
  assert.equal(counts.upheld, 2)
  assert.equal(counts.rejected, 1)
  assert.equal(counts.needsContext, 0)
  assert.equal(counts.total, 3)
})

test('여러 검증 작업의 출력을 함께 센다', t => {
  // bundle verifier와 isolated verifier가 각자 payload를 낸다. 둘을 합쳐 세는
  // 것이 모델이 하던 일이고, 그 합산이 틀렸던 자리다.
  const dir = started(t)
  const out = tally(dir, [
    { schemaVersion: 1, verdicts: [verdict('04-3#1', 'upheld')] },
    { schemaVersion: 1, verdicts: [verdict('16-1#1', 'rejected'), verdict('18-2#1', 'rejected')] },
  ])
  const counts = JSON.parse(out.stdout)
  assert.equal(counts.upheld, 1)
  assert.equal(counts.rejected, 2)
  assert.equal(counts.total, 3)
})

test('같은 후보를 두 번 판정하면 나중 것이 정본이고 그 사실을 낸다', t => {
  // bundle이 needs-context로 돌린 후보는 isolated로 승격돼 다시 판정된다.
  // 두 줄을 다 세면 total이 부풀고, 첫 줄을 세면 판정이 뒤집힌 것을 놓친다.
  const dir = started(t)
  const out = tally(dir, [
    { schemaVersion: 1, verdicts: [verdict('EX-4#1', 'needs-context')] },
    { schemaVersion: 1, verdicts: [verdict('EX-4#1', 'rejected')] },
  ])
  const counts = JSON.parse(out.stdout)
  assert.equal(counts.total, 1)
  assert.equal(counts.rejected, 1)
  assert.equal(counts.needsContext, 0)
  assert.equal(counts.reverdicted, 1)
})

test('counts를 crossverify.end로 직접 남긴다', t => {
  const dir = started(t)
  tally(dir, { schemaVersion: 1, verdicts: [verdict('04-3#1', 'upheld'), verdict('16-1#1', 'rejected')] },
    ['--malformed-tasks-corrected', '3'])
  const last = timelineOf(dir).at(-1)
  assert.equal(last.phase, 'crossverify.end')
  assert.equal(last.upheld, 1)
  assert.equal(last.rejected, 1)
  assert.equal(last.needsContext, 0)
  assert.equal(last.malformedTasksCorrected, 3)
  assert.equal(last.countsFrom, 'tally-verdicts.mjs')
})

test('알 수 없는 disposition은 조용히 버리지 않는다', t => {
  const dir = started(t)
  const out = tally(dir, { schemaVersion: 1, verdicts: [{ candidateId: 'x#1', disposition: 'confirmed', evidence: 'e' }] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /confirmed/)
})

test('candidateId가 없는 verdict는 셀 수 없다고 말한다', t => {
  const dir = started(t)
  const out = tally(dir, { schemaVersion: 1, verdicts: [{ disposition: 'upheld', evidence: 'e' }] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /candidateId/)
})

test('run.start가 없으면 세지 않는다', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tally-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const out = tally(dir, { schemaVersion: 1, verdicts: [] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /run\.start/)
})
