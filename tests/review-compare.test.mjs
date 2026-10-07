import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  anchorOf, finalizePrevious, fingerprintOf, linkFindings, normalizeQuote, pathChanges, recheckOutcome, recheckable, ruleKeyOf,
} from '../scripts/lib/review-compare.mjs'

// 이전 리뷰와 이번 리뷰를 잇는 규칙(C-13, #88 PR 4)을 고정한다.
//
// 완료 기준 가운데 이 파일이 보는 것:
// - 줄 삽입·정확한 파일 이동으로 같은 지적이 신규로 중복되지 않는다
// - 같은 규칙·위치의 서로 다른 결함을 하나로 합치지 않는다
// - 삭제·이름 바꿈·규칙 변경·관련 호출자 변경·부분 실패가 있는 비교
// - 검토하지 않았거나 실패한 범위의 이전 지적은 자동으로 해결 처리되지 않는다

const at = (path, line, quote) => ({ kind: 'verified', path, line, quote })
const prev = (candidateId, ruleId, location, sources = ['04-state']) => ({ ref: `run-a/${candidateId}`, candidateId, ruleId, sources, location })
const cur = (candidateId, ruleId, location, source = '04-state') => ({ candidateId, ruleId, source, location })
const REVIEWED = new Set(['04-state', '02-type', 'correctness', '06-perf'])
const link = (previous, current, extra = {}) => linkFindings({
  previous, current, currentRunId: 'run-b', clauselessPrefixes: ['CR'], reviewedNow: REVIEWED, reviewedBefore: REVIEWED, ...extra,
})

test('위치는 공백을 접은 인용과 경로로 본다 — 줄 번호는 보지 않는다', () => {
  assert.equal(normalizeQuote('  if (x)\treturn  '), 'if (x) return')
  assert.deepEqual(anchorOf(at('src/a.ts', 3, '  setState(data)')), { side: 'verified', path: 'src/a.ts', quote: 'setState(data)' })
  assert.deepEqual(anchorOf(at('src/a.ts', 3, 'x'), new Map([['src/a.ts', 'src/b.ts']])).path, 'src/b.ts')
  assert.equal(anchorOf({ kind: 'unverified', reason: 'r' }), null)
  const one = fingerprintOf({ repo: 'r', ruleKey: '04-3', anchor: anchorOf(at('src/a.ts', 3, 'x')) })
  assert.equal(one, fingerprintOf({ repo: 'r', ruleKey: '04-3', anchor: anchorOf(at('src/a.ts', 90, '  x ')) }))
  assert.notEqual(one, fingerprintOf({ repo: 'other', ruleKey: '04-3', anchor: anchorOf(at('src/a.ts', 3, 'x')) }))
})

test('조항 없는 지적은 번호를 빼고 잇는다 — CR-1과 CR-2는 다른 결함이라는 뜻이 아니다', () => {
  assert.equal(ruleKeyOf('CR-7', ['CR']), 'CR-*')
  assert.equal(ruleKeyOf('04-3', ['CR']), '04-3')
  const { current, previous } = link(
    [prev('CR-1#1', 'CR-1', at('src/header.ts', 4, 'return formatName(user).toUpperCase()'), ['correctness'])],
    [cur('CR-2#1', 'CR-2', at('src/header.ts', 4, 'return formatName(user).toUpperCase()'), 'correctness')],
  )
  assert.equal(current.get('CR-2#1').status, 'linked')
  assert.equal(previous[0].status, 'linked')
})

test('줄이 밀려도 같은 지적이다 — 신규로 중복되지 않는다', () => {
  const { current, previous } = link(
    [prev('04-3#1', '04-3', at('src/load.ts', 3, '  setState(data)'))],
    [cur('04-3#1', '04-3', at('src/load.ts', 9, '  setState(data)'))],
  )
  assert.deepEqual(current.get('04-3#1'), { status: 'linked', previousRef: 'run-a/04-3#1', lineageId: 'run-a/04-3#1' })
  assert.equal(previous[0].currentCandidateId, '04-3#1')
})

test('정확히 옮긴 파일의 지적은 git의 이름 바꿈 대응으로 잇는다', () => {
  const paths = { renamed: new Map([['src/move.ts', 'src/lib/move.ts']]), deleted: new Set(), changed: new Set() }
  const { current } = link(
    [prev('02-1#1', '02-1', at('src/move.ts', 2, 'export const x: any = 1'), ['02-type'])],
    [cur('02-1#1', '02-1', at('src/lib/move.ts', 2, 'export const x: any = 1'), '02-type')],
    { paths },
  )
  assert.equal(current.get('02-1#1').status, 'linked')
})

