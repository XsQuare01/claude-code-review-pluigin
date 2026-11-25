import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { classifyFailures, failureCounts, failureLocations } from '../scripts/lib/tool-failures.mjs'

// 도구가 실패한 자리를 출력에서 읽는다(C-6). 2026-10-13 실행의 lint 실패는 전부 .gitignore에 든 `tmp/` 아래였고,
// 테스트 실패 3건은 이 변경이 건드리지 않은 파일이었다(둘은 시간 초과) — 로그에 있던 사실인데 리포트에는 "baseline
// 미측정"만 있었다. 아래 출력은 그 실행의 로그 모양을 줄인 것이다.

const ESLINT = [
  '> eslint --cache --max-warnings 0 .',
  '',
  'C:\\Users\\me\\repo\\tmp\\preview\\generate.cjs',
  '   1:1   error    \'require\' is not defined  no-undef',
  '  46:14  warning  Replace `error·=>·{` with `(error)·=>·{`  prettier/prettier',
  '',
  '/home/me/repo/src/a.ts',
  '  3:7  error  \'x\' is assigned a value but never used  no-unused-vars',
  '',
  '✖ 3 problems (2 errors, 1 warning)',
].join('\n')

const VITEST = [
  ' RUN  v5.0.0 C:/repo',
  '\u001b[31m FAIL \u001b[39m |default| src/widgets/a/__tests__/Panel.test.tsx > Panel > 워드 길이 칸이 생긴다',
  'Error: Test timed out in 5000ms.',
  ' FAIL  |default| src/widgets/b/__tests__/Selection.test.tsx > 세션 선택 > 열기',
  'TestingLibraryElementError: Unable to find role="button"',
  ' Test Files  2 failed | 10 passed (12)',
].join('\n')

test('ESLint stylish의 파일 머리와 문제 줄을 센다 — 경고도 센다(--max-warnings 0이면 실패다)', () => {
  const files = failureLocations(ESLINT)
  assert.deepEqual([...files.keys()], ['C:\\Users\\me\\repo\\tmp\\preview\\generate.cjs', '/home/me/repo/src/a.ts'])
  assert.deepEqual(files.get('C:\\Users\\me\\repo\\tmp\\preview\\generate.cjs'), { errors: 1, warnings: 1, failed: 0, timeouts: 0 })
  assert.equal(files.get('/home/me/repo/src/a.ts').errors, 1)
})

test('tsc의 두 모양과 vitest·jest의 FAIL 줄, 색 코드 섞인 줄, 시간 초과를 읽는다', () => {
  const tsc = failureLocations([
    'src/a.ts(12,5): error TS2322: Type \'string\' is not assignable to type \'number\'.',
    'src/b.tsx:3:1 - error TS2304: Cannot find name \'x\'.',
    'Found 2 errors in 2 files.',
  ].join('\n'))
  assert.deepEqual([...tsc.keys()], ['src/a.ts', 'src/b.tsx'])
  const vitest = failureLocations(VITEST)
  assert.deepEqual([...vitest.keys()], ['src/widgets/a/__tests__/Panel.test.tsx', 'src/widgets/b/__tests__/Selection.test.tsx'])
  assert.deepEqual([vitest.get('src/widgets/a/__tests__/Panel.test.tsx').timeouts, vitest.get('src/widgets/b/__tests__/Selection.test.tsx').timeouts], [1, 0])
  const jest = failureLocations(' FAIL  src/c.test.js\n  ● c › slow\n    thrown: "Exceeded timeout of 5000 ms for a test."')
  assert.deepEqual([...jest.entries()], [['src/c.test.js', { errors: 0, warnings: 0, failed: 1, timeouts: 1 }]])
  assert.equal(failureLocations('Error: Cannot find module\n    at node:internal').size, 0)
})

