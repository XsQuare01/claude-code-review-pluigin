import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildSnapshot, parseSnapshot, renderSnapshotMarkdown, snapshotProblems, writeSnapshotAtomic,
  SNAPSHOT_SCHEMA_VERSION,
} from '../scripts/lib/review-snapshot.mjs'

// 결과 스냅숏(#88 PR 0)을 고정한다 — 한 실행이 **무엇을** 리뷰했고, 어디까지 끝냈고,
// 무엇을 찾았는지를 한 파일에 담는다. 다음 기능(증분 재리뷰·판정 기록)이 이 파일을 읽는다.
//
// 이 파일이 지켜야 하는 것은 셋이다(#88 PR 0 완료 기준).
// 1. 같은 HEAD의 다른 작업 트리를 다른 대상으로 남긴다 — `run-identity.test.mjs`가 계산을,
//    여기서는 그 값이 스냅숏까지 오는지와 실행 도중 바뀐 것을 드러내는지를 본다
// 2. 잘리거나 모르는 버전의 파일을 빈 리뷰로 읽지 않고, 쓰다 실패해도 앞의 정상 파일을 남긴다
// 3. 완료·부분 완료·실패와 검토 범위가 JSON과 리포트에서 같다

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CATALOG = JSON.parse(readFileSync(join(ROOT, 'review-rules', 'catalog.json'), 'utf8'))

const RUN_ID = '11111111-2222-4333-8444-555555555555'
const HEAD = 'a'.repeat(40)
const WORKTREE = `sha256:${'b'.repeat(64)}`
const DIGEST = `sha256:${'c'.repeat(64)}`

const NUMBERED = CATALOG.modules
  .filter(module => module.role === 'module' && module.workflows.includes('full') && module.phaseByWorkflow?.full !== 'post-verification-synthesis')
  .map(module => module.path.replace(/\.md$/, ''))
const PASSES = ['props', 'math', 'exception']
// `correctness`는 선택 패스다. run.start에 `correctness: 'on'`이 없으면 적용 대상이 아니다.
const ALL = [...NUMBERED, ...PASSES]

const runStart = extra => ({
  at: '2026-10-06T00:00:00.000Z', seq: 1, phase: 'run.start',
  host: 'test', rules: '/rules', version: '2.16.0', branch: 'feat/x', changedFiles: 3,
  candidates: NUMBERED.length, workflow: 'full', mergeBase: 'd'.repeat(40),
  runId: RUN_ID, base: 'main', head: HEAD, worktree: WORKTREE, dirtyFiles: 2,
  repo: 'github.com/o/r', repoRoot: 'e'.repeat(40), rulesDigest: DIGEST,
  ...extra,
})
const done = (module, status = 'ok', attempt = 1, extra = {}) => ({ phase: 'module.done', module, attempt, status, ...extra })
const planned = (skipped = [], unknown = []) => ({ phase: 'modules.planned', candidates: NUMBERED.length, applied: 0, skipped, unknown })

const candidate = extra => ({
  candidateId: '04-3#1', ruleId: '04-3', impact: 'high', confidence: 'high', category: 'data-loss',
  eligibility: 'VERIFY', route: 'bundle', source: '04-state',
  location: { kind: 'verified', path: 'src/a.ts', line: 3, quote: 'const a = 1' },
  locationCheck: 'location-ok',
  content: { title: '제목', body: '본문은 스냅숏에 싣지 않는다', evidence: '근거' },
  memberInstanceIds: ['i1'],
  ...extra,
})

const fixture = (extra = {}) => ({
  name: 'code-review-full-feat-x-2026-10-06',
  events: [runStart(), planned([{ module: 'math', reasonCode: 'no-linear-algebra', reason: '행렬 연산이 없다' }]),
    ...ALL.filter(name => name !== 'math').map(name => done(name))],
  catalog: CATALOG,
  routed: { candidates: [candidate()], collected: { sources: ALL.filter(name => name !== 'math'), excludedFailed: [] } },
  verdicts: new Map([['04-3#1', { disposition: 'upheld' }]]),
  verificationState: 'ran',
  openQuestionsBySource: new Map([['04-state', [{ title: '열린 질문', body: 'b', location: { kind: 'unverified', reason: 'r' }, reason: '범위 미확인' }]]]),
  inputs: [{ role: 'timeline', path: '.timing/code-review-full-feat-x-2026-10-06.jsonl', sha256: 'f'.repeat(64) }],
  current: { head: HEAD, worktree: WORKTREE, dirtyFiles: 2, rulesDigest: DIGEST },
  now: '2026-10-06T01:00:00.000Z',
  ...extra,
})

test('모든 적용 모듈의 결과를 모았으면 완료다', () => {
  const snapshot = buildSnapshot(fixture())
  assert.deepEqual(snapshotProblems(snapshot), [])
  assert.equal(snapshot.schemaVersion, SNAPSHOT_SCHEMA_VERSION)
  assert.equal(snapshot.status, 'complete')
  assert.equal(snapshot.scope.counts.applied, ALL.length - 1)
  assert.equal(snapshot.scope.counts.skipped, 2, 'math와, 켜지 않은 선택 패스 correctness')
  const math = snapshot.scope.modules.find(module => module.name === 'math')
  assert.deepEqual(math, { name: 'math', kind: 'pass', state: 'skipped', reasonCode: 'no-linear-algebra', reason: '행렬 연산이 없다' })
})

