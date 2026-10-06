import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  currentTarget, normalizeRemote, repoIdentity, rulesDigest, newRunId,
} from '../scripts/lib/run-identity.mjs'

// 실행이 **무엇을** 리뷰했는지를 기록에서 가려내는 계산을 고정한다(#88 PR 0).
//
// 같은 HEAD라도 작업 트리가 다르면 producer가 읽은 파일 내용이 다르다 — 위치 확인은
// 작업 트리를 읽는다. HEAD만 보고 같은 대상으로 치면, 바뀐 트리에 이전 판정을 붙이는
// 길이 열린다.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const RULES = join(ROOT, 'review-rules')

const git = (dir, ...args) => execFileSync('git', [
  '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false',
  '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false', ...args,
], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const freshRepo = t => {
  const dir = mkdtempSync(join(tmpdir(), 'run-identity-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  git(dir, 'init', '-q')
  git(dir, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  writeFileSync(join(dir, 'b.txt'), 'b\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'base')
  return dir
}

test('깨끗한 작업 트리는 clean이고 변경 0개다', t => {
  const repo = freshRepo(t)
  const target = currentTarget(repo)
  assert.equal(target.worktree, 'clean')
  assert.equal(target.dirtyFiles, 0)
  assert.equal(target.head, git(repo, 'rev-parse', 'HEAD'))
})

test('같은 HEAD의 다른 작업 트리는 다른 검토 대상이다', t => {
  const repo = freshRepo(t)
  writeFileSync(join(repo, 'a.txt'), 'first edit\n')
  const first = currentTarget(repo)
  writeFileSync(join(repo, 'a.txt'), 'second edit\n')
  const second = currentTarget(repo)
  assert.equal(first.head, second.head)
  assert.match(first.worktree, /^sha256:[0-9a-f]{64}$/)
  assert.notEqual(first.worktree, second.worktree)
  assert.equal(first.dirtyFiles, 1)
})

test('같은 내용으로 돌아오면 같은 fingerprint다 — 시각이나 순서가 섞이지 않는다', t => {
  const repo = freshRepo(t)
  writeFileSync(join(repo, 'a.txt'), 'edit\n')
  const first = currentTarget(repo)
  writeFileSync(join(repo, 'a.txt'), 'other\n')
  writeFileSync(join(repo, 'a.txt'), 'edit\n')
  assert.equal(currentTarget(repo).worktree, first.worktree)
  // 되돌리면 clean으로 돌아온다
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  assert.equal(currentTarget(repo).worktree, 'clean')
})

test('index는 보지 않는다 — 스테이징했다가 작업 트리를 HEAD로 되돌리면 clean이다', t => {
  // 리뷰가 읽는 것은 작업 트리다. index에만 남은 변경은 아무도 읽지 않는다.
  const repo = freshRepo(t)
  writeFileSync(join(repo, 'a.txt'), 'staged\n')
  git(repo, 'add', 'a.txt')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  assert.equal(currentTarget(repo).worktree, 'clean')
})

test('추적하지 않는 파일과 지운 파일도 대상에 들어간다', t => {
  const repo = freshRepo(t)
  writeFileSync(join(repo, 'new.txt'), 'n\n')
  const untracked = currentTarget(repo)
  assert.equal(untracked.dirtyFiles, 1)
  assert.notEqual(untracked.worktree, 'clean')
  rmSync(join(repo, 'new.txt'))
  unlinkSync(join(repo, 'b.txt'))
  const deleted = currentTarget(repo)
  assert.equal(deleted.dirtyFiles, 1)
  assert.notEqual(deleted.worktree, untracked.worktree)
})

test('무시되는 파일은 대상이 아니다', t => {
  const repo = freshRepo(t)
  writeFileSync(join(repo, '.gitignore'), 'build/\n')
  git(repo, 'add', '.gitignore')
  git(repo, 'commit', '-qm', 'ignore')
  mkdirSync(join(repo, 'build'))
  writeFileSync(join(repo, 'build', 'out.js'), 'x\n')
  assert.equal(currentTarget(repo).worktree, 'clean')
})

test('리포트 디렉터리는 빼고 센다 — 실행이 스스로 쓰는 기록이 대상을 바꾸지 않는다', t => {
  // 기본 저장 위치 `./review-reports/`는 리뷰 대상 저장소 안이다. 타임라인과 스냅숏이
  // 거기 쌓이므로, 빼지 않으면 실행 도중 fingerprint가 실행 자신 때문에 바뀐다.
  const repo = freshRepo(t)
  const reports = join(repo, 'review-reports')
  mkdirSync(join(reports, '.timing'), { recursive: true })
  writeFileSync(join(reports, '.timing', 'run.jsonl'), '{}\n')
  writeFileSync(join(reports, 'old-report.md'), '# old\n')
  assert.equal(currentTarget(repo, { exclude: [reports] }).worktree, 'clean')
  assert.notEqual(currentTarget(repo).worktree, 'clean')
})

test('하위 디렉터리에서 불러도 같은 값이다', t => {
  const repo = freshRepo(t)
  mkdirSync(join(repo, 'sub'))
  writeFileSync(join(repo, 'sub', 'c.txt'), 'c\n')
  assert.equal(currentTarget(join(repo, 'sub')).worktree, currentTarget(repo).worktree)
})

test('실행 비트만 바뀌어도 다른 대상이다', { skip: process.platform === 'win32' && 'Windows는 실행 비트를 추적하지 않는다' }, t => {
  const repo = freshRepo(t)
  chmodSync(join(repo, 'a.txt'), 0o755)
  assert.notEqual(currentTarget(repo).worktree, 'clean')
})

test('원격 주소는 자격 증명과 .git을 떼고 호스트를 소문자로 맞춘다', () => {
  assert.equal(normalizeRemote('https://user:token@GitHub.com/Owner/Repo.git'), 'github.com/Owner/Repo')
  assert.equal(normalizeRemote('git@github.com:Owner/Repo.git'), 'github.com/Owner/Repo')
  assert.equal(normalizeRemote('ssh://git@github.com:22/Owner/Repo/'), 'github.com/Owner/Repo')
  assert.equal(normalizeRemote('  https://github.com/Owner/Repo  '), 'github.com/Owner/Repo')
  assert.equal(normalizeRemote(''), null)
})

test('저장소 식별은 원격과 root commit 둘이다 — 원격이 없어도 root는 있다', t => {
  const repo = freshRepo(t)
  const root = git(repo, 'rev-list', '--max-parents=0', 'HEAD')
  assert.deepEqual(repoIdentity(repo), { remote: null, root })
  git(repo, 'remote', 'add', 'origin', 'https://x:secret@example.com/o/r.git')
  assert.deepEqual(repoIdentity(repo), { remote: 'example.com/o/r', root })
})

test('규칙 digest는 내용이 같으면 같고, 한 글자만 달라도 다르다', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rules-digest-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'a.md'), 'line\n')
  writeFileSync(join(dir, 'catalog.json'), '{}\n')
  const first = rulesDigest(dir)
  assert.match(first, /^sha256:[0-9a-f]{64}$/)
  // 줄 끝만 다른 체크아웃(Windows autocrlf)은 같은 규칙이다
  writeFileSync(join(dir, 'a.md'), 'line\r\n')
  assert.equal(rulesDigest(dir), first)
  writeFileSync(join(dir, 'a.md'), 'line!\n')
  assert.notEqual(rulesDigest(dir), first)
  // 플러그인의 실제 규칙 디렉터리도 읽힌다
  assert.match(rulesDigest(RULES), /^sha256:[0-9a-f]{64}$/)
})

test('실행 ID는 실행마다 다르다', () => {
  const first = newRunId()
  assert.match(first, /^[0-9a-f-]{36}$/)
  assert.notEqual(newRunId(), first)
})