test('저장소 기준으로 이 변경의 파일·바꾸지 않은 파일·추적하지 않는 파일로 가른다', t => {
  const repo = mkdtempSync(join(tmpdir(), 'tool-failures-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' })
  git('init', '-q')
  mkdirSync(join(repo, 'src'))
  mkdirSync(join(repo, 'tmp'))
  writeFileSync(join(repo, '.gitignore'), 'tmp/\n')
  writeFileSync(join(repo, 'src', 'a.ts'), 'a\n')
  writeFileSync(join(repo, 'src', 'b.test.ts'), 'b\n')
  writeFileSync(join(repo, 'tmp', 'x.cjs'), 'x\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  const text = [
    join(repo, 'tmp', 'x.cjs'),
    '  1:1  error  bad  no-undef',
    '',
    join(repo, 'src', 'a.ts'),
    '  1:1  error  bad  no-undef',
    '',
    ' FAIL  src/b.test.ts > b',
    'Error: Test timed out in 5000ms.',
  ].join('\n')
  const classified = classifyFailures(failureLocations(text), { repo, changed: ['src/a.ts'] })
  assert.deepEqual(classified, {
    parsed: true, files: 3, inChange: ['src/a.ts'], outsideChange: ['src/b.test.ts'], untracked: ['tmp/x.cjs'],
    timeouts: 1, timedOutFiles: ['src/b.test.ts'],
  })
  assert.deepEqual(failureCounts(classified), { inChange: 1, outsideChange: 1, untracked: 1 })
  // 변경 목록을 모르면 추적 여부만 가른다 — 바꾸지 않은 파일이라고 말하지 않는다
  const unknown = classifyFailures(failureLocations(text), { repo, changed: null })
  assert.deepEqual([unknown.tracked, unknown.untracked, 'outsideChange' in unknown], [['src/a.ts', 'src/b.test.ts'], ['tmp/x.cjs'], false])
  // 아는 모양이 하나도 없으면 읽지 못했다고만 한다
  assert.deepEqual(classifyFailures(failureLocations('segfault'), { repo, changed: [] }), { parsed: false })
  assert.equal(failureCounts({ parsed: false }), null)
})

// 2026-11-25 실행은 `npm --prefix apps/frontend test`를 저장소 루트에서 돌렸다. vitest는 경로를 앱 폴더 기준
// (`src/…`)으로 찍는데, 그 경로를 저장소 루트 기준으로 풀어 세 파일이 모두 `untracked`가 됐다. 모두 추적되는 테스트
// 파일이었다. SKILL은 `untracked`만의 실패를 "이 변경·저장소와 무관"으로 적고 차단 사유에서 빼라고 하므로, 이
// 변경이 깨뜨린 테스트도 그렇게 빠질 수 있었다.
test('출력 경로가 저장소 루트가 아니라 패키지 루트 기준이면 그 폴더에서 찾고, 하나로 정해지지 않으면 untracked로 세지 않는다', t => {
  const repo = mkdtempSync(join(tmpdir(), 'tool-failures-mono-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' })
  git('init', '-q')
  mkdirSync(join(repo, 'apps', 'web', 'src'), { recursive: true })
  mkdirSync(join(repo, 'apps', 'admin', 'src'), { recursive: true })
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'apps', 'web', 'src', 'a.test.ts'), 'a\n')
  writeFileSync(join(repo, 'apps', 'web', 'src', 'b.test.ts'), 'b\n')
  // 두 패키지 루트에 같은 경로가 있다 — 어느 쪽인지 출력만으로는 모른다
  writeFileSync(join(repo, 'apps', 'web', 'src', 'same.test.ts'), 's\n')
  writeFileSync(join(repo, 'apps', 'admin', 'src', 'same.test.ts'), 's\n')
  // 저장소 루트 기준으로 바로 풀리는 파일은 지금처럼 그 자리다
  writeFileSync(join(repo, 'src', 'root.test.ts'), 'r\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  const text = [
    ' FAIL  src/a.test.ts > a',
    'Error: Test timed out in 5000ms.',
    ' FAIL  src/b.test.ts > b',
    ' FAIL  src/same.test.ts > s',
    ' FAIL  src/gone.test.ts > g',
    ' FAIL  src/root.test.ts > r',
  ].join('\n')
  const classified = classifyFailures(failureLocations(text), {
    repo, changed: ['apps/web/src/a.test.ts'], packageRoots: ['apps/web', 'apps/admin', '.'],
  })
  assert.deepEqual(classified, {
    parsed: true, files: 5,
    // 패키지 루트 한 곳에만 있으면 그 자리다
    inChange: ['apps/web/src/a.test.ts'],
    outsideChange: ['apps/web/src/b.test.ts', 'src/root.test.ts'],
    untracked: [],
    // 두 곳에 있거나(same) 어디에도 없으면(gone) 자리를 정하지 못한 것이다 — 추적하지 않는 파일이 아니다
    unlocated: ['src/gone.test.ts', 'src/same.test.ts'],
    timeouts: 1, timedOutFiles: ['apps/web/src/a.test.ts'],
  })
  assert.deepEqual(failureCounts(classified), { inChange: 1, outsideChange: 2, untracked: 0, unlocated: 2 })
  // 패키지 루트를 모르면 저장소 루트에서만 찾는다 — 없는 파일을 untracked로 세지 않는다
  const rootOnly = classifyFailures(failureLocations(text), { repo, changed: ['apps/web/src/a.test.ts'] })
  assert.deepEqual([rootOnly.untracked, rootOnly.unlocated], [[], ['src/a.test.ts', 'src/b.test.ts', 'src/gone.test.ts', 'src/same.test.ts']])
})
