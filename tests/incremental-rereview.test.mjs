import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseSnapshot } from '../scripts/lib/review-snapshot.mjs'

// 증분 재리뷰(C-13, #88 PR 4)를 실제 스크립트 순서대로 두 번 돌린다.
//
// 첫 실행이 스냅숏을 남기고, 코드를 고친 뒤 두 번째 실행이 `--previous`로 그 스냅숏과 비교한다.
// producer와 검증자의 응답은 이 파일이 정한 고정값이다 — 모델을 부르지 않는다. 그래서 이 테스트가
// 증명하는 것은 잇기·재확인·집계·렌더·스냅숏이 서로 이어지고, 해결 확인이 재확인 판정 없이는
// 나오지 않는다는 것이다. 모델이 지적을 다시 찾는지는 증명하지 않는다.
//
// 두 실행 사이의 변화:
// - src/load.ts 맨 위에 줄을 넣었다 → 04-3은 줄이 밀려도 이어진다(미해결)
// - src/move.ts를 src/lib/move.ts로 그대로 옮겼다 → 02-1은 이어진다(미해결)
// - src/header.ts의 정확성 지적이 두 번째 실행에서는 CR-2로 나온다 → 번호가 달라도 이어진다
// - src/dup.ts의 같은 줄 두 개에 04-1이 둘씩 나온다 → 합치지 않고 모두 재확인 필요
// - src/fix.ts를 고쳤고, 06-jsx 규칙 문서도 바뀌었다 → 다시 나오지 않고, 재확인 검증이 막는 코드를 댄다 → 해결 확인
// - 05-structure 모듈이 두 번째 실행에서 실패했다 → 그 모듈의 이전 지적은 재확인 필요
// - src/gone.ts를 지웠다 → 재확인 검증이 동작이 옮겨 갔다고 한다 → 미해결
// - src/other.ts는 그대로인데 04-2가 다시 나오지 않았고, 재확인 판정도 오지 않았다 → 재확인 필요

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPTS = join(ROOT, 'scripts')
const RUN_A = 'code-review-full-feat-x-2026-10-06'
const RUN_B = 'code-review-full-feat-x-2026-10-07'

const at = (path, line, quote) => ({ kind: 'verified', path, line, quote })
const finding = (ruleId, title, location) => ({ ruleId, title, body: `${title}의 본문`, impact: 'low', confidence: 'high', location })

const FILES_A = {
  'src/load.ts': 'export async function load(setState) {\n  const data = await fetchData()\n  setState(data)\n}\n',
  'src/move.ts': 'export const x: any = 1\n',
  'src/header.ts': "import { formatName } from './format'\n\nexport function title(user) {\n  return formatName(user).toUpperCase()\n}\n",
  'src/dup.ts': 'export function run() {\n  doThing()\n  other()\n  doThing()\n}\n',
  'src/fix.ts': 'export function view(items) {\n  return items.length && <List items={items} />\n}\n',
  'src/perf.ts': 'export function big() {\n  return 1\n}\n',
  'src/gone.ts': 'export function legacy() {\n  window.addEventListener("x", handler)\n}\n',
  'src/other.ts': 'export function other(deps) {\n  useEffect(run, [])\n}\n',
}

const FINDINGS_A = {
  '04-state': [
    finding('04-3', '비동기 결과 반영 전 정리', at('src/load.ts', 3, '  setState(data)')),
    finding('04-1', '클린업 없는 부수효과', at('src/dup.ts', 2, '  doThing()')),
    finding('04-1', '클린업 없는 부수효과', at('src/dup.ts', 4, '  doThing()')),
    finding('04-2', '빠진 의존성', at('src/other.ts', 2, '  useEffect(run, [])')),
    finding('04-4', '해제 없는 리스너', at('src/gone.ts', 2, '  window.addEventListener("x", handler)')),
  ],
  '02-type': [finding('02-1', 'any로 타입을 우회한다', at('src/move.ts', 1, 'export const x: any = 1'))],
  '06-jsx': [finding('06-1', '0이 그대로 렌더된다', at('src/fix.ts', 2, '  return items.length && <List items={items} />'))],
  '05-structure': [finding('05-1', '함수가 길다', at('src/perf.ts', 1, 'export function big() {'))],
  correctness: [finding('CR-1', '호출자가 문자열을 전제한다', at('src/header.ts', 4, '  return formatName(user).toUpperCase()'))],
}

