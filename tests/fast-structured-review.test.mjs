import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { namespaceProblems } from '../scripts/prepare-verification.mjs'
import { plannedModules } from '../scripts/lib/review-snapshot.mjs'

// /code-review-fast가 full과 같은 스크립트로 결과를 받고 리포트를 그리는지 본다(PR #110 리뷰).
//
// fast의 리포트는 2.27.0까지 리뷰어가 낸 표 한 행씩을 오케스트레이터가 옮겨 적은 것이었다. 지적의 모양·섹션 순서·
// 미실행 표시가 full과 달라, 두 모드의 리포트를 읽는 사람이 형식을 두 벌 익혀야 했다. 판정 문장도 고정돼 있어
// 낮은 영향 · 높은 확신(🟡)을 "영향은 높지만 확인 못 한 지적"이라고 설명했다.
//
// 이제 fast는 리뷰어 하나(`fast` — 압축 규칙 01~21과 정확성 기준을 같은 패스에서 본다)를 작업 대장으로 띄우고,
// 위치 확인 → 렌더러 → 스냅숏 → 조립을 full과 같은 스크립트로 지난다. 교차검증만 끈다.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const RULES = join(ROOT, 'review-rules')
const script = name => join(ROOT, 'scripts', name)
const CATALOG = JSON.parse(readFileSync(join(RULES, 'catalog.json'), 'utf8'))
const RUN = 'code-review-fast-feat-x-2026-11-10'

const scratch = t => {
  const repo = mkdtempSync(join(tmpdir(), 'fast-review-repo-'))
  const dir = mkdtempSync(join(tmpdir(), 'fast-review-reports-'))
  t.after(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })
  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args,
  ], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q', '-b', 'main')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'package.json'), '{"name":"p","dependencies":{"react":"18.2.0"}}\n')
  writeFileSync(join(repo, 'src', 'App.tsx'), 'export function App() {\n  return <div>hi</div>\n}\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  git('switch', '-q', '-c', 'feat/x')
  writeFileSync(join(repo, 'src', 'App.tsx'), 'export function App({ user }: { user?: { name: string } }) {\n  const name = user.name\n  return <div>{name}</div>\n}\n')
  git('add', '-A')
  git('commit', '-qm', 'feat: 사용자 이름을 보여준다')
  return { repo, dir }
}

const call = ({ repo, dir }, name, args, { run = true } = {}) => spawnSync(process.execPath, [
  script(name), ...args, ...(run ? ['--dir', dir, '--run', RUN] : []),
], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const ok = (out, what) => {
  assert.equal(out.status, 0, `${what}: ${out.stderr}`)
  return out
}
const timing = ({ dir }, suffix) => join(dir, '.timing', `${RUN}.${suffix}`)
const eventsOf = ({ dir }) => readFileSync(join(dir, '.timing', `${RUN}.jsonl`), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))

const HIGH_CR = {
  ruleId: 'CR-1', title: '선택 prop을 확인 없이 읽어 화면이 깨진다', body: '`user`가 없으면 렌더 중 예외가 난다.',
  impact: 'high', confidence: 'high', category: 'user-malfunction',
  evidence: '`user?:`로 선언했는데 `user.name`을 바로 읽는다.', recommendation: '`user?.name`으로 읽거나 없을 때를 처리한다.',
  location: { kind: 'verified', path: 'src/App.tsx', line: 2, quote: '  const name = user.name' },
}
const LOW_RULE = {
  ruleId: '02-3', title: '선택 필드를 좁히지 않고 쓴다', body: '타입이 선택 필드를 허용하는데 좁히지 않았다.',
  impact: 'low', confidence: 'high', recommendation: '쓰기 전에 좁힌다.',
  location: { kind: 'verified', path: 'src/App.tsx', line: 1, quote: 'export function App({ user }: { user?: { name: string } }) {' },
}

