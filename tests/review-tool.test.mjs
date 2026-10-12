import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// 도구가 띄우는 프로세스 둘(spawner와 그 자식 writer). 둘 다 pid를 남기고 끝없이 산다 — 끊지 않으면 남는다.
const PROCESS_FILES = ['spawner.pid', 'writer.pid']

const plantSpawner = ctx => {
  writeFileSync(join(ctx.repo, 'writer.mjs'), [
    "import { writeFileSync } from 'node:fs'",
    "writeFileSync('writer.pid', String(process.pid))",
    'setInterval(() => {}, 1000)',
  ].join('\n'))
  writeFileSync(join(ctx.repo, 'spawner.mjs'), [
    "import { spawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    "writeFileSync('spawner.pid', String(process.pid))",
    "spawn(process.execPath, ['writer.mjs'], { stdio: 'inherit' })",
    'setInterval(() => {}, 1000)',
  ].join('\n'))
}

// 테스트가 실패했을 때 남은 프로세스를 끈다. `t.after`가 아니라 테스트 안의 finally에서 부른다 — setup의
// `t.after`가 먼저 돌아 저장소를 지우면 pid 파일이 없어 끄지 못한다(실제로 둘이 남았다).
// **통과한 테스트는 아무것도 끄지 않고, 지금 살아 있는 번호만 끈다.** 끝난 pid는 다른 프로세스가 곧 다시 받을 수
// 있다(Windows는 특히 빠르다) — 끝난 것을 확인한 번호에 신호를 보내면 남의 프로세스를 끌 수 있다.
const killSurvivors = ctx => {
  for (const file of PROCESS_FILES) {
    if (!existsSync(join(ctx.repo, file))) continue
    const pid = Number(readFileSync(join(ctx.repo, file), 'utf8'))
    if (!stillRunning(pid)) continue
    try {
      process.kill(pid)
    } catch {
      // 그 사이 끝났다
    }
  }
}

const stillRunning = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

for (const shell of [false, true]) {
  test(`시간 상한을 넘기면 도구가 띄운 프로세스까지 끊고 나서 돌아온다${shell ? ' — --shell' : ''}`, async t => {
    // 직접 띄운 프로세스만 끊으면 `npm test`의 셸이나 러너만 죽고 그 아래 실제 도구는 계속 돈다 — Windows에서
    // `--shell --timeout 1`로 띄운 자식이 4초 뒤에도 파일을 만들었다. 끊었다고 기록한 도구가 재시도와 겹쳐 돈다.
    // 시각으로 재지 않는다 — 부하가 크면 끊는 데 몇 초가 걸린다(24개를 함께 돌리면 돌아오기까지 6.5초).
    // 보는 것은 "돌아온 뒤 도구가 띄운 프로세스가 남아 있지 않다"이고, 둘 다 끝없이 사므로 끊지 않으면 남는다.
    const ctx = setup(t)
    plantSpawner(ctx)
    let passed = false
    try {
      const command = shell ? ['--shell', '--', `"${process.execPath}" spawner.mjs`] : ['--', process.execPath, 'spawner.mjs']
      const out = tool(ctx, '--name', 'test', '--timeout', '3', ...command)
      assert.equal(out.status, 0, out.stderr)
      assert.deepEqual([JSON.parse(out.stdout).timedOut, JSON.parse(out.stdout).exit], [true, null])
      // 상한(3초) 안에 둘 다 떠 있었어야 끊은 것을 본 셈이다.
      for (const file of PROCESS_FILES) assert.ok(existsSync(join(ctx.repo, file)), `${file}이 없다 — 끊기 전에 뜨지 못했다`)
      const pids = PROCESS_FILES.map(file => Number(readFileSync(join(ctx.repo, file), 'utf8')))
      // 끊긴 프로세스가 사라지는 데 걸리는 짧은 시간만 기다린다.
      for (const until = Date.now() + 1000; pids.some(stillRunning) && Date.now() < until;) await new Promise(resolve => setTimeout(resolve, 50))
      assert.deepEqual(pids.filter(stillRunning), [], '돌아온 뒤에도 도구가 띄운 프로세스가 살아 있다')
      passed = true
    } finally {
      if (!passed) killSurvivors(ctx)
    }
  })
}

test('--shell은 셸 명령 문자열 하나만 받고, 다시 돌린 시도는 attempt를 남긴다', t => {
  const ctx = setup(t)
  const refused = tool(ctx, '--name', 'lint', '--shell', '--', 'npm', 'run', 'lint')
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /셸 명령 문자열 하나를 받는다/)
  const out = tool(ctx, '--name', 'lint', '--attempt', '2', '--shell', '--', 'echo checked')
  assert.equal(out.status, 0, out.stderr)
  const [, start, done] = linesOf(ctx)
  assert.deepEqual([start.attempt, done.attempt, done.exit], [2, 2, 0])
})

test('같은 이름으로 baseline과 현재 트리를 돌려도 호출마다 로그가 따로 남고, 기록의 callId로 이어진다', t => {
  // 로그 이름을 도구 이름과 시도 번호로만 지었더니 baseline과 현재의 `lint`가 같은 파일을 써, 나중 호출이
  // baseline 로그를 지웠다 — C-6이 요구하는 "기존 실패 대비 신규 실패"를 다시 볼 근거가 없어진다.
  const ctx = setup(t)
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: ctx.repo, encoding: 'utf8' }).trim()
  writeFileSync(join(ctx.repo, 'b.txt'), 'b\n')
  git('add', 'b.txt')
  git('commit', '-qm', 'change')
  const baseline = join(mkdtempSync(join(tmpdir(), 'review-tool-base-')), 'tree')
  t.after(() => rmSync(dirname(baseline), { recursive: true, force: true }))
  git('worktree', 'add', '-q', '--detach', baseline, 'HEAD~1')
  const call = (repo, text) => {
    const out = tool({ ...ctx, repo }, '--name', 'lint', '--', process.execPath, '-e', `console.log(${JSON.stringify(text)})`)
    assert.equal(out.status, 0, out.stderr)
    return JSON.parse(out.stdout)
  }
  const before = call(baseline, 'baseline: 3 problems')
  const now = call(ctx.repo, 'current: 5 problems')
  assert.notEqual(before.treeSha, now.treeSha)
  assert.match(String(before.callId), /^[0-9a-f]{8}$/)
  assert.notEqual(before.callId, now.callId)
  assert.notEqual(before.log, now.log)
  assert.match(readFileSync(before.log, 'utf8'), /baseline: 3 problems/)
  assert.match(readFileSync(now.log, 'utf8'), /current: 5 problems/)
  const tools = linesOf(ctx).filter(line => line.phase.startsWith('tool.'))
  assert.deepEqual(tools.map(line => [line.phase, line.callId]), [
    ['tool.start', before.callId], ['tool.done', before.callId], ['tool.start', now.callId], ['tool.done', now.callId],
  ])
  for (const result of [before, now]) assert.ok(result.log.endsWith(`.tool.lint.${result.callId}.log`), result.log)
})

test('시작된 타임라인 없이는 돌리지 않는다', t => {
  const ctx = setup(t)
  const out = spawnSync(process.execPath, [SCRIPT, '--dir', ctx.dir, '--run', 'code-review-full-other-2026-10-12', '--name', 'lint', '--', 'echo'], { encoding: 'utf8' })
  assert.equal(out.status, 2)
})