const FILES_B = {
  'src/load.ts': '// 데이터를 읽어 상태에 넣는다\nexport async function load(setState) {\n  const data = await fetchData()\n  setState(data)\n  setState(data)\n}\n',
  'src/fix.ts': 'export function view(items) {\n  return items.length > 0 && <List items={items} />\n}\n',
}

const FINDINGS_B = {
  '04-state': [
    finding('04-3', '비동기 결과 반영 전 정리(다시 씀)', at('src/load.ts', 4, '  setState(data)')),
    finding('04-1', '클린업 없는 부수효과', at('src/dup.ts', 2, '  doThing()')),
    finding('04-1', '클린업 없는 부수효과', at('src/dup.ts', 4, '  doThing()')),
    finding('04-5', '같은 상태를 두 번 쓴다', at('src/load.ts', 5, '  setState(data)')),
  ],
  '02-type': [finding('02-1', 'any로 타입을 우회한다', at('src/lib/move.ts', 1, 'export const x: any = 1'))],
  correctness: [
    finding('CR-1', '새로 생긴 정확성 지적', at('src/load.ts', 3, '  const data = await fetchData()')),
    finding('CR-2', '호출자가 문자열을 전제한다', at('src/header.ts', 4, '  return formatName(user).toUpperCase()')),
  ],
}

const git = (cwd, ...args) => execFileSync('git', [
  '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false',
  '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false', ...args,
], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const node = (cwd, script, args) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { cwd, encoding: 'utf8' })

const write = (repo, files) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
}

