import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  REUSE_LIMITS, anchorProblems, candidateWindows, changedRanges, overallStatus, parseGrepOutput, planProblems, searchTarget, summarizeTargets,
} from '../scripts/lib/reuse-context.mjs'

// 기존 구현 검색의 순수한 부분을 고정한다 — 계획 검사, diff의 새 쪽 범위, git grep 출력, 후보 구간, 상태 집계.
// 계획은 모델이 쓰는 부분이라 가장 약한 고리다. scope의 모든 파일에 결정이 하나씩 있어야 검색을 시작한다.

const SCOPE = { schemaVersion: 1, runId: 'r-1', mergeBase: 'm'.repeat(40), head: 'h'.repeat(40), files: ['src/a.ts', 'src/b.ts'], excluded: ['src/a.test.ts'] }
const CTX = { scope: SCOPE, runId: 'r-1', head: 'h'.repeat(40), mergeBase: 'm'.repeat(40), searchId: 's1', scopeSha256: 'x'.repeat(64) }
const target = extra => ({ targetId: 't1', anchor: { path: 'src/a.ts', startLine: 2, endLine: 3, quote: 'b\nc' }, purpose: '경로를 정규화한다', queries: [{ text: 'normalize' }], ...extra })
const plan = extra => ({
  schemaVersion: 1, runId: 'r-1', searchId: 's1', head: 'h'.repeat(40), mergeBase: 'm'.repeat(40), scopeSha256: 'x'.repeat(64),
  fileDecisions: [{ path: 'src/a.ts', decision: 'search', targetIds: ['t1'] }, { path: 'src/b.ts', decision: 'exclude', reason: '문구만 바꿨다' }],
  targets: [target()],
  ...extra,
})

test('scope의 모든 파일에 결정이 하나씩 있고 대상이 맞물리면 문제가 없다', () => {
  assert.deepEqual(planProblems(plan(), CTX), [])
  // 대상이 0개여도 결정 목록이 완전하면 된다 — not-applicable로 끝난다
  assert.deepEqual(planProblems(plan({ fileDecisions: SCOPE.files.map(path => ({ path, decision: 'exclude', reason: '삭제만 했다' })), targets: [] }), CTX), [])
})

test('결정이 빠지거나 겹치거나 범위 밖이면 검색 전에 거부한다', () => {
  const cases = [
    [plan({ fileDecisions: [{ path: 'src/a.ts', decision: 'search', targetIds: ['t1'] }] }), /src\/b\.ts에 결정이 없다/],
    [plan({ fileDecisions: [...plan().fileDecisions, { path: 'src/b.ts', decision: 'exclude', reason: '또' }] }), /src\/b\.ts의 결정이 2개다/],
    [plan({ fileDecisions: [...plan().fileDecisions, { path: 'src/a.test.ts', decision: 'exclude', reason: '테스트' }] }), /src\/a\.test\.ts는 scope\.files에 없다/],
    [plan({ fileDecisions: [plan().fileDecisions[0], { path: 'src/b.ts', decision: 'exclude', reason: '  ' }] }), /src\/b\.ts의 제외 사유가 비었다/],
    [plan({ fileDecisions: [{ path: 'src/a.ts', decision: 'search', targetIds: [] }, plan().fileDecisions[1]] }), /src\/a\.ts는 search인데 대상이 없다/],
    [plan({ fileDecisions: [{ path: 'src/a.ts', decision: 'search', targetIds: ['t9'] }, plan().fileDecisions[1]] }), /없는 targetId t9/],
    [plan({ fileDecisions: [{ path: 'src/a.ts', decision: 'maybe' }, plan().fileDecisions[1]] }), /decision은 search나 exclude다/],
    [plan({ targets: [target({ anchor: { ...target().anchor, path: 'src/b.ts' } })] }), /t1의 anchor\(src\/b\.ts\)가 그 대상을 고른 파일의 결정과 맞지 않는다/],
    [plan({ targets: [target({ queries: [] })] }), /t1에 검색어가 없다/],
    [plan({ targets: [target({ queries: [{ text: '' }] })] }), /t1의 검색어가 비었다/],
    [plan({ targets: [target(), target()] }), /targetId t1이 2번 나온다/],
  ]
  for (const [value, pattern] of cases) {
    const problems = planProblems(value, CTX)
    assert.ok(problems.some(problem => pattern.test(problem)), `${pattern} — ${problems.join(' / ')}`)
  }
})