test('실패·기록 없음·수집되지 않음이 하나라도 있으면 부분 완료다', () => {
  const events = [runStart(), planned(),
    ...ALL.filter(name => !['04-state', '12-accessibility', '20-deletion-regression'].includes(name)).map(name => done(name)),
    done('04-state', 'failed', 1, { failureClass: 'inactivity-timeout' }),
    done('04-state', 'failed', 2, { failureClass: 'malformed-output' }),
    // 12는 module.done이 없다. 20은 ok로 끝났는데 수집되지 않았다.
    done('20-deletion-regression', 'ok'),
  ]
  const collected = ALL.filter(name => !['04-state', '12-accessibility', '20-deletion-regression'].includes(name))
  const snapshot = buildSnapshot(fixture({ events, routed: { candidates: [], collected: { sources: collected, excludedFailed: [] } } }))
  assert.deepEqual(snapshotProblems(snapshot), [])
  assert.equal(snapshot.status, 'partial')
  const byName = new Map(snapshot.scope.modules.map(module => [module.name, module]))
  assert.deepEqual(byName.get('04-state'), { name: '04-state', kind: 'module', state: 'failed', attempt: 2, failureClass: 'malformed-output' })
  assert.deepEqual(byName.get('12-accessibility'), { name: '12-accessibility', kind: 'module', state: 'missing', reason: 'no-record' })
  assert.deepEqual(byName.get('20-deletion-regression'), { name: '20-deletion-regression', kind: 'module', state: 'missing', reason: 'not-collected' })
  assert.deepEqual(snapshot.scope.counts, { applied: ALL.length, ok: ALL.length - 3, failed: 1, missing: 2, skipped: 1, unknown: 0 })
})

test('성공한 모듈이 하나도 없으면 실패다', () => {
  const events = [runStart(), planned(), ...ALL.map(name => done(name, 'failed', 1, { failureClass: 'no-start' }))]
  const snapshot = buildSnapshot(fixture({ events, routed: { candidates: [], collected: { sources: [], excludedFailed: [] } }, verdicts: new Map() }))
  assert.equal(snapshot.status, 'failed')
  assert.equal(snapshot.scope.counts.ok, 0)
})

test('modules.planned가 없으면 후보 전부를 적용 대상으로 본다 — 건너뛴 사실을 지어내지 않는다', () => {
  const events = [runStart(), ...ALL.filter(name => name !== 'math').map(name => done(name))]
  const snapshot = buildSnapshot(fixture({ events }))
  assert.equal(snapshot.status, 'partial')
  assert.equal(snapshot.scope.modules.find(module => module.name === 'math').state, 'missing')
  assert.ok(snapshot.notes.some(note => /modules\.planned/.test(note)), snapshot.notes.join('\n'))
})

test('건너뛴 모듈은 마지막 modules.planned를 따르고, 번호 모듈은 두 자리로도 찾는다', () => {
  const events = [runStart(),
    planned([{ module: '21', reasonCode: 'no-rsc', reason: 'RSC 아님' }]),
    planned([{ module: '21-rsc', reasonCode: 'no-rsc', reason: 'RSC 아님' }], ['12-accessibility']),
    ...ALL.filter(name => !['21-rsc', '12-accessibility'].includes(name)).map(name => done(name))]
  const sources = ALL.filter(name => !['21-rsc', '12-accessibility'].includes(name))
  const snapshot = buildSnapshot(fixture({ events, routed: { candidates: [candidate()], collected: { sources, excludedFailed: [] } } }))
  const byName = new Map(snapshot.scope.modules.map(module => [module.name, module]))
  assert.equal(byName.get('21-rsc').state, 'skipped')
  assert.equal(byName.get('12-accessibility').state, 'unknown')
  assert.equal(snapshot.status, 'complete')
})

test('켜지 않은 선택 패스는 이유를 단 SKIPPED다 — 결과 없음으로 세지 않는다', () => {
  const snapshot = buildSnapshot(fixture())
  assert.deepEqual(snapshot.scope.modules.find(module => module.name === 'correctness'), {
    name: 'correctness', kind: 'pass', state: 'skipped', reasonCode: 'not-requested',
    reason: '선택 패스 — 이 실행은 --correctness on 없이 시작했다',
  })
  assert.equal(snapshot.status, 'complete')
})

test('켠 선택 패스는 적용 대상이다 — 결과가 없으면 부분 완료다', () => {
  const events = [runStart({ correctness: 'on' }), ...fixture().events.slice(1)]
  const missing = buildSnapshot(fixture({ events }))
  assert.deepEqual(missing.scope.modules.find(module => module.name === 'correctness'), { name: 'correctness', kind: 'pass', state: 'missing', reason: 'no-record' })
  assert.equal(missing.status, 'partial')

  const collected = ALL.filter(name => name !== 'math').concat('correctness')
  const done_ = buildSnapshot(fixture({
    events: [...events, done('correctness', 'failed', 1, { failureClass: 'inactivity-timeout' }), done('correctness', 'ok', 2)],
    routed: { candidates: [], collected: { sources: collected, excludedFailed: [] } },
    verdicts: new Map(),
  }))
  assert.deepEqual(done_.scope.modules.find(module => module.name === 'correctness'), { name: 'correctness', kind: 'pass', state: 'ok', attempt: 2 })
  assert.equal(done_.status, 'complete')
})

test('켜지 않은 선택 패스의 기록이 있으면 짚는다 — 모은 것으로 세지 않는다', () => {
  const events = [...fixture().events, done('correctness', 'ok', 1)]
  const snapshot = buildSnapshot(fixture({ events }))
  assert.equal(snapshot.scope.modules.find(module => module.name === 'correctness').state, 'skipped')
  assert.ok(snapshot.notes.some(note => /correctness/.test(note) && /켜지 않은/.test(note)), snapshot.notes.join(' / '))
})

test('앞 시도의 정정 줄이 뒤 시도의 성공을 덮지 않는다', () => {
  const events = [runStart(), planned([{ module: 'math', reasonCode: 'x', reason: 'y' }]),
    ...ALL.filter(name => !['math', '04-state'].includes(name)).map(name => done(name)),
    done('04-state', 'ERROR', 1),
    done('04-state', 'ok', 2),
    done('04-state', 'failed', 1, { note: '시도 1 정정' })]
  const snapshot = buildSnapshot(fixture({ events }))
  assert.equal(snapshot.scope.modules.find(module => module.name === '04-state').state, 'ok')
})

test('지적은 실행 범위의 ref로 남기고, candidateId를 실행 간 식별자로 쓰지 않는다', () => {
  const snapshot = buildSnapshot(fixture())
  const [finding] = snapshot.findings
  assert.equal(finding.ref, `${RUN_ID}/04-3#1`)
  assert.equal(finding.candidateId, '04-3#1')
  assert.equal(finding.disposition, 'upheld')
  assert.deepEqual(finding.sources, ['04-state'])
  assert.equal(finding.title, '제목')
  // 본문·근거는 routed 원본에 있고, 스냅숏은 그 파일을 digest로 가리킨다
  assert.equal(finding.body, undefined)
  assert.equal(finding.evidence, undefined)
})

