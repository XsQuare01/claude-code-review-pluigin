import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { plannedModules } from '../scripts/lib/review-snapshot.mjs'
import { currentTarget } from '../scripts/lib/run-identity.mjs'

// 작업 대장 CLI(`review-tasks.mjs`)를 프로세스 단위로 본다(#88 PR 3).
//
// 각 호출이 새 프로세스다 — 오케스트레이터가 압축 뒤에 다시 부르거나 세션이 다시 떠도 대장은 기록만
// 다시 읽는다. 시간이 걸리는 전이(죽은 시도, 시간 상한)는 기다리지 않고 **기록의 시각을 과거로** 심어서
// 만든다. 대장은 시각을 기록에서 읽고 지금은 시계에서 읽으므로 같은 전이가 일어난다.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(ROOT, 'scripts', 'review-tasks.mjs')
const TIMELINE = join(ROOT, 'scripts', 'review-timeline.mjs')
const RULES = join(ROOT, 'review-rules')
const RUN = 'code-review-full-feat-x-2026-10-07'
const CATALOG = JSON.parse(readFileSync(join(RULES, 'catalog.json'), 'utf8'))
const ALL = plannedModules(CATALOG, 'full').map(module => module.name)

const ago = sec => new Date(Date.now() - sec * 1000).toISOString()

const fresh = t => {
  const dir = mkdtempSync(join(tmpdir(), 'review-tasks-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, '.timing'), { recursive: true })
  return dir
}

const sidecar = dir => join(dir, '.timing', `${RUN}.jsonl`)
const plant = (dir, events) => {
  writeFileSync(sidecar(dir), `${events.map((event, at) => JSON.stringify({ at: ago(0), seq: at + 1, ...event })).join('\n')}\n`, 'utf8')
}
const eventsOf = dir => readFileSync(sidecar(dir), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))

const startEvent = (limits = {}, at = ago(0)) => ({
  at, phase: 'run.start', host: 'claude-code', rules: RULES, version: 'test', branch: 'b', changedFiles: 1,
  candidates: 21, workflow: 'full', runId: 'run-cli', correctness: 'off', staleAfterSec: 1200, ...limits,
})
/** `keep`만 적용 대상으로 남기고 나머지를 SKIPPED로 적은 계획 줄. */
const planned = (keep, at = ago(0)) => ({
  at, phase: 'modules.planned', candidates: 21, applied: keep.filter(name => /^\d\d-/.test(name)).length,
  skipped: ALL.filter(name => !keep.includes(name) && name !== 'correctness').map(module => ({ module, reasonCode: 'test', reason: '테스트' })),
})

const tasks = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, ...args, '--dir', dir, '--run', RUN], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const json = out => {
  assert.ok(out.stdout, out.stderr)
  return JSON.parse(out.stdout)
}
const next = (dir, stage = 'module', extra = []) => tasks(dir, 'next', '--stage', stage, '--rules', RULES, ...extra)

