import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseSnapshot } from '../scripts/lib/review-snapshot.mjs'

// full의 정확성 패스(#88 PR 1)를 실제 스크립트 순서대로 끝까지 돌린다 —
// preflight → 결과 파일·module.done → prepare-verification --collect → 검증자 판정 →
// tally-verdicts --collect → render-findings → review-snapshot.
//
// **producer와 검증자의 응답은 이 파일이 정한 고정값이다.** 모델을 부르지 않는다. 그래서
// 이 테스트가 증명하는 것은 CR 지적이 수집·검증·렌더·스냅숏까지 출처·영향도·확신도를
// 잃지 않고 가는지, 실패가 실패로 남는지다. 모델이 이 결함들을 **찾는지**는 증명하지
// 않는다 — 그것은 실제 실행으로만 잴 수 있고, 실행할지는 사용자가 정한다(`evals/README.md`).
//
// 시나리오 셋(#88 PR 1 완료 기준):
// - 삭제된 가드 — `src/session.ts`에서 만료 검사를 지웠다. 지적은 merge-base의 지운 줄을 가리킨다
// - 변경되지 않은 호출자 — `src/format.ts`가 빈 문자열 대신 undefined를 돌려주게 됐고,
//   diff 밖의 `src/header.ts`가 여전히 문자열을 전제한다. 지적은 바뀌지 않은 파일을 가리킨다
// - 방어 장치가 있는 반례 — "취소 뒤 늦은 응답이 상태를 덮는다"는 지적에, 바로 위 줄의 취소
//   검사가 반례다. 검증자가 반박하고, 같은 자리의 `04-3` 지적과 관련 지적으로 이어진다

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const RULES = join(ROOT, 'review-rules')
const SCRIPTS = join(ROOT, 'scripts')
const RUN = 'code-review-full-feat-correctness-2026-10-06'
const CATALOG = JSON.parse(readFileSync(join(RULES, 'catalog.json'), 'utf8'))
const NUMBERED = CATALOG.modules
  .filter(module => module.role === 'module' && module.workflows.includes('full') && module.phaseByWorkflow?.full !== 'post-verification-synthesis')
  .map(module => module.path.replace(/\.md$/, ''))
const ALWAYS = [...NUMBERED, 'props', 'math', 'exception']

const BASE_FILES = {
  'src/session.ts': 'export function renew(session) {\n  if (session.expired) return null\n  return refresh(session)\n}\n',
  'src/format.ts': "export function formatName(user) {\n  return user.name ?? ''\n}\n",
  'src/header.ts': "import { formatName } from './format'\n\nexport function title(user) {\n  return formatName(user).toUpperCase()\n}\n",
  'src/load.ts': 'export async function load(controller, setState) {\n  const data = await fetchData(controller.signal)\n  setState(data)\n}\n',
}
const HEAD_FILES = {
  'src/session.ts': 'export function renew(session) {\n  return refresh(session)\n}\n',
  'src/format.ts': 'export function formatName(user) {\n  return user.name\n}\n',
  'src/load.ts': 'export async function load(controller, setState) {\n  const data = await fetchData(controller.signal)\n  if (controller.signal.aborted) return\n  setState(data)\n}\n',
}

const DELETED_GUARD = {
  ruleId: 'CR-1', title: '만료된 세션도 갱신 요청을 보낸다', body: '만료 검사가 사라져 만료 세션으로 refresh를 부른다.',
  impact: 'high', category: 'user-malfunction', confidence: 'high', evidence: '삭제된 줄이 막던 경로를 다른 코드가 막지 않는다.',
  location: { kind: 'deleted', path: 'src/session.ts', lineBefore: 2, quote: '  if (session.expired) return null' },
}
const UNCHANGED_CALLER = {
  ruleId: 'CR-2', title: '변경되지 않은 호출자가 문자열을 전제한다', body: 'formatName이 undefined를 돌려줄 수 있는데 title은 바로 toUpperCase를 부른다.',
  impact: 'high', category: 'user-malfunction', confidence: 'high', evidence: 'header.ts는 이번 diff에 없다.',
  location: { kind: 'verified', path: 'src/header.ts', line: 4, quote: '  return formatName(user).toUpperCase()' },
}
const REFUTED_BY_GUARD = {
  ruleId: 'CR-3', title: '취소 뒤 늦게 온 응답이 상태를 덮는다', body: '요청을 취소해도 응답이 오면 setState가 불린다.',
  impact: 'high', category: 'user-malfunction', confidence: 'low', evidence: '취소와 setState 사이의 순서를 봤다.',
  reason: '취소 신호를 읽는 쪽을 다 확인하지 못했다',
  location: { kind: 'verified', path: 'src/load.ts', line: 4, quote: '  setState(data)' },
}
const RULE_SAME_LINE = {
  ruleId: '04-3', title: '비동기 결과를 반영하기 전 정리 여부', body: '언마운트 뒤 반영을 막는 정리 코드를 확인한다.',
  impact: 'low', confidence: 'high',
  location: { kind: 'verified', path: 'src/load.ts', line: 4, quote: '  setState(data)' },
}