test('disposition은 리포트와 같은 함수로 정한다 — 판정 없는 검증 대상은 검증 실패다', () => {
  const routed = {
    candidates: [
      candidate(),
      candidate({ candidateId: '04-3#2', eligibility: 'SKIP-VERIFY', route: 'none' }),
      candidate({ candidateId: '04-3#3' }),
      candidate({ candidateId: '04-3#4' }),
    ],
    collected: { sources: ALL.filter(name => name !== 'math'), excludedFailed: [] },
  }
  const verdicts = new Map([['04-3#1', { disposition: 'rejected', rebuttalKind: 'guarded' }], ['04-3#4', { disposition: 'needs-context' }]])
  const snapshot = buildSnapshot(fixture({ routed, verdicts }))
  assert.deepEqual(snapshot.findings.map(finding => [finding.candidateId, finding.disposition]), [
    ['04-3#1', 'rejected'], ['04-3#2', 'not-eligible'], ['04-3#3', 'verification-unavailable'], ['04-3#4', 'scope-open'],
  ])
  assert.equal(snapshot.findings[0].rebuttalKind, 'guarded')
  const disabled = buildSnapshot(fixture({ routed, verdicts: new Map(), verificationState: 'disabled' }))
  assert.deepEqual(disabled.findings.map(finding => finding.disposition), ['verification-disabled', 'not-eligible', 'verification-disabled', 'verification-disabled'])
})

test('openQuestions는 수집한 producer 결과에서 출처와 함께 싣는다', () => {
  const snapshot = buildSnapshot(fixture())
  assert.equal(snapshot.openQuestions.length, 1)
  assert.equal(snapshot.openQuestions[0].source, '04-state')
  assert.equal(snapshot.openQuestions[0].title, '열린 질문')
  // producer가 자기 출처를 적어 보내도 결과 파일 이름이 정본이다
  const spoofed = buildSnapshot(fixture({ openQuestionsBySource: new Map([['04-state', [{ title: 'q', source: '01-fsd' }]]]) }))
  assert.equal(spoofed.openQuestions[0].source, '04-state')
})

test('실행 도중 대상이 바뀌었으면 그 사실을 남긴다 — 같은 HEAD라도 작업 트리가 다르면 다른 대상이다', () => {
  const changed = `sha256:${'9'.repeat(64)}`
  const snapshot = buildSnapshot(fixture({ current: { head: HEAD, worktree: changed, dirtyFiles: 3, rulesDigest: DIGEST } }))
  assert.deepEqual(snapshot.drift, [{ field: 'worktree', recorded: WORKTREE, current: changed }])
  assert.equal(snapshot.target.worktree, WORKTREE, '대상은 시작할 때 기록한 값이다')
  assert.match(renderSnapshotMarkdown(snapshot), /검토 도중 대상이 바뀌었다/)
  assert.deepEqual(buildSnapshot(fixture()).drift, [])
})

test('base가 merge-base 뒤로 앞서 같은 파일을 바꿨으면 대상에 남기고, 도구 결과를 어떻게 읽을지 블록에 적는다', () => {
  // 2026-10-13 실행은 main이 4커밋 앞서 package.json을 바꿔 둔 사실을 모른 채 typecheck·test 실패를 "baseline 미측정"으로만 남겼다.
  const overlap = ['package-lock.json', 'package.json', 'src/a.json', 'src/b.json', 'src/c.json', 'src/d.json']
  const behind = buildSnapshot(fixture({ events: [runStart({ baseAhead: 4, baseOverlapCount: 7, baseOverlap: overlap }), ...fixture().events.slice(1)] }))
  assert.deepEqual([behind.target.baseAhead, behind.target.baseOverlapCount, behind.target.baseOverlap], [4, 7, overlap])
  assert.deepEqual(snapshotProblems(behind), [])
  const markdown = renderSnapshotMarkdown(behind)
  assert.match(markdown, /\*\*base가 앞서 있다\*\* — `main`이 merge-base 뒤로 4커밋 앞서 있고, 이 브랜치와 같은 파일 7개를 바꿨다: `package-lock\.json`, `package\.json`, `src\/a\.json`, `src\/b\.json`, `src\/c\.json` 외 2개\. .*이 브랜치를 base에 합친 트리에서 다시 재 가린다 — 파일이 겹친다는 것만으로 이 변경의 실패가 아니라고 하지 않는다\(C-6\)\./)
  const apart = buildSnapshot(fixture({ events: [runStart({ baseAhead: 2 }), ...fixture().events.slice(1)] }))
  assert.match(renderSnapshotMarkdown(apart), /base `main`이 merge-base 뒤로 2커밋 앞서 있다 — 이 브랜치가 바꾼 파일은 건드리지 않았다/)
  // 재지 않은 실행(예전 기록)에는 줄이 없다 — 앞서지 않았다고 지어내지 않는다.
  const unmeasured = buildSnapshot(fixture())
  assert.equal('baseAhead' in unmeasured.target, false)
  assert.doesNotMatch(renderSnapshotMarkdown(unmeasured), /merge-base 뒤로/)
  for (const [target, pattern] of [
    [{ ...behind.target, baseAhead: -1 }, /baseAhead/],
    [{ ...behind.target, baseOverlapCount: undefined }, /함께 있어야/],
    [{ ...behind.target, baseOverlapCount: 1 }, /길이보다 작다/],
  ]) {
    const problems = snapshotProblems({ ...behind, target: Object.fromEntries(Object.entries(target).filter(([, value]) => value !== undefined)) })
    assert.ok(problems.some(problem => pattern.test(problem)), `${pattern}: ${problems.join(' / ')}`)
  }
})