/** preflight부터 렌더·스냅숏까지 돌린다. 리뷰어 응답은 가짜다(실제 리뷰는 돌리지 않는다). */
const runFast = (t, result) => {
  const env = scratch(t)
  const preflight = ok(call(env, 'review-preflight.mjs', ['--rules', RULES, '--workflow', 'fast', '--base', 'main', '--host', 'test']), 'preflight')
  ok(call(env, 'review-intent.mjs', ['--repo', env.repo, '--no-pr']), 'intent')
  ok(call(env, 'review-timeline.mjs', ['--phase', 'modules.planned', '--set', 'candidates=1', '--set', 'applied=1']), 'modules.planned')
  const next = JSON.parse(ok(call(env, 'review-tasks.mjs', ['next', '--stage', 'module', '--rules', RULES]), 'next').stdout)
  const [claim] = next.dispatch
  writeFileSync(claim.resultPath, JSON.stringify(result), 'utf8')
  ok(call(env, 'review-tasks.mjs', ['bind', '--task', claim.task, '--attempt', '1', '--host-task', 'h1']), 'bind')
  ok(call(env, 'review-tasks.mjs', ['done', '--task', claim.task, '--attempt', '1', '--status', 'ok']), 'done')
  const after = JSON.parse(ok(call(env, 'review-tasks.mjs', ['next', '--stage', 'module', '--rules', RULES]), 'next').stdout)
  ok(call(env, 'prepare-verification.mjs', ['--merge-base', 'main', '--rules', RULES, '--collect', '--verify', 'off', '--out', timing(env, 'routed.json')]), 'prepare')
  ok(call(env, 'review-timeline.mjs', ['--phase', 'render.start', '--set', `findings=${result.findings.length}`]), 'render.start')
  const rendered = ok(call(env, 'render-findings.mjs', [
    '--input', timing(env, 'routed.json'), '--phase-high', 'rollout-shadow', '--phase-low', 'rollout-shadow',
    '--verification-state', 'disabled', '--rules', RULES, '--workflow', 'fast', '--out', timing(env, 'findings.md'),
  ]), 'render-findings')
  ok(call(env, 'review-snapshot.mjs', ['--rules', RULES, '--verification-state', 'disabled', '--out', timing(env, 'plan.md')]), 'snapshot')
  return {
    env, preflight: preflight.stdout, claim, after, rendered,
    findings: readFileSync(timing(env, 'findings.md'), 'utf8'),
    plan: readFileSync(timing(env, 'plan.md'), 'utf8'),
  }
}

test('fast의 작업은 리뷰어 하나(`fast`)다 — 정확성 기준은 따로 띄우지 않고 같은 패스에서 본다', () => {
  assert.deepEqual(plannedModules(CATALOG, 'fast').map(({ name, kind }) => ({ name, kind })), [{ name: 'fast', kind: 'digest' }])
  // full은 그대로다 — 번호 모듈 전부와 특수 패스 넷
  const full = plannedModules(CATALOG, 'full')
  assert.equal(full.filter(module => module.kind === 'digest').length, 0)
  assert.ok(full.some(module => module.name === 'correctness' && module.kind === 'pass'))
})

test('fast 리뷰어는 규칙 ID와 CR을 함께 낸다 — 다른 출처의 namespace 검사는 그대로다', () => {
  const result = findings => ({ schemaVersion: 1, findings, openQuestions: [] })
  const namespaces = new Map([['correctness', ['CR']]])
  const absorbed = new Map([['fast', ['CR']]])
  assert.deepEqual(namespaceProblems([{ source: 'fast', result: result([HIGH_CR, LOW_RULE]) }], namespaces, absorbed), [])
  assert.equal(namespaceProblems([{ source: '04-state', result: result([HIGH_CR]) }], namespaces, absorbed).length, 1)
  assert.equal(namespaceProblems([{ source: 'correctness', result: result([LOW_RULE]) }], namespaces, absorbed).length, 1)
})