/** 한 실행: preflight → 결과 파일·module.done → 수집 → 검증자(재확인 포함) → 집계 → 렌더 → 스냅숏. */
const SAME = () => ({ disposition: 'upheld', evidence: '원인·조건·결과가 같다', location: { kind: 'unverified', reason: '두 글을 대조했다' } })
const reviewOnce = ({
  repo, dir, run, rules, base, findings, failed = [], previous,
  answerRecheck = () => undefined, answerIdentity = SAME,
  answerCurrent = candidate => ({ disposition: 'upheld', evidence: '확인했다', location: candidate.location }),
}) => {
  const catalog = JSON.parse(readFileSync(join(rules, 'catalog.json'), 'utf8'))
  const numbered = catalog.modules
    .filter(module => module.role === 'module' && module.workflows.includes('full') && module.phaseByWorkflow?.full !== 'post-verification-synthesis')
    .map(module => module.path.replace(/\.md$/, ''))
  const started = node(repo, 'review-preflight.mjs', [
    '--dir', dir, '--run', run, '--rules', rules, '--workflow', 'full', '--base', base, '--host', 'test', '--correctness', 'on',
    ...(previous ? ['--previous', previous] : []),
  ])
  assert.equal(started.status, 0, started.stderr)
  const timing = join(dir, '.timing')
  const log = event => appendFileSync(join(timing, `${run}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`)
  log({ phase: 'modules.planned', candidates: numbered.length, applied: numbered.length, skipped: [], unknown: [] })
  for (const name of [...numbered, 'props', 'math', 'exception', 'correctness']) {
    if (failed.includes(name)) {
      log({ phase: 'module.done', module: name, attempt: 1, status: 'failed', failureClass: 'inactivity-timeout' })
      continue
    }
    writeFileSync(join(timing, `${run}.${name}.json`), JSON.stringify({ schemaVersion: 1, findings: findings[name] ?? [], openQuestions: [] }))
    log({ phase: 'module.done', module: name, attempt: 1, status: 'ok' })
  }

  const collected = node(repo, 'prepare-verification.mjs', ['--merge-base', base, '--dir', dir, '--run', run, '--rules', rules, '--collect'])
  assert.equal(collected.status, 0, collected.stderr)
  const routedPath = join(timing, `${run}.routed.json`)
  writeFileSync(routedPath, collected.stdout)
  const routed = JSON.parse(collected.stdout)

  const byId = new Map(routed.candidates.map(candidate => [candidate.candidateId, candidate]))
  for (const task of routed.verifierTasks) {
    if (task.route === 'recheck' || task.route === 'identity') {
      const verdict = (task.route === 'recheck' ? answerRecheck : answerIdentity)(task.candidateIds[0])
      if (verdict) writeFileSync(task.verdict, JSON.stringify({ schemaVersion: 1, verdicts: [{ candidateId: task.candidateIds[0], ...verdict }] }))
      continue
    }
    const verdicts = task.candidateIds.map(candidateId => ({ candidateId, ...answerCurrent(byId.get(candidateId)) }))
    writeFileSync(task.verdict, JSON.stringify({ schemaVersion: 1, verdicts }))
  }
  // 검증할 작업이 없으면 집계하지 않는다(SKILL). 이 시나리오의 지적은 모두 영향이 낮아 교차검증 대상이
  // 아니고, 두 번째 실행의 작업은 재확인뿐이다.
  const tallied = routed.verifierTasks.length
    ? node(repo, 'tally-verdicts.mjs', ['--dir', dir, '--run', run, '--rules', rules, '--collect', '--targets', routedPath])
    : null
  if (tallied) assert.equal(tallied.status, 0, tallied.stderr)
  const rechecksPath = join(timing, `${run}.rechecks.json`)
  const rendered = node(repo, 'render-findings.mjs', [
    '--input', routedPath, ...(tallied ? ['--verdicts', join(timing, `${run}.verdicts.json`)] : []), '--phase-high', 'rollout-shadow', '--phase-low', 'rollout-shadow',
    ...(existsSync(rechecksPath) ? ['--rechecks', rechecksPath] : []),
    '--verification-state', 'ran', '--rules', rules, '--workflow', 'full',
  ])
  assert.equal(rendered.status, 0, rendered.stderr)
  const snap = node(repo, 'review-snapshot.mjs', ['--dir', dir, '--run', run, '--rules', rules, '--repo', repo, '--verification-state', 'ran'])
  assert.equal(snap.status, 0, snap.stderr)
  const snapshotPath = join(timing, `${run}.snapshot.json`)
  return { routed, tally: tallied ? JSON.parse(tallied.stdout) : null, rendered: rendered.stdout, block: snap.stdout, snapshotPath, snapshot: parseSnapshot(readFileSync(snapshotPath, 'utf8')).value }
}

/** 첫 실행 → 고침 → 두 번째 실행(--previous). 재확인과 같은 결함 판정은 이 파일이 정한 고정값이다. */
const twoRuns = t => {
  const repo = mkdtempSync(join(tmpdir(), 'rereview-repo-'))
  const dir = mkdtempSync(join(tmpdir(), 'rereview-dir-'))
  const rules = mkdtempSync(join(tmpdir(), 'rereview-rules-'))
  t.after(() => {
    for (const path of [repo, dir, rules]) rmSync(path, { recursive: true, force: true })
  })
  cpSync(join(ROOT, 'review-rules'), rules, { recursive: true })
  git(repo, 'init', '-q')
  write(repo, { 'README.md': 'base\n' })
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base')
  const base = git(repo, 'rev-parse', 'HEAD')
  write(repo, FILES_A)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'feature')

  const first = reviewOnce({ repo, dir, run: RUN_A, rules, base, findings: FINDINGS_A })

  // 고친다: 줄 삽입, 그대로 옮기기, 결함 수정, 파일 삭제, 규칙 문서 변경
  write(repo, FILES_B)
  mkdirSync(join(repo, 'src', 'lib'), { recursive: true })
  git(repo, 'mv', 'src/move.ts', 'src/lib/move.ts')
  git(repo, 'rm', '-q', 'src/gone.ts')
  git(repo, 'commit', '-qam', 'fix')
  appendFileSync(join(rules, '06-jsx.md'), '\n<!-- 06-1 설명을 고쳤다 -->\n')

  const refOf = (ruleId, path) => {
    const entry = first.snapshot.findings.find(one => one.ruleId === ruleId && one.location.path === path)
    return entry.ref
  }
  const fixedRef = refOf('06-1', 'src/fix.ts')
  const goneRef = refOf('04-4', 'src/gone.ts')
  const perfRef = refOf('05-1', 'src/perf.ts')
  const second = reviewOnce({
    repo, dir, run: RUN_B, rules, base, findings: FINDINGS_B, failed: ['05-structure'], previous: first.snapshotPath,
    answerRecheck: ref => {
      if (ref === fixedRef) {
        return {
          disposition: 'rejected', evidence: '0과 비교해 불리언으로 바꾼다', location: at('src/fix.ts', 2, '  return items.length > 0 && <List items={items} />'),
          rebuttal: { kind: 'guard-exists', location: at('src/fix.ts', 2, '  return items.length > 0 && <List items={items} />') },
        }
      }
      if (ref === goneRef) return { disposition: 'upheld', evidence: '리스너 등록이 다른 파일로 옮겨 갔다', location: { kind: 'unverified', reason: '옮겨 간 자리를 찾지 못했다' } }
      if (ref === perfRef) return { disposition: 'needs-context', evidence: '함수를 다 보지 못했다', reason: '모듈 결과가 없다', location: { kind: 'unverified', reason: '확인하지 못했다' } }
      return undefined
    },
  })
  return { repo, dir, rules, base, first, second, refOf, fixedRef, goneRef, perfRef }
}

