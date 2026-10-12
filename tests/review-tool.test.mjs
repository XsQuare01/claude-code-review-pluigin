import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 도구의 시작·끝을 스크립트가 남긴다(C-9). 오케스트레이터가 남기면 그 시각은 오케스트레이터가 깨어난
// 시각이다 — 2026-10-12 실행은 세 도구를 모두 416초로 기록했다.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(ROOT, 'scripts', 'review-tool.mjs')
const RUN = 'code-review-full-feat-x-2026-10-12'

const setup = t => {
  const repo = mkdtempSync(join(tmpdir(), 'review-tool-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args,
  ], { cwd: repo, encoding: 'utf8' }).trim()
  git('init', '-q')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  const dir = join(repo, 'review-reports')
  mkdirSync(join(dir, '.timing'), { recursive: true })
  writeFileSync(join(dir, '.timing', `${RUN}.jsonl`), `${JSON.stringify({
    at: '2026-10-12T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'test', rules: 'r', version: '2.25.0', branch: 'b', changedFiles: 1,
  })}\n`, 'utf8')
  return { repo, dir, head: git('rev-parse', 'HEAD') }
}

const tool = (ctx, ...args) => spawnSync(process.execPath, [SCRIPT, '--dir', ctx.dir, '--run', RUN, '--repo', ctx.repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const linesOf = ctx => readFileSync(join(ctx.dir, '.timing', `${RUN}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line))

test('도구를 돌리기 직전과 끝난 직후에 시작·끝을 남기고, 걸린 시간이 기록에 그대로 남는다', t => {
  const ctx = setup(t)
  const out = tool(ctx, '--name', 'typecheck', '--', process.execPath, '-e', 'setTimeout(() => { console.log("2 errors"); process.exit(3) }, 600)')
  assert.equal(out.status, 0, out.stderr)
  const result = JSON.parse(out.stdout)
  assert.deepEqual([result.name, result.exit, result.timedOut, result.treeSha], ['typecheck', 3, false, ctx.head])
  assert.ok(result.durationSec >= 0.5, String(result.durationSec))
  assert.deepEqual(result.tail, ['2 errors'])
  const [, start, done] = linesOf(ctx)
  assert.deepEqual([start.phase, start.name, done.phase, done.name, done.exit, done.treeSha], ['tool.start', 'typecheck', 'tool.done', 'typecheck', 3, ctx.head])
  const elapsed = (Date.parse(done.at) - Date.parse(start.at)) / 1000
  assert.ok(elapsed >= 0.5, `기록된 구간 ${elapsed}s`)
  assert.match(readFileSync(result.log, 'utf8'), /# exit 3[\s\S]*2 errors/)
})

test('시간 상한을 넘기면 끊고, 끝도 남긴다 — 시작만 남은 도구가 되지 않는다', t => {
  const ctx = setup(t)
  const out = tool(ctx, '--name', 'test', '--timeout', '1', '--', process.execPath, '-e', 'setTimeout(() => {}, 10000)')
  assert.equal(out.status, 0, out.stderr)
  const result = JSON.parse(out.stdout)
  assert.deepEqual([result.timedOut, result.exit], [true, null])
  assert.deepEqual(linesOf(ctx).map(line => line.phase), ['run.start', 'tool.start', 'tool.done'])
})

test('--shell은 셸 명령 문자열 하나만 받고, 다시 돌린 시도는 attempt를 남긴다', t => {
  const ctx = setup(t)
  const refused = tool(ctx, '--name', 'lint', '--shell', '--', 'npm', 'run', 'lint')
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /셸 명령 문자열 하나를 받는다/)
  const out = tool(ctx, '--name', 'lint', '--attempt', '2', '--shell', '--', 'echo checked')
  assert.equal(out.status, 0, out.stderr)
  const [, start, done] = linesOf(ctx)
  assert.deepEqual([start.attempt, done.attempt, done.exit], [2, 2, 0])
  assert.match(JSON.parse(out.stdout).log, /\.tool\.lint\.a2\.log$/)
})

test('시작된 타임라인 없이는 돌리지 않는다', t => {
  const ctx = setup(t)
  const out = spawnSync(process.execPath, [SCRIPT, '--dir', ctx.dir, '--run', 'code-review-full-other-2026-10-12', '--name', 'lint', '--', 'echo'], { encoding: 'utf8' })
  assert.equal(out.status, 2)
})
