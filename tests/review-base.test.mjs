import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { baseLine, resolveReviewBase } from '../scripts/lib/review-base.mjs'

// 리뷰 범위의 기준(C-4). 다른 PR 위에 쌓은 PR은 base가 아래 PR의 브랜치다 — main을 기준으로 잡으면 아래
// PR의 변경까지 리뷰한다(이 저장소의 #96이 그랬다). 지금 브랜치에 열린 PR이 있으면 그 base를 쓴다.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(ROOT, 'scripts', 'review-base.mjs')

// ── 고르는 규칙 ────────────────────────────────────────────────────────────

const has = (...refs) => ref => refs.includes(ref)
const openPr = (baseRefName, extra = {}) => ({ value: { number: 96, baseRefName, state: 'OPEN', url: 'https://example/pr/96', ...extra } })

test('사용자가 정한 범위가 언제나 먼저다 — PR이 있어도 보지 않는다', () => {
  const chosen = resolveReviewBase({ requested: 'release/1.2', pr: openPr('lower'), refExists: has('origin/lower', 'main') })
  assert.deepEqual([chosen.ref, chosen.source], ['release/1.2', 'user'])
})

test('열린 PR이 있으면 그 base를 쓰고, 원격 추적 브랜치를 같은 이름의 로컬 브랜치보다 먼저 본다', () => {
  const chosen = resolveReviewBase({ pr: openPr('lower'), refExists: has('origin/lower', 'lower', 'main'), originHead: 'origin/main' })
  assert.deepEqual([chosen.ref, chosen.source, chosen.stacked, chosen.pr.number], ['origin/lower', 'pr', true, 96])
  assert.match(baseLine(chosen), /PR #96의 base — 기본 브랜치가 아니라 `lower` 위에 쌓인 PR이다/)
  // 원격 추적 브랜치가 없으면 로컬 브랜치
  assert.equal(resolveReviewBase({ pr: openPr('lower'), refExists: has('lower', 'main') }).ref, 'lower')
})

test('PR의 base가 기본 브랜치면 쌓인 PR이 아니다 — 그래도 원격의 main을 쓴다', () => {
  const chosen = resolveReviewBase({ pr: openPr('main'), refExists: has('origin/main', 'main'), originHead: 'origin/main' })
  assert.deepEqual([chosen.ref, chosen.stacked], ['origin/main', false])
  assert.equal(baseLine(chosen), 'origin/main (PR #96의 base)')
})

test('PR의 base를 찾을 수 없으면 main으로 물러서지 않고 멈춘다', () => {
  const chosen = resolveReviewBase({ pr: openPr('lower'), refExists: has('main') })
  assert.match(chosen.error, /PR #96의 base `lower`를 이 저장소에서 찾을 수 없다 — `git fetch origin lower`/)
  assert.match(chosen.error, /main으로 물러서지 않는다/)
})

test('PR이 없거나 열려 있지 않으면 지금까지처럼 main → master → origin/HEAD이고, 그 이유를 남긴다', () => {
  const none = resolveReviewBase({ pr: { problem: '이 브랜치에 PR이 없다' }, refExists: has('master') })
  assert.deepEqual([none.ref, none.source, none.notes], ['master', 'default', ['이 브랜치에 PR이 없다']])
  const merged = resolveReviewBase({ pr: openPr('lower', { state: 'MERGED' }), refExists: has('origin/lower', 'main') })
  assert.deepEqual([merged.ref, merged.source], ['main', 'default'])
  assert.match(merged.notes[0], /MERGED 상태라 그 base를 기준으로 쓰지 않는다/)
  assert.equal(resolveReviewBase({ refExists: has('origin/develop'), originHead: 'origin/develop' }).ref, 'origin/develop')
  assert.match(resolveReviewBase({ refExists: has() }).error, /base를 정할 수 없다/)
})

// ── 실제 저장소에서 ───────────────────────────────────────────────────────
//
// main ← lower(아래 PR) ← upper(지금 브랜치). 아래 PR의 브랜치는 원격에만 있다(로컬 브랜치는 지웠다).

const scratch = t => {
  const dir = mkdtempSync(join(tmpdir(), 'review-base-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args,
  ], { cwd: dir, encoding: 'utf8' }).trim()
  const commit = (file, message) => {
    writeFileSync(join(dir, file), `${file}\n`)
    git('add', '-A')
    git('commit', '-qm', message)
  }
  git('init', '-q')
  commit('a.txt', 'base')
  return { dir, git, commit }
}

const stacked = t => {
  const repo = scratch(t)
  repo.git('switch', '-q', '-c', 'lower')
  repo.commit('lower.txt', 'lower PR')
  repo.git('switch', '-q', '-c', 'upper')
  repo.commit('upper.txt', 'upper PR')
  repo.git('update-ref', 'refs/remotes/origin/lower', repo.git('rev-parse', 'lower'))
  repo.git('update-ref', 'refs/remotes/origin/main', repo.git('rev-parse', 'main'))
  repo.git('branch', '-D', 'lower')
  return repo
}

const prFile = (repo, value) => {
  const path = join(repo.dir, '..', `${repo.dir.split(/[\\/]/).pop()}-pr.json`)
  writeFileSync(path, JSON.stringify(value), 'utf8')
  return path
}

const resolve = (repo, ...flags) => spawnSync(process.execPath, [SCRIPT, '--repo', repo.dir, ...flags], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

test('쌓인 PR은 아래 PR의 브랜치를 기준으로 리뷰한다 — 아래 PR의 변경은 범위에 없다', t => {
  const repo = stacked(t)
  const path = prFile(repo, { number: 96, baseRefName: 'lower', headRefName: 'upper', state: 'OPEN', url: 'u' })
  t.after(() => rmSync(path, { force: true }))
  const out = resolve(repo, '--pr-json', path)
  assert.equal(out.status, 0, out.stderr)
  const chosen = JSON.parse(out.stdout)
  assert.deepEqual([chosen.base, chosen.baseSource, chosen.stacked, chosen.changedFiles], ['origin/lower', 'pr', true, 1])
  assert.equal(chosen.mergeBase, repo.git('rev-parse', 'origin/lower'))
  assert.match(chosen.line, /`lower` 위에 쌓인 PR이다/)
  // PR을 보지 않으면 지금까지처럼 main 기준 — 아래 PR의 파일까지 둘이다
  const plain = JSON.parse(resolve(repo, '--no-pr').stdout)
  assert.deepEqual([plain.base, plain.baseSource, plain.changedFiles], ['main', 'default', 2])
  assert.deepEqual(plain.notes, ['PR을 보지 않았다(--no-pr)'])
})

test('사용자가 범위를 주면 PR을 읽지 않는다', t => {
  const repo = stacked(t)
  const chosen = JSON.parse(resolve(repo, '--base', 'main', '--pr-json', join(repo.dir, 'does-not-exist.json')).stdout)
  assert.deepEqual([chosen.base, chosen.baseSource, chosen.changedFiles], ['main', 'user', 2])
})

test('PR의 base 브랜치를 받아 두지 않았으면 멈추고 무엇을 할지 말한다', t => {
  const repo = stacked(t)
  const path = prFile(repo, { number: 96, baseRefName: 'feature/gone', state: 'OPEN' })
  t.after(() => rmSync(path, { force: true }))
  const out = resolve(repo, '--pr-json', path)
  assert.equal(out.status, 2)
  assert.match(out.stderr, /git fetch origin feature\/gone/)
})

test('PR의 base가 main이면 뒤처진 로컬 main이 아니라 원격의 main을 기준으로 쓴다', t => {
  // 2026-10-06: 브랜치가 최신 origin/main을 merge했는데 로컬 main은 아직 pull 전이었다. 로컬 main을 기준으로
  // 잡아, 이미 main에 들어간 다른 PR의 파일까지 리뷰했다.
  const repo = scratch(t)
  const old = repo.git('rev-parse', 'HEAD')
  repo.commit('other-pr.txt', 'other PR merged into main')
  repo.git('update-ref', 'refs/remotes/origin/main', repo.git('rev-parse', 'HEAD'))
  repo.git('reset', '-q', '--hard', old)
  repo.git('switch', '-q', '-c', 'feature')
  repo.commit('feature.txt', 'feature')
  repo.git('merge', '-q', '--no-edit', 'origin/main')
  const path = prFile(repo, { number: 7, baseRefName: 'main', state: 'OPEN' })
  t.after(() => rmSync(path, { force: true }))
  const viaPr = JSON.parse(resolve(repo, '--pr-json', path).stdout)
  assert.deepEqual([viaPr.base, viaPr.stacked, viaPr.changedFiles], ['origin/main', false, 1])
  const viaLocal = JSON.parse(resolve(repo, '--no-pr').stdout)
  assert.deepEqual([viaLocal.base, viaLocal.changedFiles], ['main', 2])
})

test('--no-pr와 --pr-json은 함께 받지 않는다', t => {
  const repo = scratch(t)
  const out = resolve(repo, '--no-pr', '--pr-json', 'x.json')
  assert.equal(out.status, 2)
  assert.match(out.stderr, /함께 줄 수 없다/)
})