test('수정 뒤 다시 리뷰하면 이전 지적을 이어 붙이고, 재확인 판정이 막는 코드를 댄 것만 해결 확인이다', t => {
  const { first, second, refOf, fixedRef, goneRef, perfRef } = twoRuns(t)
  assert.equal(first.snapshot.status, 'complete')
  assert.equal(first.snapshot.comparison, undefined)
  assert.ok(first.snapshot.run.ruleDocs['06-jsx.md'])
  // 비교하지 않은 실행의 지적도 실행 간 이름을 갖는다 — 다음 비교의 출발점이다
  assert.ok(first.snapshot.findings.every(entry => entry.lineageId === entry.ref))

  // 검증 준비가 이번 후보와 이전 지적을 잇는다
  const lineage = Object.fromEntries(second.routed.candidates.map(candidate => [`${candidate.ruleId}@${candidate.location.path}:${candidate.location.line}`, candidate.lineage]))
  assert.equal(lineage['04-3@src/load.ts:4'].status, 'linked', '줄이 밀려도 이어진다')
  assert.equal(lineage['02-1@src/lib/move.ts:1'].status, 'linked', '그대로 옮긴 파일도 이어진다')
  // CR은 번호를 빼고 비교하지만, 규칙 ID가 결함의 종류를 말하지 않으므로 같은 결함인지 묻는다(PR #94 리뷰)
  assert.deepEqual([lineage['CR-2@src/header.ts:4'].status, lineage['CR-2@src/header.ts:4'].reason], ['recheck', 'identity-unconfirmed'])
  const identity = second.routed.verifierTasks.find(task => task.route === 'identity')
  assert.deepEqual(identity.candidateIds, [refOf('CR-1', 'src/header.ts')])
  const identityPrompt = readFileSync(identity.prompt, 'utf8')
  assert.match(identityPrompt, /# 같은 결함인가 — 이전 리뷰의 지적과 이번 리뷰의 지적/)
  assert.match(identityPrompt, /### 이전 리뷰의 지적[\s\S]*호출자가 문자열을 전제한다[\s\S]*### 이번 리뷰의 지적[\s\S]*호출자가 문자열을 전제한다/)
  assert.deepEqual([lineage['04-1@src/dup.ts:2'].status, lineage['04-1@src/dup.ts:4'].status], ['recheck', 'recheck'])
  assert.deepEqual(lineage['04-5@src/load.ts:5'], { status: 'new', lineageId: `${second.snapshot.run.runId}/04-5#1`, fileChanged: true, ruleChanged: false })
  assert.equal(lineage['CR-1@src/load.ts:3'].status, 'new')

  // 재확인 작업은 재확인 지시를 받는다 — 교차검증의 "기본 입장은 반박"이 아니다
  const rechecks = second.routed.verifierTasks.filter(task => task.route === 'recheck')
  assert.deepEqual(rechecks.map(task => task.candidateIds[0]).sort(), [fixedRef, goneRef, perfRef, refOf('04-2', 'src/other.ts')].sort())
  const prompt = readFileSync(rechecks.find(task => task.candidateIds[0] === fixedRef).prompt, 'utf8')
  assert.match(prompt, /# 재확인 — 이전 리뷰의 지적이 지금 코드에서 성립하는가/)
  assert.match(prompt, /기본 입장은 없습니다/)
  assert.doesNotMatch(prompt, /기본 입장은 반박입니다/)
  assert.match(prompt, /규칙 문서가 이전 실행 뒤에 바뀌었다/)
  assert.match(prompt, /REVIEW_VERDICT_CONTRACT_V1/)

  // 재확인 판정은 교차검증 수치에 섞이지 않는다
  assert.deepEqual(second.tally.rechecks && { requested: second.tally.rechecks.requested, upheld: second.tally.rechecks.upheld, rejected: second.tally.rechecks.rejected, needsContext: second.tally.rechecks.needsContext, noVerdict: second.tally.rechecks.noVerdict },
    { requested: 4, upheld: 1, rejected: 1, needsContext: 1, noVerdict: 1 })
  assert.equal(second.tally.rejected, 0)
  assert.deepEqual(second.tally.rechecks.identities, { requested: 1, same: 1, different: 0, unknown: 0, noVerdict: 0 })

  // 스냅숏의 비교
  const { comparison } = second.snapshot
  const statusOf = ref => comparison.entries.find(entry => entry.ref === ref)
  assert.deepEqual([statusOf(fixedRef).status, statusOf(fixedRef).rebuttalKind, statusOf(fixedRef).firstReason], ['resolved', 'guard-exists', 'rule-changed'])
  assert.deepEqual([statusOf(goneRef).status, statusOf(goneRef).basis, statusOf(goneRef).firstReason], ['persisting', 'recheck', 'file-deleted'])
  assert.deepEqual([statusOf(perfRef).status, statusOf(perfRef).reason, statusOf(perfRef).firstReason], ['recheck', 'recheck-needs-context', 'not-reviewed'])
  assert.deepEqual([statusOf(refOf('04-2', 'src/other.ts')).status, statusOf(refOf('04-2', 'src/other.ts')).reason], ['recheck', 'no-recheck-verdict'])
  assert.deepEqual(comparison.counts, { persisting: 4, resolved: 1, recheck: 4 })
  assert.deepEqual(comparison.current, { new: 2, linked: 3, recheck: 2 })
  assert.equal(comparison.reused, 0)
  // 이어진 지적은 이전의 이름을 물려받는다
  const moved = second.snapshot.findings.find(entry => entry.ruleId === '02-1')
  assert.equal(moved.lineageId, refOf('02-1', 'src/move.ts'))
  // 같은 결함이라는 판정을 받은 CR은 이어지고 이름을 물려받는다
  const header = second.snapshot.findings.find(entry => entry.ruleId === 'CR-2')
  assert.deepEqual([header.lineageId, header.lineage.status, header.lineage.basis], [refOf('CR-1', 'src/header.ts'), 'linked', 'identity'])
  assert.deepEqual([statusOf(refOf('CR-1', 'src/header.ts')).status, statusOf(refOf('CR-1', 'src/header.ts')).basis], ['persisting', 'identity'])
  assert.ok(second.snapshot.inputs.some(input => input.role === 'previous'))
  assert.ok(second.snapshot.inputs.some(input => input.role === 'rechecks'))

  // 리포트
  assert.match(second.rendered, /이전 리뷰: 이어짐 — 이전 지적 `[^`]+\/02-1#1`이 아직 남아 있다/)
  assert.match(second.rendered, /이전 리뷰: 이어짐 — 이전 지적 `[^`]+\/CR-1#1`이 아직 남아 있다/)
  assert.match(second.rendered, /이전 리뷰: 신규\n/)
  assert.match(second.rendered, /이전 리뷰: 재확인 필요 — 같은 규칙·같은 자리에 이전 지적이 있지만/)
  assert.match(second.block, /\*\*이전 리뷰와 비교\*\* — 이전 실행 `[^`]+`\(HEAD `[0-9a-f]{12}`\)의 지적 9개: 미해결 4 · 해결 확인 1 · 재확인 필요 4/)
  assert.match(second.block, /재사용 0 — 이번 실행은 적용 대상 모듈을 모두 다시 리뷰했다/)
  assert.match(second.block, new RegExp(`\\| \`${fixedRef.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&')}\` \\| \`06-1\` \\| 해결 확인 \\|`))
})

test('다른 저장소의 스냅숏과는 비교하지 않는다', t => {
  const repo = mkdtempSync(join(tmpdir(), 'rereview-other-'))
  const dir = mkdtempSync(join(tmpdir(), 'rereview-other-dir-'))
  t.after(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })
  git(repo, 'init', '-q')
  write(repo, { 'a.txt': 'a\n' })
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'a')
  const snapshot = {
    schemaVersion: 1, kind: 'review-snapshot', createdAt: 'x',
    run: { runId: 'r', name: 'n', workflow: 'full', pluginVersion: 'v', rules: 'r', rulesDigest: `sha256:${'a'.repeat(64)}`, host: 'h', startedAt: 'x' },
    target: { repo: null, repoRoot: 'b'.repeat(40), branch: 'b', base: 'main', mergeBase: 'c'.repeat(40), head: 'd'.repeat(40), worktree: 'clean', dirtyFiles: 0 },
    drift: [], status: 'complete', scope: { modules: [], counts: { applied: 0, ok: 0, failed: 0, missing: 0, skipped: 0, unknown: 0 } },
    verification: { state: 'ran' }, findings: [], openQuestions: [], inputs: [], notes: [],
  }
  const path = join(dir, 'previous.snapshot.json')
  writeFileSync(path, JSON.stringify(snapshot))
  const out = node(repo, 'review-preflight.mjs', ['--dir', dir, '--run', RUN_B, '--rules', join(ROOT, 'review-rules'), '--workflow', 'full', '--base', 'HEAD', '--host', 'test', '--previous', path])
  assert.equal(out.status, 2)
  assert.match(out.stderr, /다른 저장소의 리뷰다/)
  assert.equal(existsSync(join(dir, '.timing', `${RUN_B}.jsonl`)), false)
})

