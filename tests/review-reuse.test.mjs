import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 기존 구현 검색(C-6C)의 흐름을 실제 저장소에서 고정한다: preflight → 예정 등록(register) → 모델이 쓴 계획 → 검색(search).
// 계획은 PowerShell이 쓴 것처럼 BOM을 붙인다. 검색은 고정된 commit에서 하고, 원문도 그 commit에서 읽는다.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(ROOT, 'scripts', 'review-reuse.mjs')
const PREFLIGHT = join(ROOT, 'scripts', 'review-preflight.mjs')
const TIMELINE = join(ROOT, 'scripts', 'review-timeline.mjs')
const RULES = join(ROOT, 'review-rules')
const RUN = 'code-review-full-feat-reuse-2026-10-15'
const SPLIT = ".split('/').filter(Boolean)"
const hash = data => createHash('sha256').update(data).digest('hex')

const setup = t => {
  const repo = mkdtempSync(join(tmpdir(), 'reuse-repo-'))
  const reports = mkdtempSync(join(tmpdir(), 'reuse-reports-'))
  t.after(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(reports, { recursive: true, force: true })
  })
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd: repo, encoding: 'utf8' }).trim()
  const commit = (files, message) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(repo, dirname(path)), { recursive: true })
      writeFileSync(join(repo, path), text)
    }
    git('add', '-A')
    git('commit', '-qm', message)
  }
  git('init', '-q')
  commit({
    'src/shared/normalize.ts': `export function normalizePath(input: string) {\n  return input${SPLIT}.join('/')\n}\n`,
    'src/shared/__tests__/normalize.test.ts': `expect('a/b'${SPLIT}).toEqual(['a', 'b'])\n`,
    'src/features/old/legacy.ts': 'export const legacy = 1\n',
  }, 'base')
  git('switch', '-q', '-c', 'feature')
  commit({
    'src/features/parser/new-parser.ts': `export function parsePath(raw: string) {\n  const parts = raw${SPLIT}\n  return parts.join('/')\n}\n`,
    'src/한글 폴더/설정 파일.ts': "export const 설정 = { key: 'a[0].b(' }\n",
  }, 'add parser')
  git('switch', '-q', 'main')
  commit({ 'src/shared/legacy-normalize.ts': `export const legacyNormalize = (s: string) => s${SPLIT}\n` }, 'main moves on')
  git('switch', '-q', 'feature')
  const pre = spawnSync(process.execPath, [PREFLIGHT, '--dir', reports, '--run', RUN, '--rules', RULES, '--workflow', 'full', '--repo', repo, '--host', 'test', '--base', 'main'], { encoding: 'utf8' })
  assert.equal(pre.status, 0, pre.stderr)
  return { repo, reports, git }
}