test('실행 식별이 없는 기록으로는 스냅숏을 만들지 않는다', () => {
  // 2.16.0 이전 preflight로 시작한 실행이다. 대상을 모르는 결과는 다른 실행과 이을 수 없다.
  const events = [runStart({ runId: undefined }), ...ALL.map(name => done(name))]
  assert.throws(() => buildSnapshot(fixture({ events })), /runId/)
  assert.throws(() => buildSnapshot(fixture({ events: ALL.map(name => done(name)) })), /run\.start/)
})

test('--collect를 거치지 않은 routed 출력으로는 범위를 정할 수 없다', () => {
  assert.throws(() => buildSnapshot(fixture({ routed: { candidates: [] } })), /collected/)
})

// --- 2. 잘리거나 모르는 파일을 빈 리뷰로 읽지 않는다 ---

test('잘린 파일·빈 파일·JSON이 아닌 파일은 오류다 — 빈 리뷰가 아니다', () => {
  const text = `${JSON.stringify(buildSnapshot(fixture()), null, 2)}\n`
  assert.equal(parseSnapshot(text).error, undefined)
  for (const broken of ['', '   ', text.slice(0, Math.floor(text.length / 2)), 'null', '[]']) {
    const parsed = parseSnapshot(broken)
    assert.equal(parsed.value, undefined, `읽혀서는 안 된다: ${JSON.stringify(broken.slice(0, 20))}`)
    assert.ok(parsed.error, '진단을 낸다')
  }
})

test('모르는 schemaVersion은 이유를 말하고 거부한다', () => {
  const snapshot = { ...buildSnapshot(fixture()), schemaVersion: 2 }
  const parsed = parseSnapshot(JSON.stringify(snapshot))
  assert.equal(parsed.value, undefined)
  assert.match(parsed.error, /schemaVersion 2/)
})

test('필드가 빠졌거나 수치가 목록과 맞지 않으면 거부한다', () => {
  const good = buildSnapshot(fixture())
  const cases = [
    [{ ...good, findings: undefined }, /findings/],
    [{ ...good, run: { ...good.run, runId: '' } }, /runId/],
    [{ ...good, target: { ...good.target, worktree: 'dirty' } }, /worktree/],
    [{ ...good, scope: { ...good.scope, counts: { ...good.scope.counts, ok: good.scope.counts.ok + 1 } } }, /counts/],
    [{ ...good, status: 'partial' }, /status/],
    [{ ...good, findings: [{ ...good.findings[0], ref: 'other-run/04-3#1' }] }, /ref/],
    [{ ...good, findings: [{ ...good.findings[0], disposition: 'confirmed' }] }, /disposition/],
  ]
  for (const [snapshot, pattern] of cases) {
    const problems = snapshotProblems(snapshot)
    assert.ok(problems.some(problem => pattern.test(problem)), `${pattern}: ${problems.join(' / ')}`)
  }
})

// --- 2. 쓰다 실패해도 앞의 정상 파일을 남긴다 ---