// ── PR #94 리뷰: 세 번째 리뷰 ──────────────────────────────────────────
//
// 두 번째 실행이 재확인으로 "지금도 성립한다"고 확인했거나 재확인하지 못한 이전 지적은, 두 번째 실행의 지적이
// 아니다(그 실행의 producer는 내지 않았다). 직전 스냅숏의 지적만 비교하면 세 번째 실행에서 사라진다.

const FINDINGS_C = {
  '04-state': [{ ...finding('04-3', '비동기 결과 반영 전 정리(다시 씀)', at('src/load.ts', 4, '  setState(data)')), impact: 'high', category: 'user-malfunction' }],
  '02-type': [finding('02-1', 'any로 타입을 우회한다', at('src/lib/move.ts', 1, 'export const x: any = 1'))],
}

const thirdRun = (context, extra = {}) => reviewOnce({
  repo: context.repo, dir: context.dir, run: 'code-review-full-feat-x-2026-10-08', rules: context.rules, base: context.base,
  findings: FINDINGS_C, previous: context.second.snapshotPath,
  // 이번 04-3 후보를 교차검증이 반박한다
  answerCurrent: candidate => (candidate.ruleId === '04-3'
    ? { disposition: 'rejected', evidence: '정리 코드가 있다', location: candidate.location, rebuttal: { kind: 'guard-exists', location: candidate.location } }
    : { disposition: 'upheld', evidence: '확인했다', location: candidate.location }),
  ...extra,
})