test('이어진 지적은 이전의 이름(lineageId)을 물려받는다 — 이번 실행의 순번을 실행 간 이름으로 쓰지 않는다', () => {
  const earlier = { ...prev('04-3#2', '04-3', at('src/load.ts', 3, 'setState(data)')), lineageId: 'run-0/04-3#1' }
  const { current } = link([earlier], [cur('04-3#1', '04-3', at('src/load.ts', 3, 'setState(data)'))])
  assert.equal(current.get('04-3#1').lineageId, 'run-0/04-3#1')
})

test('같은 규칙·같은 자리의 서로 다른 결함은 합치지 않는다 — 어느 것과 이어지는지 모르면 모두 재확인 필요다', () => {
  const quote = 'doThing()'
  const { current, previous } = link(
    [prev('04-1#1', '04-1', at('src/x.ts', 3, quote)), prev('04-1#2', '04-1', at('src/x.ts', 7, quote))],
    [cur('04-1#1', '04-1', at('src/x.ts', 4, quote)), cur('04-1#2', '04-1', at('src/x.ts', 8, quote))],
  )
  assert.deepEqual(previous.map(entry => `${entry.status}:${entry.reason}`), ['recheck:ambiguous', 'recheck:ambiguous'])
  assert.deepEqual([...current.values()].map(entry => `${entry.status}:${entry.reason}`), ['recheck:ambiguous', 'recheck:ambiguous'])
  // 이어지지 않은 쪽의 이름은 각자 새로 받는다 — 둘이 한 이름으로 합쳐지지 않는다
  assert.notEqual(current.get('04-1#1').lineageId, current.get('04-1#2').lineageId)
  assert.equal(previous.filter(recheckable).length, 0)
})

test('이번 실행에서 실패하거나 건너뛴 모듈의 이전 지적은 해결이 아니라 재확인 필요다', () => {
  const { previous } = link(
    [prev('06-1#1', '06-1', at('src/a.ts', 2, 'for (const x of list)'), ['06-perf'])],
    [],
    { reviewedNow: new Set(['04-state']) },
  )
  assert.deepEqual([previous[0].status, previous[0].reason], ['recheck', 'not-reviewed'])
  assert.equal(recheckable(previous[0]), true)
})

test('이어지지 않은 이전 지적은 이유를 단 재확인 필요다 — 규칙 변경, 파일 삭제, 다시 나오지 않음', () => {
  const paths = { renamed: new Map(), deleted: new Set(['src/gone.ts']), changed: new Set() }
  const { previous } = link(
    [
      prev('05-2#1', '05-2', at('src/a.ts', 2, 'a()')),
      prev('04-3#1', '04-3', at('src/gone.ts', 2, 'b()')),
      prev('04-4#1', '04-4', at('src/c.ts', 2, 'c()')),
      prev('04-5#1', '04-5', { kind: 'unverified', reason: '못 찾았다' }),
    ],
    [],
    { paths, ruleChanged: ruleId => ruleId === '05-2' },
  )
  assert.deepEqual(previous.map(entry => entry.reason), ['rule-changed', 'file-deleted', 'absent', 'location-unverified'])
  assert.ok(previous.every(entry => entry.status === 'recheck'))
})

test('관련 호출자만 바뀌고 이번에 다시 나오지 않은 지적도 해결로 보지 않는다', () => {
  // 지적의 파일(src/header.ts)은 그대로이고 호출되는 쪽(src/format.ts)이 바뀌었다. 이번 리뷰가 그 지적을
  // 내지 않았다는 것은 고쳐졌다는 증거가 아니다 — 재확인 판정이 있어야 해결 확인이다.
  const paths = { renamed: new Map(), deleted: new Set(), changed: new Set(['src/format.ts']) }
  const { previous } = link([prev('CR-1#1', 'CR-1', at('src/header.ts', 4, 'return formatName(user).toUpperCase()'), ['correctness'])], [], { paths })
  assert.deepEqual([previous[0].status, previous[0].reason], ['recheck', 'absent'])
  const [final] = finalizePrevious(previous)
  assert.equal(final.status, 'recheck')
})