test('계획의 실행 ID·검색 ID·HEAD·merge-base·scope 해시가 이 실행과 다르면 거부한다', () => {
  for (const key of ['runId', 'searchId', 'head', 'mergeBase', 'scopeSha256']) {
    const problems = planProblems(plan({ [key]: 'other' }), CTX)
    assert.ok(problems.some(problem => problem.includes(key)), `${key} — ${problems.join(' / ')}`)
  }
  assert.ok(planProblems(null, CTX).length > 0)
})

test('diff의 새 쪽 범위를 읽는다 — 줄 수 0은 삭제만 한 hunk다', () => {
  const diff = ['diff --git a/x b/x', '@@ -1,0 +2,3 @@', '+a', '+b', '+c', '@@ -10 +14 @@', '-x', '+y', '@@ -20,2 +23,0 @@', '-p', '-q'].join('\n')
  assert.deepEqual(changedRanges(diff), [{ start: 2, end: 4 }, { start: 14, end: 14 }])
})

test('anchor는 HEAD의 줄·인용과 맞고 이번 변경에 닿아야 한다', () => {
  const headText = 'a\nb\nc\nd\n'
  assert.deepEqual(anchorProblems(target(), { headText, ranges: [{ start: 3, end: 3 }] }), [])
  assert.match(anchorProblems(target(), { headText, ranges: [{ start: 4, end: 4 }] }).join(), /이번 변경에 닿지 않는다/)
  assert.match(anchorProblems(target({ anchor: { ...target().anchor, quote: 'b\nX' } }), { headText, ranges: [{ start: 3, end: 3 }] }).join(), /인용이 HEAD와 다르다/)
  assert.match(anchorProblems(target({ anchor: { ...target().anchor, endLine: 99 } }), { headText, ranges: [{ start: 3, end: 3 }] }).join(), /줄 범위가 파일 밖이다/)
  assert.match(anchorProblems(target(), { headText: null, ranges: [] }).join(), /HEAD에서 읽지 못했다/)
})

test('git grep -z 출력을 경로·줄·내용으로 나눈다 — 한글·공백 경로와 콜론이 든 내용도', () => {
  const rev = 'h'.repeat(40)
  const out = `${rev}:src/한글 폴더/새 파서.ts\u000012\u0000const a = b: c\n${rev}:src/x.ts\u00003\u0000x\n`
  assert.deepEqual(parseGrepOutput(out, rev), [
    { path: 'src/한글 폴더/새 파서.ts', line: 12, text: 'const a = b: c' },
    { path: 'src/x.ts', line: 3, text: 'x' },
  ])
})

test('같은 파일의 가까운 hit는 한 후보 구간으로 묶고, 구간 길이에 상한을 둔다', () => {
  const windows = candidateWindows([10, 12, 80], 100, { linesBefore: 2, linesAfter: 5, quoteLines: 40 })
  assert.deepEqual(windows.map(({ start, end, hits }) => [start, end, hits]), [[8, 17, [10, 12]], [78, 85, [80]]])
  const capped = candidateWindows([1], 100, { linesBefore: 0, linesAfter: 90, quoteLines: 10 })
  assert.deepEqual([capped[0].start, capped[0].end, capped[0].truncated], [1, 10, true])
})

test('대상별 상태를 세고, 전체 상태를 정한다 — 대상이 없으면 not-applicable, 계획이 틀리면 failed', () => {
  const targets = [{ status: 'complete' }, { status: 'partial' }, { status: 'complete' }]
  assert.deepEqual(summarizeTargets(targets), { complete: 2, partial: 1 })
  assert.equal(overallStatus(targets, { planOk: true }), 'partial')
  assert.equal(overallStatus([{ status: 'complete' }], { planOk: true }), 'complete')
  assert.equal(overallStatus([], { planOk: true }), 'not-applicable')
  assert.equal(overallStatus([], { planOk: false }), 'failed')
  assert.equal(overallStatus([{ status: 'failed' }, { status: 'failed' }], { planOk: true }), 'failed')
})