test('세 번째 리뷰는 앞 실행이 계속 추적하던 미해결·재확인 필요 지적을 이어받는다 — 사라지지 않는다', t => {
  const context = twoRuns(t)
  const otherRef = context.refOf('04-2', 'src/other.ts')
  const third = thirdRun(context)
  const { comparison } = third.snapshot
  const entry = ref => comparison.entries.find(one => one.ref === ref)
  // 두 번째 실행에서 재확인으로 미해결이었던 것, 재확인이 범위를 확정하지 못한 것, 판정을 받지 못한 것
  for (const ref of [context.goneRef, context.perfRef, otherRef]) {
    assert.ok(entry(ref), `${ref}가 비교에서 사라졌다`)
    assert.equal(entry(ref).carried, true)
    assert.equal(entry(ref).status, 'recheck')
  }
  // 이어받은 지적도 다시 재확인을 맡긴다 — 원래 주장의 글은 처음 낸 실행의 routed 출력에서 읽는다
  const asked = third.routed.verifierTasks.filter(task => task.route === 'recheck').map(task => task.candidateIds[0])
  for (const ref of [context.goneRef, context.perfRef, otherRef]) assert.ok(asked.includes(ref), ref)
  // 해결 확인된 지적은 더 추적하지 않는다 — 이력은 두 번째 스냅숏에 있다
  assert.equal(entry(context.fixedRef), undefined)
  assert.equal(comparison.carried, third.routed.previous.carried)
  assert.ok(comparison.carried >= 3)

  // 이어진 이번 후보가 교차검증에서 반박되면 이전 지적은 미해결이 아니라 재확인 필요다
  const stateRef = context.second.snapshot.findings.find(one => one.ruleId === '04-3').ref
  assert.deepEqual([entry(stateRef).status, entry(stateRef).reason], ['recheck', 'current-rejected'])
  assert.match(third.rendered, /이전 리뷰: 이어짐 — 이전 지적 `[^`]+`과 같은 결함인데 이번 교차검증이 반박했다/)
})

test('원래 주장의 파일을 읽을 수 없어도 이어받은 지적을 지우지 않고 claim-unavailable로 남긴다', t => {
  const context = twoRuns(t)
  rmSync(join(context.dir, '.timing', `${RUN_A}.routed.json`))
  const third = thirdRun(context)
  const entry = third.snapshot.comparison.entries.find(one => one.ref === context.perfRef)
  assert.ok(entry, '읽을 수 없다고 추적을 멈추지 않는다')
  assert.deepEqual([entry.status, entry.reason], ['recheck', 'claim-unavailable'])
  assert.match(third.snapshot.comparison.claims, /^unavailable — /)
})