test('신규는 이전 리뷰에 없던 지적이고, 그 자리의 코드가 이번에 바뀌었는지 함께 남는다', () => {
  const paths = { renamed: new Map(), deleted: new Set(), changed: new Set(['src/new.ts']) }
  const { current } = link([], [
    cur('04-1#1', '04-1', at('src/new.ts', 1, 'x')),
    cur('04-2#1', '04-2', at('src/old.ts', 1, 'y')),
    cur('02-1#1', '02-1', at('src/old.ts', 1, 'z'), '02-type'),
  ], { paths, reviewedBefore: new Set(['04-state']) })
  assert.deepEqual(current.get('04-1#1'), { status: 'new', lineageId: 'run-b/04-1#1', fileChanged: true, ruleChanged: false })
  assert.equal(current.get('04-2#1').fileChanged, false)
  // 이전 리뷰가 그 모듈을 검토하지 않았으면 신규인지 말할 수 없다
  assert.deepEqual([current.get('02-1#1').status, current.get('02-1#1').reason], ['recheck', 'previous-not-reviewed'])
})

test('재확인 판정은 막는 코드의 위치를 댄 반박만 해결 확인으로 만든다', () => {
  assert.deepEqual(recheckOutcome({ disposition: 'upheld' }), { status: 'persisting', basis: 'recheck' })
  assert.deepEqual(recheckOutcome({ disposition: 'rejected', rebuttal: { kind: 'guard-exists' } }), { status: 'resolved', rebuttalKind: 'guard-exists' })
  assert.deepEqual(recheckOutcome({ disposition: 'rejected', rebuttal: { kind: 'other', note: 'n' } }), { status: 'recheck', reason: 'recheck-unlocated' })
  assert.deepEqual(recheckOutcome({ disposition: 'needs-context', reason: 'r' }), { status: 'recheck', reason: 'recheck-needs-context' })
  assert.deepEqual(recheckOutcome(undefined), { status: 'recheck', reason: 'no-recheck-verdict' })
})

test('재확인을 맡겼는데 판정이 없으면 해결이 아니라 재확인 필요다', () => {
  const entries = [
    { ref: 'run-a/1', status: 'linked', currentCandidateId: 'x#1' },
    { ref: 'run-a/2', status: 'recheck', reason: 'absent' },
    { ref: 'run-a/3', status: 'recheck', reason: 'absent' },
    { ref: 'run-a/4', status: 'recheck', reason: 'ambiguous' },
  ]
  const final = finalizePrevious(entries, new Map([['run-a/2', { disposition: 'rejected', rebuttal: { kind: 'unreachable' } }]]), { recheckRequested: new Set(['run-a/2', 'run-a/3']) })
  assert.deepEqual(final.map(entry => `${entry.status}:${entry.reason ?? entry.rebuttalKind ?? entry.basis}`), [
    'persisting:linked', 'resolved:unreachable', 'recheck:no-recheck-verdict', 'recheck:ambiguous',
  ])
  assert.equal(final[2].firstReason, 'absent')
})

test('경로 변화는 git의 대응을 따르고, 내용이 그대로인 이동은 바뀐 파일이 아니다', t => {
  const repo = mkdtempSync(join(tmpdir(), 'review-compare-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', '-c', 'core.autocrlf=false', ...args], { cwd: repo, encoding: 'utf8' }).trim()
  const write = (path, text) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  git('init', '-q')
  write('src/move.ts', 'export const moved = 1\nexport const also = 2\nexport const more = 3\n')
  write('src/edit.ts', 'a\n')
  write('src/gone.ts', 'b\n')
  git('add', '-A')
  git('commit', '-qm', 'a')
  const before = git('rev-parse', 'HEAD')
  mkdirSync(join(repo, 'src', 'lib'), { recursive: true })
  git('mv', 'src/move.ts', 'src/lib/move.ts')
  write('src/edit.ts', 'a\nb\n')
  git('rm', '-q', 'src/gone.ts')
  git('commit', '-qam', 'b')
  write('src/untracked.ts', 'c\n')
  const changes = pathChanges(repo, before)
  assert.deepEqual([...changes.renamed], [['src/move.ts', 'src/lib/move.ts']])
  assert.deepEqual([...changes.deleted], ['src/gone.ts'])
  assert.deepEqual([...changes.changed].sort(), ['src/edit.ts', 'src/untracked.ts'])
  assert.equal(pathChanges(repo, 'f'.repeat(40)), null)
})