const freshDir = t => {
  const dir = mkdtempSync(join(tmpdir(), 'snapshot-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('임시 파일에 쓰고 다시 읽어 확인한 뒤 바꾼다', t => {
  const path = join(freshDir(t), 'run.snapshot.json')
  const snapshot = buildSnapshot(fixture())
  writeSnapshotAtomic(path, snapshot)
  assert.deepEqual(parseSnapshot(readFileSync(path, 'utf8')).value, snapshot)
  assert.deepEqual(readdirSync(dirname(path)), ['run.snapshot.json'], '임시 파일을 남기지 않는다')
})

test('일부만 쓰인 임시 파일은 정상 스냅숏을 덮지 않는다', t => {
  const path = join(freshDir(t), 'run.snapshot.json')
  const first = buildSnapshot(fixture())
  writeSnapshotAtomic(path, first)
  const before = readFileSync(path, 'utf8')
  // 디스크가 가득 차서 반만 쓰고 끝난 경우를 흉내 낸다
  const truncating = { ...fs, writeFileSync: (file, text, options) => fs.writeFileSync(file, String(text).slice(0, 40), options) }
  const second = buildSnapshot(fixture({ now: '2026-10-06T02:00:00.000Z' }))
  assert.throws(() => writeSnapshotAtomic(path, second, truncating), /다시 읽/)
  assert.equal(readFileSync(path, 'utf8'), before)
  assert.deepEqual(readdirSync(dirname(path)), ['run.snapshot.json'])
})

test('schema에 맞지 않는 스냅숏은 쓰지 않고, 정상 스냅숏을 남긴다', t => {
  const path = join(freshDir(t), 'run.snapshot.json')
  writeSnapshotAtomic(path, buildSnapshot(fixture()))
  const before = readFileSync(path, 'utf8')
  assert.throws(() => writeSnapshotAtomic(path, { ...buildSnapshot(fixture()), schemaVersion: 2 }), /schemaVersion/)
  assert.equal(readFileSync(path, 'utf8'), before)
})

test('다른 실행의 정상 스냅숏은 덮지 않는다', t => {
  const path = join(freshDir(t), 'run.snapshot.json')
  writeSnapshotAtomic(path, buildSnapshot(fixture()))
  const other = buildSnapshot(fixture({ events: [runStart({ runId: '99999999-2222-4333-8444-555555555555' }), ...fixture().events.slice(1)] }))
  assert.throws(() => writeSnapshotAtomic(path, other), /다른 실행/)
})

test('깨진 스냅숏 자리에는 새 정상 스냅숏을 쓸 수 있다', t => {
  const path = join(freshDir(t), 'run.snapshot.json')
  writeFileSync(path, '{"schemaVersion": 1, "kin')
  writeSnapshotAtomic(path, buildSnapshot(fixture()))
  assert.equal(parseSnapshot(readFileSync(path, 'utf8')).error, undefined)
  assert.equal(existsSync(path), true)
})

// --- 3. JSON과 리포트가 같은 것을 말한다 ---

test('리포트 블록은 스냅숏 JSON만으로 그린다 — 상태와 모듈별 범위가 같다', () => {
  const events = [runStart(), planned([{ module: 'math', reasonCode: 'x', reason: '행렬 없음 | 표 깨짐 시도' }], ['12-accessibility']),
    ...ALL.filter(name => !['math', '12-accessibility', '04-state', '20-deletion-regression'].includes(name)).map(name => done(name)),
    done('04-state', 'failed', 2, { failureClass: 'inactivity-timeout' })]
  const sources = ALL.filter(name => !['math', '12-accessibility', '04-state', '20-deletion-regression'].includes(name))
  const snapshot = buildSnapshot(fixture({ events, routed: { candidates: [], collected: { sources, excludedFailed: [] } }, verdicts: new Map() }))
  // 파일로 왕복해도 같은 블록이다 — 리포트에 붙인 블록은 저장된 JSON에서 다시 만들 수 있다
  const markdown = renderSnapshotMarkdown(snapshot)
  assert.equal(renderSnapshotMarkdown(JSON.parse(JSON.stringify(snapshot))), markdown)
  assert.match(markdown, /검토 상태: 부분 완료/)
  const { counts } = snapshot.scope
  assert.ok(markdown.includes(`적용 ${counts.applied}개 중 수집 ${counts.ok}`), markdown)
  for (const module of snapshot.scope.modules.filter(entry => entry.state !== 'ok')) {
    assert.ok(markdown.includes(`\`${module.name}\``), `${module.name}이 리포트에 없다`)
  }
  assert.match(markdown, /`FAILED`/)
  assert.match(markdown, /`inactivity-timeout`/)
  assert.match(markdown, /`SKIPPED`/)
  assert.match(markdown, /`UNKNOWN`/)
  assert.match(markdown, /결과 없음/)
  assert.ok(markdown.includes('\\|'), '사유의 | 는 표를 깨지 않게 막는다')
  assert.ok(markdown.includes(RUN_ID))
})

test('완료와 실패도 같은 자리에 같은 말로 쓴다', () => {
  assert.match(renderSnapshotMarkdown(buildSnapshot(fixture())), /검토 상태: 완료/)
  const events = [runStart(), planned(), ...ALL.map(name => done(name, 'failed', 1, { failureClass: 'no-start' }))]
  const failed = buildSnapshot(fixture({ events, routed: { candidates: [], collected: { sources: [], excludedFailed: [] } }, verdicts: new Map() }))
  assert.match(renderSnapshotMarkdown(failed), /검토 상태: 실패/)
})

// --- 재현 근거 요약 (#88 PR 2) ---

test('지적마다 재현 근거의 방법·결과·base 비교를 요약해 싣는다 — 근거가 없으면 싣지 않는다', () => {
  const evidence = new Map([['04-3#1', {
    candidateId: '04-3#1', method: 'executed', condition: 'c', expected: 'e',
    head: { id: 'exec-1', side: 'head', outcome: 'reproduced', usable: true }, base: null, comparison: 'base-unmeasured',
  }]])
  const snapshot = buildSnapshot(fixture({ routed: { candidates: [candidate()], collected: { sources: ALL.filter(name => name !== 'math'), excludedFailed: [] } }, evidence }))
  assert.deepEqual(snapshotProblems(snapshot), [])
  assert.deepEqual(snapshot.findings[0].evidence, { method: 'executed', valid: true, headOutcome: 'reproduced', headUsable: true, comparison: 'base-unmeasured' })
  assert.equal(buildSnapshot(fixture()).findings[0].evidence, undefined)
})

test('계약에 맞지 않는 근거 항목은 결과 없이 valid false로 싣는다 — 실행 근거로 세지 않는다', () => {
  const evidence = new Map([['04-3#1', { candidateId: '04-3#1', method: 'executed', problems: ['executions가 없다'] }]])
  const snapshot = buildSnapshot(fixture({ evidence }))
  assert.deepEqual(snapshot.findings[0].evidence, { method: 'executed', valid: false, headOutcome: null, headUsable: null, comparison: null })
})

test('근거 요약의 값이 닫힌 목록 밖이면 스냅숏을 거부한다', () => {
  const good = buildSnapshot(fixture({ evidence: new Map([['04-3#1', { candidateId: '04-3#1', method: 'static-trace' }]]) }))
  const bad = { ...good, findings: [{ ...good.findings[0], evidence: { ...good.findings[0].evidence, method: 'guessed' } }] }
  assert.ok(snapshotProblems(bad).some(problem => /evidence/.test(problem)))
})

// ── 작업 대장의 멈춤과 취소(C-12) ─────────────────────────────────────

test('디스패치를 멈춰 띄우지 못한 모듈은 기록이 없는 모듈과 다른 이유로 미검토 범위에 남는다', () => {
  const ran = ALL.filter(name => !['math', '20-deletion-regression', 'exception'].includes(name))
  const snapshot = buildSnapshot(fixture({
    events: [
      runStart({ maxTasks: 30 }),
      planned([{ module: 'math', reasonCode: 'no-linear-algebra', reason: '행렬 연산이 없다' }]),
      ...ran.map(name => done(name)),
      { at: '2026-10-06T00:30:00.000Z', phase: 'dispatch.halt', reason: 'max-tasks', stage: 'module', queuedTasks: ['20-deletion-regression', 'exception'], running: 0 },
    ],
    routed: { candidates: [candidate()], collected: { sources: ran, excludedFailed: [] } },
  }))
  assert.deepEqual(snapshotProblems(snapshot), [])
  assert.equal(snapshot.status, 'partial')
  const halted = snapshot.scope.modules.filter(module => module.reason === 'halted')
  assert.deepEqual(halted.map(module => `${module.name}:${module.haltReason}`), ['20-deletion-regression:max-tasks', 'exception:max-tasks'])
  assert.deepEqual(snapshot.dispatch.halted, { reason: 'max-tasks', at: '2026-10-06T00:30:00.000Z' })
  assert.equal(snapshot.dispatch.maxTasks, 30)
  const block = renderSnapshotMarkdown(snapshot)
  assert.match(block, /\| `exception` \| 결과 없음 \| 디스패치를 멈춰 띄우지 않았다 \(호출 한도를 다 썼다\) \|/)
  assert.match(block, /\*\*디스패치를 멈췄다\*\* — 호출 한도를 다 썼다/)
})

test('시간 상한으로 취소된 모듈은 실패로 세고 취소 사유를 함께 남긴다', () => {
  const snapshot = buildSnapshot(fixture({
    events: [
      runStart({ maxDurationSec: 1800 }),
      planned([{ module: 'math', reasonCode: 'no-linear-algebra', reason: '행렬 연산이 없다' }]),
      ...ALL.filter(name => !['math', 'exception'].includes(name)).map(name => done(name)),
      done('exception', 'failed', 1, { failureClass: 'cancelled', cancelReason: 'max-duration' }),
      { at: '2026-10-06T00:30:00.000Z', phase: 'dispatch.halt', reason: 'max-duration', stage: 'module', queuedTasks: [], running: 1 },
    ],
    routed: { candidates: [candidate()], collected: { sources: ALL.filter(name => !['math', 'exception'].includes(name)), excludedFailed: [] } },
  }))
  assert.deepEqual(snapshotProblems(snapshot), [])
  const exception = snapshot.scope.modules.find(module => module.name === 'exception')
  assert.deepEqual([exception.state, exception.failureClass, exception.cancelReason], ['failed', 'cancelled', 'max-duration'])
  assert.match(renderSnapshotMarkdown(snapshot), /\| `exception` \| `FAILED` \| 시도 1 · `cancelled` · 시간 상한이 지났다 \|/)
})

test('멈춤 기록이 없으면 띄우지 않은 모듈은 여전히 기록 없음이다 — 한도 탓으로 돌리지 않는다', () => {
  const snapshot = buildSnapshot(fixture({
    events: [runStart(), planned([{ module: 'math', reasonCode: 'no-linear-algebra', reason: '행렬 연산이 없다' }]),
      ...ALL.filter(name => !['math', 'exception'].includes(name)).map(name => done(name))],
    routed: { candidates: [candidate()], collected: { sources: ALL.filter(name => !['math', 'exception'].includes(name)), excludedFailed: [] } },
  }))
  assert.equal(snapshot.scope.modules.find(module => module.name === 'exception').reason, 'no-record')
  assert.equal(snapshot.dispatch.halted, null)
})

test('멈춤 이유가 목록 밖인 스냅숏은 계약 밖이다', () => {
  const snapshot = buildSnapshot(fixture())
  assert.deepEqual(snapshotProblems({ ...snapshot, dispatch: { ...snapshot.dispatch, halted: { reason: 'tired', at: 'x' } } }).length, 1)
})

// ── 이전 리뷰와의 비교(C-13) ───────────────────────────────────────────

const previousSection = entries => ({
  snapshot: { path: '/x/before.snapshot.json', sha256: 'f'.repeat(64), runId: 'run-before', head: 'e'.repeat(40), createdAt: 'x', status: 'complete' },
  paths: 'known', claims: 'available', reused: 0,
  counts: { current: { new: 0, linked: 1, recheck: 0 }, previous: { linked: 1, recheck: entries.length - 1 } },
  entries,
})

test('이전 리뷰와 비교한 실행은 재확인 판정이 막는 코드를 댄 것만 해결 확인으로 남긴다', () => {
  const routed = {
    candidates: [candidate({ lineage: { status: 'linked', previousRef: 'run-before/04-3#1', lineageId: 'run-0/04-3#1' } })],
    collected: { sources: ALL.filter(name => name !== 'math'), excludedFailed: [] },
    previous: previousSection([
      { ref: 'run-before/04-3#1', lineageId: 'run-0/04-3#1', ruleId: '04-3', status: 'linked', currentCandidateId: '04-3#1' },
      { ref: 'run-before/06-1#1', lineageId: 'run-before/06-1#1', ruleId: '06-1', status: 'recheck', reason: 'absent', recheckTask: 'recheck-06-1-1' },
      { ref: 'run-before/04-2#1', lineageId: 'run-before/04-2#1', ruleId: '04-2', status: 'recheck', reason: 'absent', recheckTask: 'recheck-04-2-1' },
      { ref: 'run-before/04-4#1', lineageId: 'run-before/04-4#1', ruleId: '04-4', status: 'recheck', reason: 'absent', recheckTask: 'recheck-04-4-1' },
    ]),
  }
  const rechecks = new Map([
    ['run-before/06-1#1', { disposition: 'rejected', rebuttal: { kind: 'guard-exists' } }],
    ['run-before/04-2#1', { disposition: 'rejected', rebuttal: { kind: 'other', note: '모르겠다' } }],
  ])
  const snapshot = buildSnapshot(fixture({ routed, rechecks }))
  assert.deepEqual(snapshotProblems(snapshot), [])
  assert.equal(snapshot.findings[0].lineageId, 'run-0/04-3#1')
  assert.deepEqual(snapshot.findings[0].lineage, { status: 'linked', previousRef: 'run-before/04-3#1' })
  assert.deepEqual(snapshot.comparison.counts, { persisting: 1, resolved: 1, recheck: 2 })
  assert.deepEqual(snapshot.comparison.entries.map(entry => `${entry.status}:${entry.reason ?? entry.rebuttalKind ?? entry.basis}`),
    ['persisting:linked', 'resolved:guard-exists', 'recheck:recheck-unlocated', 'recheck:no-recheck-verdict'])
  const block = renderSnapshotMarkdown(snapshot)
  assert.match(block, /\*\*이전 리뷰와 비교\*\* — 이전 실행 `run-before`\(HEAD `eeeeeeeeeeee`\)의 지적 4개: 미해결 1 · 해결 확인 1 · 재확인 필요 2/)
  assert.ok(block.includes('| `run-before/06-1#1` | `06-1` | 해결 확인 | 재확인 판정이 막는 코드를 댔다(`guard-exists`) (처음 이유: 이번 리뷰가 같은 자리에서 다시 내지 않았다) |'), block)
  assert.match(block, /재확인 검증자가 해결을 막는 코드의 위치를 대지 못했다/)
  // 이어진 미해결 지적은 이번 상세 지적에 있으므로 표에 다시 싣지 않는다
  assert.ok(!block.includes('run-before/04-3#1'))
})

test('위치를 댄 반박 없이 해결 확인인 스냅숏은 계약 밖이다', () => {
  const routed = {
    candidates: [candidate()],
    collected: { sources: ALL.filter(name => name !== 'math'), excludedFailed: [] },
    previous: previousSection([{ ref: 'run-before/06-1#1', lineageId: 'l', ruleId: '06-1', status: 'recheck', reason: 'absent' }]),
  }
  const snapshot = buildSnapshot(fixture({ routed }))
  const forged = { ...snapshot, comparison: { ...snapshot.comparison, entries: [{ ref: 'run-before/06-1#1', lineageId: 'l', ruleId: '06-1', status: 'resolved' }], counts: { persisting: 0, resolved: 1, recheck: 0 } } }
  assert.ok(snapshotProblems(forged).some(problem => /위치를 댄 반박 없이 해결 확인이다/.test(problem)))
  // 결함을 인정한 반박(location-wrong)도 해결의 근거가 아니다(#45)
  for (const rebuttalKind of ['other', 'location-wrong']) {
    const kindForged = { ...forged, comparison: { ...forged.comparison, entries: [{ ...forged.comparison.entries[0], rebuttalKind }] } }
    assert.ok(snapshotProblems(kindForged).some(problem => /위치를 댄 반박 없이 해결 확인이다/.test(problem)), rebuttalKind)
  }
})

test('비교하지 않은 실행의 지적도 실행 간 이름을 갖는다 — 처음 이름은 그 실행의 ref다', () => {
  const snapshot = buildSnapshot(fixture())
  assert.equal(snapshot.findings[0].lineageId, snapshot.findings[0].ref)
  assert.equal(snapshot.comparison, undefined)
})

// ── PR #90 리뷰: 켠 선택 패스는 계획 기록으로 빠지지 않는다 ─────────────────

const correctnessOn = (planEntries, extraEvents = []) => buildSnapshot(fixture({
  events: [
    runStart({ correctness: 'on' }),
    planned(...planEntries),
    ...ALL.map(name => done(name)),
    ...extraEvents,
  ],
  routed: { candidates: [candidate()], collected: { sources: ALL, excludedFailed: [] } },
}))

test('--correctness on인데 계획이 정확성 패스를 SKIPPED로 적어도 완료가 아니다', () => {
  const snapshot = correctnessOn([[{ module: 'correctness', reason: 'no relevant scope' }]])
  assert.deepEqual(snapshotProblems(snapshot), [])
  assert.equal(snapshot.status, 'partial')
  const pass = snapshot.scope.modules.find(module => module.name === 'correctness')
  assert.deepEqual([pass.state, pass.reason], ['missing', 'no-record'])
  assert.ok(snapshot.notes.some(note => /켠 선택 패스 correctness를 modules\.planned가 SKIPPED로 적었다/.test(note)))
})

test('--correctness on인데 계획이 UNKNOWN으로 적어도 완료가 아니다', () => {
  const snapshot = correctnessOn([[], [{ module: 'correctness', reason: '모르겠다' }]])
  assert.equal(snapshot.status, 'partial')
  assert.equal(snapshot.scope.modules.find(module => module.name === 'correctness').state, 'missing')
})

test('--correctness on에서 실패한 정확성 패스는 SKIPPED 기록이 실패를 가리지 않는다', () => {
  const snapshot = correctnessOn([[{ module: 'correctness', reason: 'skip' }]], [done('correctness', 'failed', 2, { failureClass: 'malformed-output' })])
  const pass = snapshot.scope.modules.find(module => module.name === 'correctness')
  assert.deepEqual([pass.state, pass.failureClass], ['failed', 'malformed-output'])
  assert.equal(snapshot.status, 'partial')
})

test('--correctness off의 정상 경로는 그대로다 — 켜지 않은 패스는 SKIPPED(not-requested)', () => {
  const snapshot = buildSnapshot(fixture())
  assert.equal(snapshot.scope.modules.find(module => module.name === 'correctness').reasonCode, 'not-requested')
  assert.equal(snapshot.status, 'complete')
})

test('대상에 base 끝 SHA를 남기고 블록에 적는다 — 그 값이 없는 예전 기록은 미기록이라고 적는다', () => {
  const pinned = buildSnapshot(fixture({ events: [runStart({ baseHead: 'b'.repeat(40) }), ...fixture().events.slice(1)] }))
  assert.equal(pinned.target.baseHead, 'b'.repeat(40))
  assert.deepEqual(snapshotProblems(pinned), [])
  assert.match(renderSnapshotMarkdown(pinned), /base `main` \(끝 `bbbbbbbbbbbb` · merge-base `dddddddddddd`\)/)
  // 나중에 ref를 다시 읽어 시작 때의 값인 것처럼 채우지 않는다
  const legacy = buildSnapshot(fixture())
  assert.equal('baseHead' in legacy.target, false)
  assert.match(renderSnapshotMarkdown(legacy), /base `main` \(끝 SHA 미기록 · merge-base `dddddddddddd`\)/)
  const broken = { ...pinned, target: { ...pinned.target, baseHead: 'main' } }
  assert.ok(snapshotProblems(broken).some(problem => /baseHead/.test(problem)), snapshotProblems(broken).join(' / '))
})

// ── 기존 구현 검색(C-6C) ─────────────────────────────────────────────────
// 검색 범위와 상태는 스크립트가 기록에서 세어 블록에 그린다. 오케스트레이터가 세거나 문장을 다시 쓰지 않는다.
// 검색 기록이 없는 실행을 후보 0건으로 그리지 않고, 예전 실행에서는 이 기능이 돌았다고 추정하지 않는다.
const reuseEvents = (tail, startExtra = {}) => [runStart({ reuseSearch: 'planned', baseHead: 'b'.repeat(40), ...startExtra }), ...fixture().events.slice(1),
  { at: '2026-10-06T00:01:00.000Z', phase: 'reuse.planned', searchId: 's1', scopeSha256: 'h', plan: 'p' },
  ...tail]
const reuseDone = (status, extra = {}) => [
  { at: '2026-10-06T00:01:05.000Z', phase: 'reuse.start', searchId: 's1', plan: 'p' },
  { at: '2026-10-06T00:02:00.000Z', phase: 'reuse.done', searchId: 's1', status, ...extra },
]
const reuseDoc = {
  schemaVersion: 1, runId: RUN_ID, searchId: 's1', status: 'partial',
  targets: [{ targetId: 't1', status: 'complete', candidates: [] }, { targetId: 't2', status: 'partial', candidates: [], limits: { reached: ['candidates'], omittedCandidates: 3, omittedHits: 2 } }],
}

test('검색이 끝났으면 대상별 상태·생략 수·조사한 commit·늘어난 검증 작업을 기록에서 세어 그린다', () => {
  const routed = { ...fixture().routed, counts: { reuse: { context: 'used', crossFileEvidence: 2, newlyEligible: 1, movedToIsolated: 1, verificationTasksAdded: 1 } } }
  const snapshot = buildSnapshot(fixture({ events: reuseEvents(reuseDone('partial', { targets: { complete: 6, partial: 2 }, reason: 'limits-or-errors' })), routed, reuseContext: reuseDoc }))
  assert.deepEqual(snapshot.reuse, {
    state: 'done', searchId: 's1', status: 'partial', reason: 'limits-or-errors', targets: { complete: 6, partial: 2 },
    omitted: { candidates: 3, hits: 2 }, verification: { crossFileEvidence: 2, newlyEligible: 1, movedToIsolated: 1, verificationTasksAdded: 1 },
  })
  assert.deepEqual(snapshotProblems(snapshot), [])
  const markdown = renderSnapshotMarkdown(snapshot)
  assert.match(markdown, /\*\*기존 구현 검색\*\* — 검색 대상 8개 중 완료 6 · 부분 완료 2 \(상한으로 생략한 후보 3개 · hit 2개\)\. HEAD `[0-9a-f]{12}` · base 끝 `bbbbbbbbbbbb`에서 찾았다\. 다른 파일과 견준 05-7 지적 2개를 검증으로 보냈다\(검증 작업 \+1\)\./)
})

test('검색 대상이 없거나 실패·유실·시간 초과로 끝났으면 그대로 적는다 — 05가 근거 없이 돌았다는 것까지', () => {
  const none = buildSnapshot(fixture({ events: reuseEvents(reuseDone('not-applicable', { targets: {} })) }))
  assert.match(renderSnapshotMarkdown(none), /\*\*기존 구현 검색\*\* — 검색 대상이 없다\. 리뷰 파일마다 제외 사유를 남겼다\./)
  const failed = buildSnapshot(fixture({ events: reuseEvents(reuseDone('failed', { targets: {}, reason: 'plan-invalid' })) }))
  assert.match(renderSnapshotMarkdown(failed), /\*\*기존 구현 검색이 실패했다\*\* \(plan-invalid\)\. 05는 검색 근거 없이 돌았다\./)
  const lost = buildSnapshot(fixture({ events: reuseEvents([{ at: '2026-10-06T00:01:05.000Z', phase: 'reuse.start', searchId: 's1', plan: 'p' }, { at: '2026-10-06T00:01:30.000Z', phase: 'tool.done', name: 'reuse-search', exit: 1, treeSha: 'x' }]) }))
  assert.equal(lost.reuse.state, 'lost')
  assert.match(renderSnapshotMarkdown(lost), /\*\*기존 구현 검색이 끝나지 않았다\*\* — 검색 프로세스가 끝\(reuse\.done\)을 남기지 못하고 끝났다\. 05는 검색 근거 없이 돌았다\./)
  const timedOut = buildSnapshot(fixture({ events: reuseEvents([{ at: '2026-10-06T00:01:05.000Z', phase: 'reuse.start', searchId: 's1', plan: 'p' }]), now: '2026-10-06T05:00:00.000Z' }))
  assert.equal(timedOut.reuse.state, 'timed-out')
  assert.match(renderSnapshotMarkdown(timedOut), /\*\*기존 구현 검색이 끝나지 않았다\*\* — 검색을 1800초 기다렸다\. 05는 검색 근거 없이 돌았다\./)
})

test('검색을 예정하지 않은 예전 실행에는 검색 줄이 없다 — 후보 0건으로 그리지 않는다', () => {
  const legacy = buildSnapshot(fixture())
  assert.equal('reuse' in legacy, false)
  assert.doesNotMatch(renderSnapshotMarkdown(legacy), /기존 구현 검색/)
  const broken = { ...buildSnapshot(fixture({ events: reuseEvents(reuseDone('complete', { targets: { complete: 1 } })) })), reuse: { state: 'nope' } }
  assert.ok(snapshotProblems(broken).some(problem => /reuse/.test(problem)), snapshotProblems(broken).join(' / '))
})

test('계획이나 시작이 없던 검색은 상한 뒤에 풀렸어도 "돌지 않았다"로 그린다 — 기다린 시간만 적지 않는다', () => {
  const late = '2026-10-06T05:00:00.000Z'
  const unplanned = buildSnapshot(fixture({ events: [runStart({ reuseSearch: 'planned', baseHead: 'b'.repeat(40) }), ...fixture().events.slice(1)], now: late }))
  assert.equal(unplanned.reuse.state, 'timed-out')
  assert.equal(unplanned.reuse.started, false)
  assert.match(renderSnapshotMarkdown(unplanned), /\*\*기존 구현 검색이 돌지 않았다\*\* — 검색 계획\(`reuse\.planned`\)이 없다\. 05는 검색 근거 없이 돌았다\./)
  const unstarted = buildSnapshot(fixture({ events: reuseEvents([]), now: late }))
  assert.match(renderSnapshotMarkdown(unstarted), /\*\*기존 구현 검색이 돌지 않았다\*\* — 계획했지만 시작하지 않았다\(`reuse\.start` 없음\)\. 05는 검색 근거 없이 돌았다\./)
  const running = buildSnapshot(fixture({ events: reuseEvents([{ at: '2026-10-06T00:01:05.000Z', phase: 'reuse.start', searchId: 's1', plan: 'p' }]), now: '2026-10-06T00:05:00.000Z' }))
  assert.equal(running.reuse.started, true)
  assert.match(renderSnapshotMarkdown(running), /\*\*기존 구현 검색이 끝나지 않았다\*\* — 검색이 아직 돌고 있다\./)
})