// 대상 자신은 후보가 아니다. anchor가 구현의 몇 줄만 가리켜도, 그 바로 옆 줄의 hit가 만든 구간은 anchor와 겹쳐 대상
// 자신을 다시 인용한다 — 평가 fixture에서 그렇게 to-display-path.ts:3-6이 자기 후보로 남았다. 같은 파일의 다른 구현은
// 남는다: anchor에서 떨어진 hit는 후보이고, 그 구간이 anchor까지 뻗으면 anchor 앞에서 자른다.
// 검색 범위(paths)를 지키는 가짜 git — '.'은 전체, 그 밖은 그 디렉터리 아래만
const inScope = (path, paths) => !paths?.length || paths.some(scope => scope === '.' || path === scope || path.startsWith(`${scope}/`))
const fakeGit = files => ({
  grep: (rev, text, paths) => ({
    ok: true,
    out: Object.entries(files).filter(([path]) => inScope(path, paths)).flatMap(([path, body]) => body.split('\n').map((line, at) => (line.includes(text) ? `${rev}:${path}\0${at + 1}\0${line}` : null)).filter(Boolean)).join('\n'),
  }),
  show: (rev, path) => (rev === 'h'.repeat(40) ? files[path] ?? null : null),
})
const searchIn = (files, anchor, texts) => searchTarget(
  { targetId: 't1', anchor, purpose: 'p', queries: texts.map(text => ({ text })) },
  { git: fakeGit(files), head: 'h'.repeat(40), mergeBase: 'm'.repeat(40), baseHead: null, limits: REUSE_LIMITS, deadline: Date.now() + 60000, budget: { remaining: 40 } },
)

test('대상 자신은 후보가 아니다 — anchor 옆 줄의 hit도 같은 구현이다. 같은 파일의 떨어진 구현은 남는다', () => {
  const files = {
    'src/a/new.ts': ['// c', 'export const f = (input: string) =>', '  input', "    .split('/')", '    .filter(s => s.length > 0)', "    .join('/')", '', 'export const g = (raw: string) =>', '  raw', "    .split('/')", '    .filter(Boolean)', "    .join('/')"].join('\n'),
    'src/shared/norm.ts': ['export function norm(raw: string) {', '  return raw', "    .split('/')", '    .filter(Boolean)', "    .join('/')", '}'].join('\n'),
  }
  const result = searchIn(files, { path: 'src/a/new.ts', startLine: 4, endLine: 5, quote: "    .split('/')\n    .filter(s => s.length > 0)" }, [".split('/')", ".join('/')"])
  assert.deepEqual(result.candidates.map(found => [found.path, found.startLine, found.endLine]).sort(), [['src/a/new.ts', 7, 12], ['src/shared/norm.ts', 1, 6]])
})

test('anchor 앞의 같은 파일 구현은 남기되, 그 구간을 anchor 앞에서 자른다', () => {
  const files = { 'src/b/new.ts': ["const h = (x: string) => x.split('/').join('/')", '', '', '', 'export const k = (y: string) =>', "  y.split('/').join('/')"].join('\n') }
  const result = searchIn(files, { path: 'src/b/new.ts', startLine: 5, endLine: 6, quote: "export const k = (y: string) =>\n  y.split('/').join('/')" }, [".split('/')"])
  assert.deepEqual(result.candidates.map(found => [found.path, found.startLine, found.endLine]), [['src/b/new.ts', 1, 4]])
})

