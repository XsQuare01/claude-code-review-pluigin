import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// preflight를 쓰지 않는 워크플로우(default·commit·fast·props·math·exception)도 같은 규칙으로 범위를 가른다(C-5).
// 예전에는 오케스트레이터가 C-5의 이름 규칙을 손으로 적용했고, React 규칙이 다루지 않는 언어는 가르지 않았다.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(ROOT, 'scripts', 'review-scope.mjs')

const monorepo = t => {
  const dir = mkdtempSync(join(tmpdir(), 'review-scope-cli-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args,
  ], { cwd: dir, encoding: 'utf8' }).trim()
  const commit = (paths, message) => {
    for (const path of paths) {
      mkdirSync(join(dir, dirname(path)), { recursive: true })
      writeFileSync(join(dir, path), `${path} ${message}\n`)
    }
    git('add', '-A')
    git('commit', '-qm', message)
    return git('rev-parse', 'HEAD')
  }
  git('init', '-q')
  const base = commit(['pyproject.toml', 'apps/frontend/package.json', 'apps/backend/pyproject.toml'], 'base')
  return { dir, base, commit }
}

const scope = (repo, ...flags) => spawnSync(process.execPath, [SCRIPT, '--repo', repo.dir, ...flags], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

test('--merge-base는 merge-base부터 HEAD까지 바뀐 파일을 셋으로 가르고 리포트에 옮길 줄을 낸다', t => {
  const repo = monorepo(t)
  repo.commit([
    'apps/frontend/src/a.tsx',
    'apps/frontend/src/a.test.ts',
    'apps/backend/api/x.py',
    'apps/backend/tests/test_x.py',
    'manuals/export.py',
    '.github/workflows/ci.yml',
  ], 'change')
  const out = scope(repo, '--merge-base', repo.base)
  assert.equal(out.status, 0, out.stderr)
  const result = JSON.parse(out.stdout)
  assert.deepEqual(result.files.sort(), ['.github/workflows/ci.yml', 'apps/frontend/src/a.tsx'])
  assert.deepEqual(result.excluded, ['apps/frontend/src/a.test.ts'])
  assert.deepEqual(result.outside.sort(), ['apps/backend/api/x.py', 'apps/backend/tests/test_x.py', 'manuals/export.py'])
  assert.deepEqual(result.otherApps, [{ root: 'apps/backend', manifest: 'pyproject.toml', files: 2 }])
  assert.deepEqual(result.packageRoots, [{ root: 'apps/frontend', files: 1 }])
  assert.equal(result.line, '리뷰 대상 2개 · 테스트·mock 제외 1개 · 검토 안 함 3개 — React 규칙이 다루지 않는 언어: apps/backend(pyproject.toml) 2개 · 그 밖의 소스 1개')
})

test('검토 안 함이 없으면 줄에 그 말을 넣지 않는다', t => {
  const repo = monorepo(t)
  repo.commit(['apps/frontend/src/a.tsx'], 'change')
  const result = JSON.parse(scope(repo, '--merge-base', repo.base).stdout)
  assert.equal(result.line, '리뷰 대상 1개 · 테스트·mock 제외 0개')
})

test('--commit은 그 커밋 하나가 바꾼 파일만 가르고, 매니페스트도 그 커밋의 트리에서 읽는다', t => {
  // 커밋 A 때는 apps/tools가 다른 언어 앱이 아니었다. 나중 커밋이 매니페스트를 더해도 A의 리뷰는 A의 트리로 한다
  const repo = monorepo(t)
  const first = repo.commit(['apps/tools/notes.md', 'apps/frontend/src/b.tsx'], 'A')
  repo.commit(['apps/tools/go.mod', 'apps/backend/api/y.py'], 'B')
  const out = scope(repo, '--commit', first)
  assert.equal(out.status, 0, out.stderr)
  const result = JSON.parse(out.stdout)
  assert.deepEqual(result.files.sort(), ['apps/frontend/src/b.tsx', 'apps/tools/notes.md'])
  assert.deepEqual([result.excluded, result.outside], [[], []])
})

test('--commit은 부모가 없는 첫 커밋도 가른다', t => {
  const repo = monorepo(t)
  const result = JSON.parse(scope(repo, '--commit', repo.base).stdout)
  assert.deepEqual(result.files.sort(), ['apps/frontend/package.json', 'pyproject.toml'])
  assert.deepEqual(result.outside, ['apps/backend/pyproject.toml'])
})

test('--merge-base와 --commit 중 정확히 하나를 받는다', t => {
  const repo = monorepo(t)
  for (const flags of [[], ['--merge-base', repo.base, '--commit', repo.base]]) {
    const out = scope(repo, ...flags)
    assert.equal(out.status, 2, flags.join(' '))
    assert.match(out.stderr, /--merge-base와 --commit 중 하나/)
  }
})