test('fast 실행은 full과 같은 스크립트로 결과를 받고 상세 지적·특수 패스·실행 계획을 그린다', t => {
  const run = runFast(t, { schemaVersion: 1, findings: [HIGH_CR, LOW_RULE], openQuestions: [] })

  // preflight: 후보는 리뷰어 하나, 에이전트가 없으면 full과 같이 작업 대장으로 멈춘다
  assert.match(run.preflight, /후보 모듈 +1개 +fast/)
  assert.doesNotMatch(run.preflight, /특수 패스 +correctness/)
  assert.match(run.preflight, /리뷰 에이전트 +.*review-tasks\.mjs cancel --all --reason agent-unavailable/)
  const start = eventsOf(run.env).find(event => event.phase === 'run.start')
  assert.deepEqual([start.workflow, start.candidates], ['fast', 1])

  // 작업 대장: `fast` 하나를 내주고, 받은 뒤에는 끝났다고 한다
  assert.deepEqual([run.claim.task, run.claim.label], ['fast', 'fast#1'])
  assert.equal(run.after.complete, true)
  assert.equal(existsSync(timing(run.env, 'fast.json')), true)

  // 렌더러: full과 같은 지적 블록. 지적이 있는 모듈만 섹션이 되고, 제목은 catalog에서 온다
  const title02 = CATALOG.modules.find(module => module.id === '02').title
  assert.match(run.findings, new RegExp(`^### 02 ${title02}$`, 'm'))
  assert.doesNotMatch(run.findings, /^### 01 /m)
  assert.match(run.findings, /압축 규칙 `fast\.md`/)
  assert.match(run.findings, /^#### 🔴 `CR-1` 선택 prop을 확인 없이 읽어 화면이 깨진다\n영향: 높음 \(사용자에게 보이는 오동작 또는 사용 불가\) · 확신: 높음 · 교차검증: `꺼짐`\n출처 패스: fast\n`src\/App\.tsx:2` — `  const name = user\.name`\n본문: /m)
  assert.match(run.findings, /^#### 🟡 `02-3` 선택 필드를 좁히지 않고 쓴다\n영향: 낮음 · 확신: 높음/m)
  // 특수 패스: fast가 돌리지 않는 셋은 SKIPPED와 사유, 정확성은 fast가 같은 패스에서 본 결과
  for (const pass of ['Props', '수학', '예외']) {
    assert.match(run.findings, new RegExp(`^### ${pass}\\n\\n\`SKIPPED\` — fast는 이 패스를 돌리지 않는다`, 'm'))
  }
  assert.match(run.findings, /^### 정확성\n\n#### 🔴 `CR-1`/m)
  assert.doesNotMatch(run.findings, /결과 없음/)
  assert.match(run.findings, /\*\*높은 영향의 차단 후보\*\* — 검증 유지 0건 · 반박 후 정책상 유지 0건 · 검증 판정 없음\/대상 아님\/꺼짐 1건/)

  // 스냅숏: 적용 1개(리뷰어 하나)를 모았으면 완료
  assert.match(run.plan, /\*\*검토 상태: 완료\*\* — 적용 1개 중 수집 1/)
})

test('fast 실행의 지적이 없으면 정확성은 "지적 없음."이고 모듈 섹션은 없다 — 결과 없음으로 그리지 않는다', t => {
  const run = runFast(t, { schemaVersion: 1, findings: [], openQuestions: [] })
  assert.doesNotMatch(run.findings, /^### \d\d /m)
  // 섹션이 하나도 없으면 상세 지적이 잘린 것처럼 보인다 — 2026-11-10 PR #255 리포트가 그랬다. 없다고 적는다
  assert.match(run.findings, /지적이 있는 모듈만 싣는다\.\n\n규칙 모듈\(01~21\)에서 나온 지적 없음\.\n/)
  assert.match(run.findings, /^### 정확성\n\n지적 없음\.$/m)
  assert.doesNotMatch(run.findings, /결과 없음/)
})

test('fast 실행도 full과 같은 세 조각(실행 계획·상세 지적·타임라인)으로 조립하고, 기록 검사를 통과한다', t => {
  const run = runFast(t, { schemaVersion: 1, findings: [HIGH_CR], openQuestions: [] })
  const { env } = run
  ok(call(env, 'review-timeline.mjs', ['--summary', '--out', timing(env, 'timeline.md')]), 'summary')
  ok(call(env, 'review-timeline.mjs', ['--check', '--before-end']), 'check --before-end')
  const template = timing(env, 'template.md')
  writeFileSync(template, [
    '# `feat/x` 빠른 코드 리뷰 리포트', '', '## 판정', '', '높은 영향 지적 1건.', '',
    '## 실행 계획', '', '{{plan}}', '', '{{findings}}', '', '## 실행 타임라인', '', '{{timeline}}', '',
  ].join('\n'), 'utf8')
  const assembled = JSON.parse(ok(call(env, 'assemble-report.mjs', ['--template', template]), 'assemble').stdout)
  const report = readFileSync(assembled.path, 'utf8')
  assert.match(report, /\*\*검토 상태: 완료\*\*/)
  assert.match(report, /^## 상세 지적$/m)
  assert.match(report, /^## 특수 패스$/m)
  ok(call(env, 'review-timeline.mjs', ['--phase', 'render.wrote', '--set', `path=${assembled.path}`, '--set', `lines=${assembled.lines}`]), 'render.wrote')
  ok(call(env, 'review-timeline.mjs', ['--phase', 'run.end', '--set', 'verdict=blocking']), 'run.end')
  const check = call(env, 'review-timeline.mjs', ['--check'])
  assert.equal(check.status, 0, check.stdout + check.stderr)
  assert.doesNotMatch(check.stdout, /applied/)
})