// 기존 구현(A)은 대개 다른 곳(shared·다른 기능)에 있다. 함수 이름 같은 검색어가 같은 기능 폴더의 호출자에 맞았다고
// 다른 검색어의 저장소 전체 검색을 건너뛰면, 기능이 찾으려던 A를 놓치고 complete로 끝난다(평가 fixture에서 재현).
test('가까운 곳에 hit가 있어도 저장소 전체를 찾는다 — 호출자 hit가 다른 곳의 기존 구현을 가리지 않는다', () => {
  const files = {
    'src/features/fb/lib/to-display.ts': ['export const toDisplayPath = (input: string) =>', "  input.split('/').filter(Boolean).join('/')"].join('\n'),
    'src/features/fb/ui/row.tsx': ["import { toDisplayPath } from '../lib/to-display'", '', '', '', '', 'export const Row = ({ p }) => <span>{toDisplayPath(p)}</span>'].join('\n'),
    'src/shared/lib/norm.ts': ['export function norm(raw: string) {', "  return raw.split('/').filter(Boolean).join('/')", '}'].join('\n'),
  }
  const result = searchIn(files, { path: 'src/features/fb/lib/to-display.ts', startLine: 1, endLine: 2, quote: "export const toDisplayPath = (input: string) =>\n  input.split('/').filter(Boolean).join('/')" }, ['toDisplayPath', ".split('/')"])
  assert.equal(result.status, 'complete')
  assert.ok(result.candidates.some(found => found.path === 'src/shared/lib/norm.ts'), JSON.stringify(result.candidates.map(found => found.path)))
  // 같은 hit를 두 범위에서 두 번 세지 않는다 — 대상 자신 1(가까운 곳·전체 양쪽에 든다) + norm.ts 1
  const split = result.queries.find(query => query.text === ".split('/')")
  assert.equal(split.hits, 2)
})

// git grep -F는 검색어의 줄마다 따로 찾는다 — 끝에 줄바꿈이 붙으면 빈 패턴이 모든 줄에 맞는다. 검색 경로는 저장소 안의
// `/` 상대 경로다 — Windows의 `scripts\lib`는 아무것도 찾지 못한 채 complete가 되고, `:(top)` 같은 pathspec 마법은
// 범위를 바꾼다.
test('검색어의 줄바꿈과 저장소 상대 경로가 아닌 검색 경로를 거부한다', () => {
  const withQuery = query => plan({ targets: [target({ queries: [query] })] })
  for (const text of ['REUSE_LIMITS\n', 'A\nB', 'A\r\nB']) {
    assert.ok(planProblems(withQuery({ text }), CTX).some(problem => /줄바꿈/.test(problem)), JSON.stringify(text))
  }
  for (const path of ['scripts\\lib', '/abs/path', 'C:/repo/src', ':(top)src', ':/src', '../src']) {
    assert.ok(planProblems(withQuery({ text: 'x', paths: [path] }), CTX).some(problem => /검색 경로/.test(problem)), path)
  }
  assert.deepEqual(planProblems(withQuery({ text: 'x', paths: ['src/shared', 'src/한글 폴더'] }), CTX), [])
})

// 원문 바이트 상한은 한 줄에도 걸린다 — 압축된 번들의 한 줄이 그대로 05 프롬프트에 들어가면 상한이 의미가 없다.
// 코드가 아닌 파일(SVG·JSON 데이터·문서·압축된 번들)은 재사용할 구현 후보와 가른다.
test('한 줄짜리 거대 원문도 바이트 상한에서 자르고, 코드가 아닌 파일은 other로 가른다', () => {
  const huge = `export const bundle=${'x'.repeat(200000)}.split('/')`
  const files = {
    'src/feature/new.ts': ["export const f = (s: string) => s.split('/')"].join('\n'),
    'dist/app.min.js': huge,
    'public/logo.svg': "<svg><path d=\"a.split('/')\"/></svg>",
    'docs/notes.md': "경로는 .split('/')로 나눈다",
    'src/shared/split.ts': ["export const g = (s: string) => s.split('/')"].join('\n'),
  }
  const result = searchIn(files, { path: 'src/feature/new.ts', startLine: 1, endLine: 1, quote: "export const f = (s: string) => s.split('/')" }, [".split('/')"])
  const bundle = result.candidates.find(found => found.path === 'dist/app.min.js')
  assert.ok(Buffer.byteLength(bundle.quote, 'utf8') <= REUSE_LIMITS.quoteBytes, String(Buffer.byteLength(bundle.quote, 'utf8')))
  assert.equal(bundle.truncated, true)
  const kinds = Object.fromEntries(result.candidates.map(found => [found.path, found.kind]))
  assert.deepEqual(kinds, { 'src/shared/split.ts': 'production', 'dist/app.min.js': 'other', 'public/logo.svg': 'other', 'docs/notes.md': 'other' })
  assert.equal(result.candidates[0].path, 'src/shared/split.ts', '구현 후보가 먼저다')
})
