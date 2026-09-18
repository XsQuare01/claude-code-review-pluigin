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

// ── 판정을 받지 못한 후보 ──────────────────────────────────────────────────
//
// 2026-09-18 실행이 대상 16건을 잡고 판정 13건을 남겼다. 나머지 3건은 verifier가
// 두 차례 타임아웃해 판정이 없었는데, 그 사실이 리포트 산문에만 있고 기록에는
// 없었다. 사이드카만 읽으면 3건이 증발한 것으로 보인다.

const withScriptDone = (dir, verify) => {
  const path = join(dir, '.timing', `${RUN}.jsonl`)
  writeFileSync(path, readFileSync(path, 'utf8') + `${JSON.stringify({
    at: '2026-09-11T00:01:00.000Z', seq: 2, phase: 'script.done', ran: true,
    counts: { total: 35, verify, skipVerify: 19, bundle: 3, isolated: 13 },
  })}\n`, 'utf8')
  return dir
}

test('판정을 못 받은 후보 수를 script.done의 대상 수에서 뺄셈으로 낸다', t => {
  const dir = withScriptDone(started(t), 4)
  const out = tally(dir, { verdicts: [verdict('c1', 'upheld'), verdict('c2', 'upheld')] })
  assert.equal(out.status, 0, out.stderr)
  const line = timelineOf(dir).at(-1)
  assert.equal(line.phase, 'crossverify.end')
  assert.equal(line.upheld, 2)
  assert.equal(line.noVerdict, 2)
})

test('전부 판정됐으면 0을 적는다 — 미측정과 구분한다', t => {
  const dir = withScriptDone(started(t), 2)
  const out = tally(dir, { verdicts: [verdict('c1', 'upheld'), verdict('c2', 'rejected')] })
  assert.equal(out.status, 0, out.stderr)
  const line = timelineOf(dir).at(-1)
  assert.equal(line.noVerdict, 0)
})

test('대상 수를 읽지 못하면 noVerdict를 만들지 않는다', t => {
  // script.done이 없으면 뺄셈의 한쪽이 없다. 0으로 채우면 "전부 판정됐다"는
  // 주장이 되는데, 그것은 재지 않은 값이다.
  const dir = started(t)
  const out = tally(dir, { verdicts: [verdict('c1', 'upheld')] })
  assert.equal(out.status, 0, out.stderr)
  const line = timelineOf(dir).at(-1)
  assert.equal(line.noVerdict, undefined)
})

test('재판정이 있어도 후보 단위로 빼서 센다', t => {
  // 같은 후보가 bundle에서 needs-context, isolated에서 upheld를 받으면 판정은
  // 둘이지만 후보는 하나다. 판정 수로 빼면 대상이 남아돌지 않는데도 남는다.
  const dir = withScriptDone(started(t), 2)
  const out = tally(dir, { verdicts: [verdict('c1', 'needs-context'), verdict('c1', 'upheld')] })
  assert.equal(out.status, 0, out.stderr)
  const line = timelineOf(dir).at(-1)
  assert.equal(line.upheld, 1)
  assert.equal(line.noVerdict, 1)
})

// ── 대상을 ID로 본다 ───────────────────────────────────────────────────────
//
// 개수만 맞추면 다른 후보가 누락을 가린다. 대상이 A·B인데 verdict가 A·X로 오면
// 대상 2 · 판정 2 · noVerdict 0이 되어 검사를 통과하고, 정작 B는 사라진다.

const routedFile = (dir, entries) => {
  const path = join(dir, 'routed.json')
  writeFileSync(path, JSON.stringify({ candidates: entries }), 'utf8')
  return path
}

test('--targets는 빠진 대상을 ID로 가려낸다', t => {
  const dir = withScriptDone(started(t), 2)
  const targets = routedFile(dir, [
    { candidateId: 'A', route: 'isolated' },
    { candidateId: 'B', route: 'bundle' },
  ])
  const out = tally(dir, { verdicts: [verdict('A', 'upheld')] }, ['--targets', targets])
  assert.equal(out.status, 0, out.stderr)
  assert.equal(timelineOf(dir).at(-1).noVerdict, 1)
})

test('--targets는 대상 밖 후보의 판정을 거부한다', t => {
  // 개수만 보면 통과하는 바로 그 기록이다: 대상 2 · 판정 2 · noVerdict 0.
  const dir = withScriptDone(started(t), 2)
  const targets = routedFile(dir, [
    { candidateId: 'A', route: 'isolated' },
    { candidateId: 'B', route: 'isolated' },
  ])
  const out = tally(dir, { verdicts: [verdict('A', 'upheld'), verdict('X', 'upheld')] }, ['--targets', targets])
  assert.equal(out.status, 2)
  assert.match(out.stderr, /검증 대상이 아닌 후보의 판정이 있다.*X/)
})

test('--targets는 route가 none인 후보를 대상으로 세지 않는다', t => {
  // 띄우지 않은 것을 "판정을 못 받았다"로 세면 정상 실행마다 값이 부푼다.
  const dir = withScriptDone(started(t), 1)
  const targets = routedFile(dir, [
    { candidateId: 'A', route: 'isolated' },
    { candidateId: 'B', route: 'none' },
  ])
  const out = tally(dir, { verdicts: [verdict('A', 'upheld')] }, ['--targets', targets])
  assert.equal(out.status, 0, out.stderr)
  assert.equal(timelineOf(dir).at(-1).noVerdict, 0)
})

test('--targets 없이 센 noVerdict에는 그 한계를 적는다', t => {
  // 숫자만 보면 두 방식의 결과가 같아 보인다.
  const dir = withScriptDone(started(t), 3)
  const out = tally(dir, { verdicts: [verdict('A', 'upheld')] })
  assert.equal(out.status, 0, out.stderr)
  const line = timelineOf(dir).at(-1)
  assert.equal(line.noVerdict, 2)
  assert.match(line.note, /--targets 없이는 후보 ID 불일치를 잡지 못한다/)
})

test('--targets로 세면 그 한계 문구를 붙이지 않는다', t => {
  const dir = withScriptDone(started(t), 1)
  const targets = routedFile(dir, [{ candidateId: 'A', route: 'isolated' }])
  const out = tally(dir, { verdicts: [verdict('A', 'upheld')] }, ['--targets', targets])
  assert.equal(out.status, 0, out.stderr)
  assert.equal(timelineOf(dir).at(-1).note, undefined)
})

test('--targets에 대상이 하나도 없으면 거부한다', t => {
  const dir = withScriptDone(started(t), 1)
  const targets = routedFile(dir, [{ candidateId: 'A', route: 'none' }])
  const out = tally(dir, { verdicts: [verdict('A', 'upheld')] }, ['--targets', targets])
  assert.equal(out.status, 2)
  assert.match(out.stderr, /검증 대상이 없다/)
})

test('stdout에 판정 집합을 빈 객체로 흘리지 않는다', t => {
  // JSON.stringify는 Set을 {}로 내보낸다. 호출자에게 빈 값처럼 보인다.
  const dir = withScriptDone(started(t), 2)
  const out = tally(dir, { verdicts: [verdict('A', 'upheld')] })
  const printed = JSON.parse(out.stdout)
  assert.equal(printed.judged, undefined)
  assert.equal(printed.upheld, 1)
  assert.equal(printed.noVerdict, 1)
})