const gitRepo = t => {
  const repo = mkdtempSync(join(tmpdir(), 'review-tasks-repo-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 't')
  git('config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'a.txt'), 'a\n', 'utf8')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return repo
}

const RESULT = JSON.stringify({ schemaVersion: 1, findings: [], openQuestions: [] })

test('next는 띄울 시도를 띄우기 전에 기록하고, 다른 프로세스가 다시 물어도 같은 시도를 내주지 않는다', t => {
  const dir = fresh(t)
  plant(dir, [startEvent(), planned(['01-fsd', '02-type', 'exception'])])
  const first = json(next(dir))
  assert.deepEqual(first.dispatch.map(one => one.label), ['01-fsd#1', '02-type#1', 'exception#1'])
  assert.match(first.dispatch[0].resultPath, /\.attempts[\\/]01-fsd\.a1\.json$/)
  assert.equal(first.dispatch[0].claim, 'run-cli/module/01-fsd#1')
  const again = json(next(dir))
  assert.deepEqual(again.dispatch, [])
  assert.equal(again.running.length, 3)
  const phases = eventsOf(dir).map(event => event.phase)
  assert.equal(phases.filter(phase => phase === 'module.start').length, 3)
  assert.equal(phases.filter(phase => phase === 'dispatch.start').length, 1)
})

test('next 두 개가 동시에 돌아도 잠금 때문에 같은 시도가 두 번 나가지 않는다', async t => {
  const dir = fresh(t)
  plant(dir, [startEvent(), planned(['01-fsd', '02-type', '04-state', '05-effect', 'props', 'exception'])])
  const runOne = () => new Promise(done => {
    const child = spawn(process.execPath, [SCRIPT, 'next', '--stage', 'module', '--rules', RULES, '--dir', dir, '--run', RUN], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.on('close', code => done({ code, stdout }))
  })
  const [left, right] = await Promise.all([runOne(), runOne()])
  assert.equal(left.code, 0)
  assert.equal(right.code, 0)
  const claimed = [...JSON.parse(left.stdout).dispatch, ...JSON.parse(right.stdout).dispatch].map(one => one.label)
  assert.equal(claimed.length, 4)
  assert.equal(new Set(claimed).size, 4)
  assert.equal(eventsOf(dir).filter(event => event.phase === 'module.start').length, 4)
})

test('done은 돌고 있는 시도의 결과만 정해진 자리에 쓰고, 같은 알림을 다시 받으면 기록하지 않는다', t => {
  const dir = fresh(t)
  plant(dir, [startEvent(), planned(['01-fsd'])])
  const [claim] = json(next(dir)).dispatch
  assert.equal(tasks(dir, 'bind', '--task', '01-fsd', '--attempt', '1', '--host-task', 'bg_1').status, 0)
  writeFileSync(claim.resultPath, RESULT, 'utf8')
  const accepted = tasks(dir, 'done', '--host-task', 'bg_1', '--status', 'ok')
  assert.equal(accepted.status, 0, accepted.stderr)
  assert.equal(json(accepted).outcome, 'accepted')
  const canonical = join(dir, '.timing', `${RUN}.01-fsd.json`)
  assert.equal(readFileSync(canonical, 'utf8'), RESULT)
  const settled = eventsOf(dir).filter(event => event.phase === 'module.done')
  assert.equal(settled.length, 1)
  assert.equal(settled[0].resultSha256, createHash('sha256').update(RESULT).digest('hex'))
  assert.equal(settled[0].taskId, 'bg_1')
  assert.equal(settled[0].findings, 0)

  const duplicate = tasks(dir, 'done', '--host-task', 'bg_1', '--status', 'ok')
  assert.equal(duplicate.status, 0)
  assert.equal(json(duplicate).outcome, 'duplicate')
  assert.equal(eventsOf(dir).filter(event => event.phase === 'module.done').length, 1)
  // 단계가 끝났으므로 다음 next가 디스패치의 끝을 남긴다. 수치는 기록에서 센다.
  assert.equal(json(next(dir)).complete, true)
  const end = eventsOf(dir).find(event => event.phase === 'dispatch.end')
  assert.deepEqual([end.terminalOk, end.terminalFailed, end.attemptsTotal], [1, 0, 1])
})

test('JSON이 아닌 결과는 쓰지 않고 실패로 기록하며, next가 교정 시도를 내준다', t => {
  const dir = fresh(t)
  plant(dir, [startEvent(), planned(['01-fsd'])])
  const [claim] = json(next(dir)).dispatch
  writeFileSync(claim.resultPath, '결과입니다:\n```json\n{}\n```', 'utf8')
  const rejected = tasks(dir, 'done', '--task', '01-fsd', '--attempt', '1', '--status', 'ok')
  assert.equal(rejected.status, 1)
  assert.equal(json(rejected).outcome, 'rejected')
  assert.equal(existsSync(join(dir, '.timing', `${RUN}.01-fsd.json`)), false)
  const retry = json(next(dir)).dispatch
  assert.deepEqual(retry.map(one => one.label), ['01-fsd#2'])
  assert.equal(retry[0].correction, true)
})

test('끝 알림 없이 오래된 시도는 next가 끝내고 새 시도를 띄우며, 앞 시도의 늦은 결과는 받지 않는다', t => {
  const dir = fresh(t)
  plant(dir, [
    startEvent({ staleAfterSec: 600 }, ago(1900)),
    planned(['01-fsd'], ago(1890)),
    { at: ago(1800), phase: 'module.start', module: '01-fsd', attempt: 1, claim: 'run-cli/module/01-fsd#1' },
    { at: ago(1800), phase: 'task.bind', stage: 'module', task: '01-fsd', attempt: 1, taskId: 'bg_old' },
  ])
  const decision = json(next(dir))
  assert.deepEqual(decision.expired.map(one => `${one.task}#${one.attempt}`), ['01-fsd#1'])
  assert.deepEqual(decision.dispatch.map(one => one.label), ['01-fsd#2'])
  const expiredLine = eventsOf(dir).find(event => event.phase === 'module.done')
  assert.equal(expiredLine.failureClass, 'inactivity-timeout')
  assert.equal(expiredLine.taskId, 'bg_old')

  // 죽은 줄 알았던 시도 1의 응답이 이제 왔다. 시도 2의 자리를 덮지 않는다.
  const stale = join(dir, 'late.json')
  writeFileSync(stale, RESULT, 'utf8')
  const late = tasks(dir, 'done', '--host-task', 'bg_old', '--status', 'ok', '--result', stale)
  assert.equal(late.status, 3)
  assert.equal(json(late).outcome, 'late')
  assert.equal(existsSync(join(dir, '.timing', `${RUN}.01-fsd.json`)), false)
})

test('시간 상한이 지나면 돌던 시도를 취소하고 멈추며, 남은 모듈은 띄우지 않는다', t => {
  const dir = fresh(t)
  plant(dir, [
    startEvent({ maxDurationSec: 1800 }, ago(1900)),
    planned(['01-fsd', '02-type'], ago(1890)),
    { at: ago(1000), phase: 'module.start', module: '01-fsd', attempt: 1 },
  ])
  const decision = json(next(dir))
  assert.deepEqual(decision.dispatch, [])
  assert.deepEqual(decision.cancelled.map(one => one.task), ['01-fsd'])
  assert.equal(decision.halted, 'max-duration')
  assert.equal(decision.complete, true)
  assert.match(decision.advice.join(' '), /멈춘다/)
  const halt = eventsOf(dir).find(event => event.phase === 'dispatch.halt')
  assert.deepEqual(halt.queuedTasks, ['02-type'])
  const status = tasks(dir, 'status', '--rules', RULES)
  assert.match(status.stdout, /멈춤 {6}max-duration/)
  assert.match(status.stdout, /멈춰서 띄우지 못함: 02-type/)
})

test('호출 한도를 다 쓰면 멈추고, resume으로 새 구간을 열어야 다시 띄운다', t => {
  const dir = fresh(t)
  const repo = gitRepo(t)
  const target = currentTarget(repo)
  plant(dir, [startEvent({ maxTasks: 1, head: target.head, worktree: target.worktree }), planned(['01-fsd', '02-type'])])
  const first = json(next(dir))
  assert.deepEqual(first.dispatch.map(one => one.label), ['01-fsd#1'])
  assert.equal(first.halted, 'max-tasks')
  writeFileSync(first.dispatch[0].resultPath, RESULT, 'utf8')
  // 멈춘 뒤에도 이미 띄운 시도의 결과는 받는다.
  assert.equal(tasks(dir, 'done', '--task', '01-fsd', '--attempt', '1', '--status', 'ok').status, 0)
  assert.deepEqual(json(next(dir)).dispatch, [])

  const resumed = tasks(dir, 'resume', '--repo', repo, '--max-tasks', '3', '--rules', RULES)
  assert.equal(resumed.status, 0, resumed.stderr)
  assert.match(resumed.stdout, /새 한도 구간을 열었다 — 앞 구간은 max-tasks로 멈췄다/)
  assert.deepEqual(json(next(dir)).dispatch.map(one => one.label), ['02-type#1'])
  const resume = eventsOf(dir).find(event => event.phase === 'run.resume')
  assert.equal(resume.maxTasks, 3)
  assert.equal(resume.head, target.head)
})

test('resume은 대상이 바뀌었으면 이어 가지 않고 새 실행으로 시작하라고 한다', t => {
  const dir = fresh(t)
  const repo = gitRepo(t)
  const target = currentTarget(repo)
  plant(dir, [startEvent({ head: target.head, worktree: target.worktree }), planned(['01-fsd'])])
  writeFileSync(join(repo, 'a.txt'), 'changed\n', 'utf8')
  const out = tasks(dir, 'resume', '--repo', repo, '--rules', RULES)
  assert.equal(out.status, 3)
  assert.match(out.stdout, /대상이 바뀌었다/)
  assert.match(out.stdout, /--continues run-cli/)
  assert.equal(eventsOf(dir).some(event => event.phase === 'run.resume'), false)
})

test('resume은 멈추지 않은 실행에 한도를 주지 않으면 새 구간을 열지 않는다', t => {
  const dir = fresh(t)
  const repo = gitRepo(t)
  const target = currentTarget(repo)
  plant(dir, [startEvent({ maxTasks: 5, head: target.head, worktree: target.worktree }), planned(['01-fsd'])])
  const out = tasks(dir, 'resume', '--repo', repo, '--rules', RULES)
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /같은 구간을 이어 간다/)
  assert.equal(eventsOf(dir).some(event => event.phase === 'run.resume'), false)
})

test('cancel --all은 돌던 시도를 사용자 취소로 끝내고 디스패치를 멈춘다', t => {
  const dir = fresh(t)
  plant(dir, [startEvent(), planned(['01-fsd', '02-type', '04-state', '05-effect', 'props'])])
  next(dir)
  const out = tasks(dir, 'cancel', '--all', '--reason', 'user')
  assert.equal(out.status, 0, out.stderr)
  assert.equal(json(out).cancelled.length, 4)
  const decision = json(next(dir))
  assert.deepEqual(decision.dispatch, [])
  assert.equal(decision.halted, 'user')
  assert.ok(eventsOf(dir).filter(event => event.phase === 'module.done').every(event => event.cancelReason === 'user'))
})

test('이 실행에 묶이지 않은 호스트 작업과 띄운 적 없는 작업의 결과는 받지 않는다', t => {
  const dir = fresh(t)
  plant(dir, [startEvent(), planned(['01-fsd'])])
  next(dir)
  const stray = join(dir, 'stray.json')
  writeFileSync(stray, RESULT, 'utf8')
  const other = tasks(dir, 'done', '--host-task', 'bg_other_run', '--status', 'ok', '--result', stray)
  assert.equal(other.status, 3)
  assert.equal(json(other).outcome, 'unknown')
  assert.equal(tasks(dir, 'done', '--task', '02-type', '--attempt', '1', '--status', 'ok', '--result', stray).status, 3)
})

test('modules.planned 없이는 무엇을 띄울지 정하지 않는다', t => {
  const dir = fresh(t)
  plant(dir, [startEvent()])
  const out = next(dir)
  assert.equal(out.status, 2)
  assert.match(out.stderr, /modules\.planned가 없다/)
})

test('대장이 남긴 기록은 --check가 표 밖이라고 짚지 않는다', t => {
  const dir = fresh(t)
  plant(dir, [startEvent({ maxTasks: 3 }), planned(['01-fsd', '02-type'])])
  const claims = json(next(dir)).dispatch
  tasks(dir, 'bind', '--task', '01-fsd', '--attempt', '1', '--host-task', 'bg_1')
  writeFileSync(claims[0].resultPath, RESULT, 'utf8')
  tasks(dir, 'done', '--host-task', 'bg_1', '--status', 'ok')
  tasks(dir, 'done', '--task', '02-type', '--attempt', '1', '--status', 'failed', '--failure-class', 'queue-expiry')
  next(dir)
  const check = spawnSync(process.execPath, [TIMELINE, '--dir', dir, '--run', RUN, '--check'], { encoding: 'utf8' })
  assert.doesNotMatch(check.stdout, /표에 없는|닫힌 목록 밖|필수 필드|한도를 넘겨|멈춘 뒤에/)
})

// ── 검증 단계 ─────────────────────────────────────────────────────────

const verdict = (candidateId, disposition) => ({
  candidateId, disposition, evidence: '확인했습니다',
  location: { kind: 'verified', path: 'src/a.ts', line: 1, quote: 'q' },
  ...(disposition === 'needs-context' ? { reason: '파일 밖을 봐야 합니다' } : {}),
})

const verifySetup = t => {
  const dir = fresh(t)
  const verify = join(dir, '.timing', `${RUN}.verify`)
  mkdirSync(verify, { recursive: true })
  const task = (taskId, route, candidateIds) => {
    writeFileSync(join(verify, `${taskId}.md`), `# ${taskId} 지시\n`, 'utf8')
    return { taskId, route, candidateIds, prompt: join(verify, `${taskId}.md`), verdict: join(verify, `${taskId}.verdict.json`) }
  }
  const routed = {
    candidates: [
      { candidateId: '04-3#1', route: 'bundle' },
      { candidateId: '02-1#1', route: 'isolated' },
    ],
    verifierTasks: [task('bundle-1', 'bundle', ['04-3#1']), task('isolated-02-1-1', 'isolated', ['02-1#1'])],
    promotions: { '04-3#1': (({ taskId, prompt, verdict: path }) => ({ taskId, prompt, verdict: path }))(task('isolated-04-3-1', 'promotion', ['04-3#1'])) },
  }
  writeFileSync(join(dir, '.timing', `${RUN}.routed.json`), JSON.stringify(routed), 'utf8')
  plant(dir, [startEvent(), planned(['01-fsd']), { phase: 'crossverify.start', targets: 2 }])
  return { dir, routed }
}

test('검증 단계: 계약에 맞는 판정만 판정 자리에 쓰고, bundle의 needs-context는 승격 작업을 낸다', t => {
  const { dir, routed } = verifySetup(t)
  const first = json(next(dir, 'verify'))
  assert.deepEqual(first.dispatch.map(one => one.label), ['bundle-1#1', 'isolated-02-1-1#1'])
  assert.equal(first.dispatch[0].prompt, routed.verifierTasks[0].prompt)
  writeFileSync(first.dispatch[0].resultPath, JSON.stringify({ schemaVersion: 1, verdicts: [verdict('04-3#1', 'needs-context')] }), 'utf8')
  const accepted = tasks(dir, 'done', '--task', 'bundle-1', '--attempt', '1', '--status', 'ok', '--rules', RULES)
  assert.equal(accepted.status, 0, accepted.stderr)
  assert.ok(existsSync(routed.verifierTasks[0].verdict))
  const promoted = json(next(dir, 'verify'))
  assert.deepEqual(promoted.dispatch.map(one => `${one.label}:${one.kind}`), ['isolated-04-3-1#1:promotion'])
})

test('resume은 대상 기록이 없는 실행을 그대로라고 보지 않는다', t => {
  const dir = fresh(t)
  plant(dir, [startEvent(), planned(['01-fsd'])])
  const out = tasks(dir, 'resume', '--repo', gitRepo(t), '--rules', RULES)
  assert.equal(out.status, 3)
  assert.match(out.stderr, /대상이 그대로인지 확인할 수 없어/)
})

test('resume은 멈춘 기록이 없어도 한도를 다 쓴 구간이면 새 구간을 연다', t => {
  const dir = fresh(t)
  const repo = gitRepo(t)
  const target = currentTarget(repo)
  plant(dir, [startEvent({ maxDurationSec: 60, head: target.head, worktree: target.worktree }, ago(120)), planned(['01-fsd'], ago(119))])
  const out = tasks(dir, 'resume', '--repo', repo, '--rules', RULES)
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /새 한도 구간을 열었다 — 앞 구간의 한도를 다 썼다/)
  assert.deepEqual(json(next(dir)).dispatch.map(one => one.label), ['01-fsd#1'])
})