const VERDICTS = {
  'CR-1#1': { disposition: 'upheld', evidence: 'merge-base의 2번 줄 가드가 사라졌고 다른 만료 검사가 없다.', location: DELETED_GUARD.location },
  'CR-2#1': { disposition: 'upheld', evidence: 'header.ts의 title은 반환값을 검사하지 않는다.', location: UNCHANGED_CALLER.location },
  'CR-3#1': {
    disposition: 'rejected', evidence: 'setState 바로 위에서 취소 신호를 보고 반환한다.', location: REFUTED_BY_GUARD.location,
    rebuttal: { kind: 'guard-exists', location: { kind: 'verified', path: 'src/load.ts', line: 3, quote: '  if (controller.signal.aborted) return' } },
  },
  '04-3#1': { disposition: 'upheld', evidence: '정리 코드가 없다.', location: RULE_SAME_LINE.location },
}

const git = (cwd, ...args) => execFileSync('git', [
  '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false',
  '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false', ...args,
], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const node = (cwd, script, args) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { cwd, encoding: 'utf8' })

/** 시나리오 저장소를 만들고 preflight로 실행을 시작한다. */
const startRun = (t, { correctness }) => {
  const repo = mkdtempSync(join(tmpdir(), 'correctness-repo-'))
  const dir = mkdtempSync(join(tmpdir(), 'correctness-dir-'))
  t.after(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })
  git(repo, 'init', '-q')
  const write = files => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true })
      writeFileSync(join(repo, path), text)
    }
  }
  write(BASE_FILES)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base')
  const base = git(repo, 'rev-parse', 'HEAD')
  write(HEAD_FILES)
  git(repo, 'commit', '-qam', 'change')
  const started = node(repo, 'review-preflight.mjs', ['--dir', dir, '--run', RUN, '--rules', RULES, '--workflow', 'full', '--base', base, '--host', 'test', '--correctness', correctness])
  assert.equal(started.status, 0, started.stderr)
  const timing = join(dir, '.timing')
  const sidecar = join(timing, `${RUN}.jsonl`)
  const log = event => appendFileSync(sidecar, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`)
  log({ phase: 'modules.planned', candidates: NUMBERED.length, applied: NUMBERED.length, skipped: [], unknown: [] })
  return { repo, dir, base, timing, log }
}

/** producer 결과를 받는 즉시 파일로 남기고 module.done을 쓰는 오케스트레이터 몫을 흉내 낸다. */
const finishModule = ({ timing, log }, name, findings, extra = {}) => {
  writeFileSync(join(timing, `${RUN}.${name}.json`), JSON.stringify({ schemaVersion: 1, findings, openQuestions: [] }))
  log({ phase: 'module.done', module: name, attempt: 1, status: 'ok', ...extra })
}

const collect = run => {
  const out = node(run.repo, 'prepare-verification.mjs', ['--merge-base', run.base, '--dir', run.dir, '--run', RUN, '--rules', RULES, '--collect'])
  assert.equal(out.status, 0, out.stderr)
  const routedPath = join(run.timing, `${RUN}.routed.json`)
  writeFileSync(routedPath, out.stdout)
  return { routed: JSON.parse(out.stdout), routedPath, stderr: out.stderr }
}

/** 검증자 작업마다 이 파일이 정한 판정을 그 작업의 verdict 자리에 쓴다. */
const answerVerifiers = routed => {
  for (const task of routed.verifierTasks) {
    const verdicts = task.candidateIds.map(candidateId => ({ candidateId, ...VERDICTS[candidateId] }))
    writeFileSync(task.verdict, JSON.stringify({ schemaVersion: 1, verdicts }))
  }
}

// 판정 파일은 tally-verdicts가 남겼을 때만 넘긴다. 검증 대상이 없는 실행에는 그 파일이 없다.
const render = (run, routedPath, { phase = 'rollout-shadow', verdicts = true } = {}) => node(run.repo, 'render-findings.mjs', [
  '--input', routedPath, ...(verdicts ? ['--verdicts', join(run.timing, `${RUN}.verdicts.json`)] : []),
  '--phase-high', phase, '--phase-low', phase, '--verification-state', 'ran', '--rules', RULES, '--workflow', 'full',
])

const snapshot = (run, extra = []) => node(run.repo, 'review-snapshot.mjs', ['--dir', run.dir, '--run', RUN, '--rules', RULES, '--repo', run.repo, ...extra])

const section = (markdown, title) => {
  const from = markdown.indexOf(`### ${title}\n`)
  if (from === -1) return null
  const next = markdown.indexOf('\n### ', from + 1)
  return markdown.slice(from, next === -1 ? undefined : next)
}

