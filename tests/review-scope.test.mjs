import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { manifestsAt, scopeOf } from '../scripts/lib/review-scope.mjs'

// React 규칙이 다루지 않는 언어의 파일을 지적 대상에서 가른다(C-5). 2026-10-28 점검에서 michelo.studio(프론트·백엔드
// 모노레포)의 `f3a0e03b..HEAD` 범위를 preflight에 넣었더니 리뷰 대상 285개 중 `.py`가 94개였다. 그중 46개는 백엔드
// 테스트였는데 C-5의 이름 규칙(`__tests__`·`*.test.*`)에 걸리지 않아 테스트로도 빠지지 않았다. 아래 경로는 그 저장소의
// 모양을 줄인 것이다 — 루트에도 `pyproject.toml`(개발 실행기)이 있다.

const MONOREPO = ['pyproject.toml', 'apps/frontend/package.json', 'apps/backend/pyproject.toml']

test('다른 언어 앱(루트가 아닌 폴더의 매니페스트) 아래 파일은 outside로 가르고 앱마다 센다', () => {
  const scope = scopeOf([
    'apps/frontend/src/renderer/src/app.tsx',
    'apps/backend/api/routes.py',
    'apps/backend/docs/plc.md',
    'apps/backend/uv.lock',
  ], { manifests: MONOREPO })
  assert.deepEqual(scope.files, ['apps/frontend/src/renderer/src/app.tsx'])
  assert.deepEqual(scope.outside, ['apps/backend/api/routes.py', 'apps/backend/docs/plc.md', 'apps/backend/uv.lock'])
  assert.deepEqual(scope.otherApps, [{ root: 'apps/backend', manifest: 'pyproject.toml', files: 3 }])
})

test('다른 언어 앱의 테스트는 테스트·mock 제외보다 outside가 먼저다', () => {
  // 이름 규칙에 걸리는 파일(`*.test.*`)도 그 앱 안에 있으면 React 규칙이 다루지 않는다는 것이 더 앞선 사유다
  const scope = scopeOf(['apps/backend/tests/test_route.py', 'apps/backend/web/a.test.js'], { manifests: MONOREPO })
  assert.deepEqual([scope.files, scope.excluded], [[], []])
  assert.deepEqual(scope.outside, ['apps/backend/tests/test_route.py', 'apps/backend/web/a.test.js'])
})

test('저장소 루트의 다른 언어 매니페스트는 앱 경계가 아니다 — 루트의 CI·문서는 그대로 리뷰한다', () => {
  // 루트 `pyproject.toml`을 앱으로 보면 `.github/`·`docs/`처럼 어느 앱에도 속하지 않는 파일까지 빠진다.
  // 18(위험 변경)·16(API 계약)은 config/env·배포 산출물 설정을 본다
  const scope = scopeOf(['.github/workflows/frontend-test.yml', 'docs/spec.md', 'infra/runners/main.tf'], { manifests: MONOREPO })
  assert.deepEqual(scope.files, ['.github/workflows/frontend-test.yml', 'docs/spec.md', 'infra/runners/main.tf'])
  assert.deepEqual([scope.outside, scope.otherApps], [[], []])
})

test('다른 언어의 소스 파일은 매니페스트가 없어도 outside다 — React 앱 안에 있어도 그렇다', () => {
  // michelo.studio의 `manuals/`는 `.py` 25개가 있지만 매니페스트가 없다(백엔드 환경으로 실행한다)
  const scope = scopeOf(['manuals/export.py', 'apps/frontend/scripts/gen.py', 'apps/frontend/scripts/run.sh'], { manifests: MONOREPO })
  assert.deepEqual(scope.outside, ['manuals/export.py', 'apps/frontend/scripts/gen.py'])
  assert.deepEqual(scope.files, ['apps/frontend/scripts/run.sh'])
  assert.deepEqual(scope.otherApps, [])
})

test('더 가까운 package.json이 먼 다른 언어 매니페스트를 이긴다 — 한 폴더에 둘 다 있으면 JS다', () => {
  const manifests = [...MONOREPO, 'apps/backend/web/package.json', 'tools/hybrid/package.json', 'tools/hybrid/pyproject.toml']
  const scope = scopeOf(['apps/backend/web/src/main.ts', 'tools/hybrid/index.ts'], { manifests })
  assert.deepEqual(scope.files, ['apps/backend/web/src/main.ts', 'tools/hybrid/index.ts'])
  assert.deepEqual(scope.outside, [])
})

test('리뷰 대상 파일이 속한 package.json 폴더를 센다 — 프로필은 저장소 루트가 아니라 그 폴더에서 판정한다(C-3)', () => {
  const scope = scopeOf([
    'apps/frontend/src/renderer/src/app.tsx',
    'apps/frontend/package.json',
    'apps/frontend/src/a.test.ts',
    'packages/ui/button.tsx',
    'README.md',
  ], { manifests: ['package.json', 'apps/frontend/package.json', 'packages/ui/package.json'] })
  // 테스트로 뺀 파일은 세지 않는다. 루트 package.json의 폴더는 `.`이다
  assert.deepEqual(scope.packageRoots, [
    { root: 'apps/frontend', files: 2 },
    { root: 'packages/ui', files: 1 },
    { root: '.', files: 1 },
  ])
})

test('package.json이 하나도 없으면 packageRoots는 비어 있다 — 판정은 지금처럼 저장소 루트에서 한다', () => {
  assert.deepEqual(scopeOf(['src/app.tsx'], { manifests: [] }).packageRoots, [])
})

test('매니페스트를 주지 않으면 확장자만으로 가르고 C-5의 이름 규칙은 그대로다', () => {
  const scope = scopeOf(['src/app.ts', 'src/app.test.ts', 'server/main.py'])
  assert.deepEqual([scope.files, scope.excluded, scope.outside], [['src/app.ts'], ['src/app.test.ts'], ['server/main.py']])
})

test('manifestsAt는 하위 폴더에서 불러도 저장소 기준 경로로 매니페스트를 낸다', t => {
  const dir = mkdtempSync(join(tmpdir(), 'review-scope-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args,
  ], { cwd: dir, encoding: 'utf8' })
  git('init', '-q')
  for (const path of ['pyproject.toml', 'apps/frontend/package.json', 'apps/backend/pyproject.toml', 'apps/backend/api/x.py', 'apps/백엔드/go.mod']) {
    mkdirSync(join(dir, dirname(path)), { recursive: true })
    writeFileSync(join(dir, path), 'x\n')
  }
  git('add', '-A')
  git('commit', '-qm', 'tree')
  assert.deepEqual(manifestsAt(join(dir, 'apps', 'frontend')).sort(), [
    'apps/backend/pyproject.toml', 'apps/frontend/package.json', 'apps/백엔드/go.mod', 'pyproject.toml',
  ])
})