const events = ctx => readFileSync(join(ctx.reports, '.timing', `${RUN}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line))
const reuse = (ctx, ...args) => spawnSync(process.execPath, [SCRIPT, ...args, '--dir', ctx.reports, '--run', RUN], { encoding: 'utf8', cwd: ctx.repo })
const scopeOf = ctx => JSON.parse(readFileSync(join(ctx.reports, '.timing', `${RUN}.scope.json`), 'utf8'))

const planFor = (ctx, registered, { decisions } = {}) => {
  const start = events(ctx).find(event => event.phase === 'run.start')
  const scope = scopeOf(ctx)
  return {
    schemaVersion: 1, runId: start.runId, searchId: registered.searchId, head: start.head, mergeBase: start.mergeBase, scopeSha256: registered.scopeSha256,
    fileDecisions: decisions ?? [
      { path: 'src/features/parser/new-parser.ts', decision: 'search', targetIds: ['t1'] },
      { path: 'src/한글 폴더/설정 파일.ts', decision: 'search', targetIds: ['t2'] },
    ],
    targets: [
      { targetId: 't1', anchor: { path: 'src/features/parser/new-parser.ts', startLine: 2, endLine: 2, quote: `  const parts = raw${SPLIT}` }, purpose: '경로를 / 로 나눠 빈 조각을 버린다', queries: [{ text: SPLIT }] },
      { targetId: 't2', anchor: { path: 'src/한글 폴더/설정 파일.ts', startLine: 1, endLine: 1, quote: "export const 설정 = { key: 'a[0].b(' }" }, purpose: '설정 키', queries: [{ text: 'a[0].b(' }] },
    ],
    _scopeFiles: scope.files,
  }
}

const writePlan = (path, value) => {
  const { _scopeFiles, ...plan } = value
  writeFileSync(path, `﻿${JSON.stringify(plan)}`, 'utf8')
}

test('예정을 등록하고, BOM이 붙은 계획으로 diff 밖의 기존 구현·테스트·base에만 있는 구현을 후보로 모은다', t => {
  const ctx = setup(t)
  const register = reuse(ctx, 'register')
  assert.equal(register.status, 0, register.stderr)
  const registered = JSON.parse(register.stdout)
  assert.match(registered.searchId, /^s-[0-9a-f]{8}$/)
  const planned = events(ctx).find(event => event.phase === 'reuse.planned')
  assert.deepEqual([planned.searchId, planned.scopeSha256], [registered.searchId, hash(readFileSync(join(ctx.reports, '.timing', `${RUN}.scope.json`), 'utf8'))])

  const plan = planFor(ctx, registered)
  assert.deepEqual(plan._scopeFiles.sort(), ['src/features/parser/new-parser.ts', 'src/한글 폴더/설정 파일.ts'])
  writePlan(registered.plan, plan)
  const out = join(ctx.reports, '.timing', `${RUN}.reuse-context.json`)
  const search = reuse(ctx, 'search', '--search-id', registered.searchId, '--out', out, '--repo', ctx.repo)
  assert.equal(search.status, 0, search.stderr)
  const summary = JSON.parse(search.stdout)
  assert.equal(summary.status, 'complete')

  const context = JSON.parse(readFileSync(out, 'utf8'))
  const start = events(ctx).find(event => event.phase === 'run.start')
  assert.deepEqual([context.runId, context.searchId, context.head, context.baseHead, context.status], [start.runId, registered.searchId, start.head, ctx.git('rev-parse', 'main'), 'complete'])
  const [t1, t2] = context.targets
  // 근처(src/features)에서 못 찾았으니 저장소 전체로 넓혔다 — 검색어는 그대로
  assert.deepEqual(t1.queries[0].searched, [['src/features'], ['.']])
  const byPath = new Map(t1.candidates.map(candidate => [candidate.path, candidate]))
  assert.equal(byPath.has('src/features/parser/new-parser.ts'), false, '대상 자신은 후보가 아니다')
  const shared = byPath.get('src/shared/normalize.ts')
  assert.deepEqual([shared.kind, shared.sourceRef, shared.existedAtMergeBase], ['production', 'head', true])
  assert.match(shared.quote, /export function normalizePath/)
  assert.equal(shared.sha256, hash(shared.quote))
  assert.equal(byPath.get('src/shared/__tests__/normalize.test.ts').kind, 'test')
  const baseOnly = byPath.get('src/shared/legacy-normalize.ts')
  assert.deepEqual([baseOnly.sourceRef, baseOnly.onlyInBase], ['base', true])
  // production 후보가 테스트 후보보다 앞선다
  assert.equal(t1.candidates.at(-1).kind, 'test')
  // 정규식 특수문자는 문자 그대로 찾는다 — 자신 말고는 없다
  assert.deepEqual([t2.status, t2.candidates.length], ['complete', 0])

  const done = events(ctx).filter(event => event.phase.startsWith('reuse.'))
  assert.deepEqual(done.map(event => event.phase), ['reuse.planned', 'reuse.start', 'reuse.done'])
  const [, began, ended] = done
  assert.equal(began.planSha256, hash(readFileSync(registered.plan)))
  assert.deepEqual([ended.searchId, ended.status, ended.outSha256, ended.planSha256], [registered.searchId, 'complete', hash(readFileSync(out)), began.planSha256])
  assert.deepEqual(ended.targets, { complete: 2 })
  const checked = spawnSync(process.execPath, [TIMELINE, '--dir', ctx.reports, '--run', RUN, '--check'], { encoding: 'utf8' })
  // 검색 기록에 관한 문제는 없다(run.end가 없다는 것은 이 테스트가 실행을 끝내지 않아서다)
  assert.deepEqual(checked.stdout.split('\n').filter(line => line.startsWith('  - ') && /검색/.test(line)), [])
})

test('계획에 scope 파일의 결정이 빠지면 검색하지 않고 실패로 끝을 남긴다 — 빈 결과를 완료로 만들지 않는다', t => {
  const ctx = setup(t)
  const registered = JSON.parse(reuse(ctx, 'register').stdout)
  writePlan(registered.plan, planFor(ctx, registered, { decisions: [{ path: 'src/features/parser/new-parser.ts', decision: 'search', targetIds: ['t1', 't2'] }] }))
  const out = join(ctx.reports, '.timing', `${RUN}.reuse-context.json`)
  const search = reuse(ctx, 'search', '--search-id', registered.searchId, '--out', out, '--repo', ctx.repo)
  assert.equal(search.status, 2)
  assert.match(search.stderr, /설정 파일\.ts에 결정이 없다/)
  const context = JSON.parse(readFileSync(out, 'utf8'))
  assert.deepEqual([context.status, context.reason, context.targets.length], ['failed', 'plan-invalid', 0])
  assert.ok(context.problems.some(problem => /결정이 없다/.test(problem)))
  const ended = events(ctx).find(event => event.phase === 'reuse.done')
  assert.deepEqual([ended.status, ended.reason], ['failed', 'plan-invalid'])
})

test('anchor 인용이 HEAD와 다르거나 변경에 닿지 않으면 계획 검사에서 거부한다', t => {
  const ctx = setup(t)
  const registered = JSON.parse(reuse(ctx, 'register').stdout)
  const plan = planFor(ctx, registered)
  plan.targets[0].anchor = { ...plan.targets[0].anchor, quote: 'const parts = somethingElse' }
  writePlan(registered.plan, plan)
  const out = join(ctx.reports, '.timing', `${RUN}.reuse-context.json`)
  const search = reuse(ctx, 'search', '--search-id', registered.searchId, '--out', out, '--repo', ctx.repo)
  assert.equal(search.status, 2)
  assert.match(search.stderr, /t1의 anchor 인용이 HEAD와 다르다/)
})

test('예정하지 않은 실행이나 등록하지 않은 검색 ID로는 기록을 남기지 않는다', t => {
  const ctx = setup(t)
  const out = join(ctx.reports, '.timing', `${RUN}.reuse-context.json`)
  const stray = reuse(ctx, 'search', '--search-id', 's-deadbeef', '--out', out, '--repo', ctx.repo)
  assert.equal(stray.status, 2)
  assert.match(stray.stderr, /등록되지 않은 검색 ID/)
  assert.equal(events(ctx).some(event => event.phase.startsWith('reuse.')), false)

  const legacy = mkdtempSync(join(tmpdir(), 'reuse-legacy-'))
  t.after(() => rmSync(legacy, { recursive: true, force: true }))
  const started = spawnSync(process.execPath, [TIMELINE, '--dir', legacy, '--run', RUN, '--phase', 'run.start', '--data', JSON.stringify({ host: 't', rules: 'r', version: 'v', branch: 'b', changedFiles: 1 })], { encoding: 'utf8' })
  assert.equal(started.status, 0, started.stderr)
  const refused = spawnSync(process.execPath, [SCRIPT, 'register', '--dir', legacy, '--run', RUN], { encoding: 'utf8' })
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /기존 구현 검색을 예정하지 않았다/)
})

test('wait는 검색이 풀릴 때까지만 기다린다 — 끝났으면 바로, 아니면 자기 상한에서 exit 1', t => {
  const dir = mkdtempSync(join(tmpdir(), 'reuse-wait-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const log = (phase, data) => assert.equal(spawnSync(process.execPath, [TIMELINE, '--dir', dir, '--run', RUN, '--phase', phase, '--data', JSON.stringify(data)], { encoding: 'utf8' }).status, 0)
  log('run.start', { host: 't', rules: 'r', version: 'v', branch: 'b', changedFiles: 1, runId: 'r-1', reuseSearch: 'planned' })
  log('reuse.planned', { searchId: 's1', scopeSha256: 'h', plan: 'p' })
  log('reuse.start', { searchId: 's1', plan: 'p' })
  const wait = (...extra) => spawnSync(process.execPath, [SCRIPT, 'wait', '--dir', dir, '--run', RUN, ...extra], { encoding: 'utf8' })
  const startedAt = Date.now()
  const pending = wait('--timeout', '2')
  assert.equal(pending.status, 1)
  assert.ok(Date.now() - startedAt >= 1800)
  assert.equal(JSON.parse(pending.stdout).state, 'running')
  log('reuse.done', { searchId: 's1', status: 'complete', out: '/x/ctx.json' })
  const done = wait('--timeout', '30')
  assert.equal(done.status, 0, done.stderr)
  const result = JSON.parse(done.stdout)
  assert.deepEqual([result.state, result.released, result.searchId, result.status, result.context], ['done', true, 's1', 'complete', '/x/ctx.json'])
})

// 계획의 머리(실행 ID·검색 ID·HEAD·merge-base·scope 해시)는 오케스트레이터가 preflight 출력에서 옮겨 적지 않는다 —
// register가 낸 planHeader를 그대로 쓴다. 옮겨 적다 한 글자만 틀려도 계획 검사가 검색 전체를 실패로 끝낸다.
test('register는 계획에 그대로 쓸 머리와 검사할 파일 목록을 낸다', t => {
  const ctx = setup(t)
  const register = reuse(ctx, 'register')
  assert.equal(register.status, 0, register.stderr)
  const registered = JSON.parse(register.stdout)
  const start = events(ctx).find(event => event.phase === 'run.start')
  assert.deepEqual(registered.planHeader, {
    schemaVersion: 1, runId: start.runId, searchId: registered.searchId, head: start.head, mergeBase: start.mergeBase, scopeSha256: registered.scopeSha256,
  })
  assert.deepEqual([...registered.files].sort(), [...scopeOf(ctx).files].sort())

  const { _scopeFiles, ...body } = planFor(ctx, registered)
  const plan = { ...registered.planHeader, fileDecisions: body.fileDecisions, targets: body.targets }
  writePlan(registered.plan, plan)
  const search = reuse(ctx, 'search', '--search-id', registered.searchId, '--out', registered.out, '--repo', ctx.repo)
  assert.equal(search.status, 0, search.stderr)
})

// 검색은 띄워 두고 돌아오므로 계획이 틀린 것을 05가 풀린 뒤에야 안다. check는 같은 관문을 기록 없이 먼저 돌린다 —
// 고친 뒤 띄우면 05가 근거 없이 나가는 일이 줄어든다.
test('check는 검색과 같은 관문을 기록 없이 돌리고, 통과해야 0으로 끝난다', t => {
  const ctx = setup(t)
  const registered = JSON.parse(reuse(ctx, 'register').stdout)
  const plan = planFor(ctx, registered, { decisions: [{ path: 'src/features/parser/new-parser.ts', decision: 'search', targetIds: ['t1'] }] })
  writePlan(registered.plan, { ...plan, targets: plan.targets.slice(0, 1) })
  const bad = reuse(ctx, 'check', '--search-id', registered.searchId, '--repo', ctx.repo)
  assert.equal(bad.status, 2)
  const verdict = JSON.parse(bad.stdout)
  assert.equal(verdict.ok, false)
  assert.ok(verdict.problems.some(problem => /설정 파일\.ts에 결정이 없다/.test(problem)), verdict.problems.join(' / '))
  assert.deepEqual(events(ctx).filter(event => /^reuse\.(start|done)$/.test(event.phase)), [], 'check는 기록을 남기지 않는다')

  writePlan(registered.plan, planFor(ctx, registered))
  const good = reuse(ctx, 'check', '--search-id', registered.searchId, '--repo', ctx.repo)
  assert.equal(good.status, 0, good.stdout + good.stderr)
  assert.deepEqual(JSON.parse(good.stdout), { ok: true, problems: [] })
})