test('세 반례가 수집·검증·렌더·스냅숏까지 출처와 두 축을 잃지 않고 간다', t => {
  const run = startRun(t, { correctness: 'on' })
  for (const name of ALWAYS) finishModule(run, name, name === '04-state' ? [RULE_SAME_LINE] : [])
  finishModule(run, 'correctness', [DELETED_GUARD, UNCHANGED_CALLER, REFUTED_BY_GUARD])

  const { routed, routedPath } = collect(run)
  assert.deepEqual(routed.collected.optIn, { correctness: 'on' })
  const byId = new Map(routed.candidates.map(candidate => [candidate.candidateId, candidate]))
  // 삭제된 가드는 merge-base에서, 바뀌지 않은 호출자는 작업 트리에서 읽어 맞는다
  for (const id of ['CR-1#1', 'CR-2#1', 'CR-3#1']) {
    assert.equal(byId.get(id).source, 'correctness')
    assert.equal(byId.get(id).locationCheck, 'location-ok', id)
    assert.equal(byId.get(id).eligibility, 'VERIFY', id)
  }
  // 같은 자리의 규칙 지적과 합치지 않고 잇는다
  assert.deepEqual(byId.get('CR-3#1').relatedCandidateIds, ['04-3#1'])
  assert.deepEqual(byId.get('04-3#1').relatedCandidateIds, ['CR-3#1'])

  // CR 검증 작업은 조항 대신 판정 기준을 받는다
  for (const task of routed.verifierTasks.filter(entry => entry.candidateIds.some(id => id.startsWith('CR-')))) {
    assert.equal(task.missingClauses, undefined)
    const prompt = readFileSync(task.prompt, 'utf8')
    assert.match(prompt, /규칙 조항이 없다/)
    assert.match(prompt, /변경되지 않은 호출자/)
    assert.doesNotMatch(prompt, /^#{2,4} CR-\d+\./m)
  }

  answerVerifiers(routed)
  const tally = node(run.repo, 'tally-verdicts.mjs', ['--dir', run.dir, '--run', RUN, '--rules', RULES, '--collect', '--targets', routedPath])
  assert.equal(tally.status, 0, tally.stderr)

  const rendered = render(run, routedPath)
  assert.equal(rendered.status, 0, rendered.stderr)
  const correctness = section(rendered.stdout, '정확성')
  assert.ok(correctness, rendered.stdout)
  assert.match(correctness, /#### 🔴 `CR-1` 만료된 세션도 갱신 요청을 보낸다\n영향: 높음 \(사용자에게 보이는 오동작 또는 사용 불가\) · 확신: 높음 · 교차검증: `유지`\n출처 패스: correctness\n`src\/session\.ts:2` — `  if \(session\.expired\) return null`/)
  assert.match(correctness, /#### 🔴 `CR-2` 변경되지 않은 호출자가 문자열을 전제한다\n[^\n]*교차검증: `유지`\n출처 패스: correctness\n`src\/header\.ts:4`/)
  // rollout-shadow에서 반박된 지적은 남고 등급도 그대로다(C-6B)
  assert.match(correctness, /#### 🟡 `CR-3` 취소 뒤 늦게 온 응답이 상태를 덮는다\n영향: 높음 [^\n]* · 확신: 낮음 · 교차검증: `반박됨 — 관찰 중`\n출처 패스: correctness\n관련 지적: `04-3`\n/)
  assert.match(section(rendered.stdout, '04 상태 관리 & 사이드이펙트') ?? '', /관련 지적: `CR-3`/)

  const snap = snapshot(run, ['--verification-state', 'ran'])
  assert.equal(snap.status, 0, snap.stderr)
  const saved = parseSnapshot(readFileSync(join(run.timing, `${RUN}.snapshot.json`), 'utf8')).value
  assert.equal(saved.status, 'complete')
  assert.deepEqual(saved.scope.modules.find(module => module.name === 'correctness'), { name: 'correctness', kind: 'pass', state: 'ok', attempt: 1 })
  const disposition = new Map(saved.findings.map(finding => [finding.candidateId, finding]))
  assert.equal(disposition.get('CR-1#1').disposition, 'upheld')
  assert.equal(disposition.get('CR-2#1').disposition, 'upheld')
  assert.equal(disposition.get('CR-3#1').disposition, 'rejected')
  assert.equal(disposition.get('CR-3#1').rebuttalKind, 'guard-exists')
  assert.deepEqual(disposition.get('CR-3#1').sources, ['correctness'])
  assert.equal(disposition.get('CR-3#1').confidence, 'low')
})

test('active-deletion에서 반박된 CR 지적은 지워지고, 그 사실이 알림으로 나온다', t => {
  const run = startRun(t, { correctness: 'on' })
  for (const name of ALWAYS) finishModule(run, name, name === '04-state' ? [RULE_SAME_LINE] : [])
  finishModule(run, 'correctness', [DELETED_GUARD, UNCHANGED_CALLER, REFUTED_BY_GUARD])
  const { routed, routedPath } = collect(run)
  answerVerifiers(routed)
  assert.equal(node(run.repo, 'tally-verdicts.mjs', ['--dir', run.dir, '--run', RUN, '--rules', RULES, '--collect', '--targets', routedPath]).status, 0)
  const rendered = render(run, routedPath, { phase: 'active-deletion' })
  assert.equal(rendered.status, 0, rendered.stderr)
  assert.doesNotMatch(rendered.stdout, /`CR-3`/)
  assert.match(rendered.stderr, /CR-3 \(src\/load\.ts\): guard-exists/)
  // 지워진 지적을 가리키던 관련 지적 줄은 그것이 상세 지적에 없다고 말한다
  assert.match(rendered.stdout, /관련 지적: `CR-3#1` \(상세 지적에 없음\)/)
})

for (const [failureClass, attempts] of [['inactivity-timeout', 2], ['malformed-output', 1]]) {
  test(`정확성 패스가 ${failureClass}로 끝나면 실패로 남는다 — 지적 0건이나 통과가 아니다`, t => {
    const run = startRun(t, { correctness: 'on' })
    for (const name of ALWAYS) finishModule(run, name, [])
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      run.log({ phase: 'module.start', module: 'correctness', attempt })
      run.log({ phase: 'module.done', module: 'correctness', attempt, status: 'failed', failureClass })
    }
    const { routedPath } = collect(run)
    const rendered = render(run, routedPath, { verdicts: false })
    assert.equal(rendered.status, 0, rendered.stderr)
    assert.match(section(rendered.stdout, '정확성'), /결과 없음 — /)

    const snap = snapshot(run, ['--verification-state', 'ran'])
    assert.equal(snap.status, 0, snap.stderr)
    const saved = parseSnapshot(readFileSync(join(run.timing, `${RUN}.snapshot.json`), 'utf8')).value
    assert.equal(saved.status, 'partial')
    assert.deepEqual(saved.scope.modules.find(module => module.name === 'correctness'),
      { name: 'correctness', kind: 'pass', state: 'failed', attempt: attempts, failureClass })
    assert.match(snap.stdout, new RegExp(`\\| \`correctness\` \\| \`FAILED\` \\| 시도 ${attempts} · \`${failureClass}\` \\|`))
    assert.match(snap.stdout, /검토 상태: 부분 완료/)
  })
}

test('켜지 않은 실행은 정확성을 SKIPPED로 그리고, 돌린 결과가 있어도 모으지 않는다', t => {
  const run = startRun(t, { correctness: 'off' })
  for (const name of ALWAYS) finishModule(run, name, [])
  finishModule(run, 'correctness', [DELETED_GUARD])
  const { routed, routedPath, stderr } = collect(run)
  assert.deepEqual(routed.collected.excludedNotRequested, ['correctness'])
  assert.equal(routed.candidates.length, 0)
  assert.match(stderr, /켜지 않은 선택 패스/)
  const rendered = node(run.repo, 'render-findings.mjs', [
    '--input', routedPath, '--phase-high', 'rollout-shadow', '--phase-low', 'rollout-shadow',
    '--verification-state', 'ran', '--rules', RULES, '--workflow', 'full',
  ])
  assert.equal(rendered.status, 0, rendered.stderr)
  assert.match(section(rendered.stdout, '정확성'), /`SKIPPED` — 선택 패스, 이 실행에서 켜지 않았다\(`--correctness on` 없음\) · 비차단 기록이나 결과 파일이 있었지만/)
  const snap = snapshot(run, ['--verification-state', 'ran'])
  assert.equal(snap.status, 0, snap.stderr)
  const saved = parseSnapshot(readFileSync(join(run.timing, `${RUN}.snapshot.json`), 'utf8')).value
  assert.equal(saved.status, 'complete')
  assert.equal(saved.scope.modules.find(module => module.name === 'correctness').reasonCode, 'not-requested')
})
