import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseEvidenceDoc } from '../scripts/lib/evidence.mjs'

// `review-evidence.mjs`를 실제로 돌린다. 재현 명령은 node 한 줄이라 모델도 네트워크도 쓰지 않는다.
//
// 이 CLI가 지키는 것: `executed`는 이 스크립트가 실제로 명령을 돌린 기록이 있을 때만 붙는다.
// 그 기록은 어느 대상(HEAD·작업 트리)에서 돌았는지, 무엇이 나왔는지(로그와 그 해시), 작업
// 트리를 바꾸지 않았는지를 갖고, 타임라인에 tool.start/tool.done 한 쌍을 남긴다.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPTS = join(ROOT, 'scripts')
const RULES = join(ROOT, 'review-rules')
const RUN = 'code-review-full-feat-evidence-2026-10-06'

const git = (cwd, ...args) => execFileSync('git', [
  '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false',
  '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false', ...args,
], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const node = (cwd, script, args) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { cwd, encoding: 'utf8' })

/** 두 커밋짜리 저장소와 리포트 디렉터리를 만들고 preflight로 시작한다. routed 출력에 후보 둘을 둔다. */
const started = t => {
  const repo = mkdtempSync(join(tmpdir(), 'evidence-repo-'))
  const dir = mkdtempSync(join(tmpdir(), 'evidence-dir-'))
  t.after(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })
  git(repo, 'init', '-q')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base')
  const base = git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'a.txt'), 'changed\n')
  git(repo, 'commit', '-qam', 'change')
  const out = node(repo, 'review-preflight.mjs', ['--dir', dir, '--run', RUN, '--rules', RULES, '--workflow', 'full', '--base', base, '--host', 'test'])
  assert.equal(out.status, 0, out.stderr)
  const timing = join(dir, '.timing')
  const runId = readFileSync(join(timing, `${RUN}.jsonl`), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).find(event => event.phase === 'run.start').runId
  writeFileSync(join(timing, `${RUN}.routed.json`), JSON.stringify({
    candidates: [{ candidateId: 'CR-1#1', ruleId: 'CR-1' }, { candidateId: '04-3#1', ruleId: '04-3' }],
    collected: { sources: [], excludedFailed: [], runId },
  }))
  return { repo, dir, base, timing, runId }
}

const exec = (run, args, command, cwd = run.repo) => node(cwd, 'review-evidence.mjs', ['exec', '--dir', run.dir, '--run', RUN, ...args, '--', ...command])
const note = (run, entries) => {
  const input = join(run.dir, 'entries.json')
  writeFileSync(input, JSON.stringify({ entries }))
  return node(run.repo, 'review-evidence.mjs', ['note', '--dir', run.dir, '--run', RUN, '--input', input])
}
const docOf = run => parseEvidenceDoc(readFileSync(join(run.timing, `${RUN}.evidence.json`), 'utf8'))
const timeline = run => readFileSync(join(run.timing, `${RUN}.jsonl`), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
const script = text => [process.execPath, '-e', text]

test('재현 명령을 실제로 돌려 로그·실행 기록·타임라인 한 쌍을 남긴다', t => {
  const run = started(t)
  const out = exec(run, ['--candidate', 'CR-1#1', '--expect-exit', '1', '--expect-output', 'BUG'], script("console.log('BUG: stale state'); process.exit(1)"))
  assert.equal(out.status, 0, out.stderr)
  const result = JSON.parse(out.stdout)
  assert.equal(result.outcome, 'reproduced')
  assert.equal(result.usable, true)
  assert.equal(result.exit, 1)
  const log = readFileSync(join(run.timing, result.artifact), 'utf8')
  assert.match(log, /BUG: stale state/)
  const record = JSON.parse(readFileSync(join(run.timing, `${RUN}.evidence`, `${result.id}.json`), 'utf8'))
  assert.equal(record.target.head, git(run.repo, 'rev-parse', 'HEAD'))
  assert.equal(record.mutatedTree, false)
  const tools = timeline(run).filter(event => event.evidenceId === result.id)
  assert.deepEqual(tools.map(event => event.phase), ['tool.start', 'tool.done'])
  assert.equal(tools[1].exit, 1)
  assert.equal(tools[1].candidateId, 'CR-1#1')
  // 근거 파일이 이 실행의 식별을 들고 생긴다
  assert.equal(docOf(run).value.run.runId, timeline(run)[0].runId)
})

test('0으로 끝나면 재현 안 됨, 시작하지 못하거나 시간을 넘기면 환경 실패다', t => {
  const run = started(t)
  const clean = JSON.parse(exec(run, ['--candidate', 'CR-1#1', '--expect-exit', '1'], script('process.exit(0)')).stdout)
  assert.equal(clean.outcome, 'not-reproduced')
  const missing = exec(run, ['--candidate', 'CR-1#1', '--expect-exit', '1'], ['definitely-not-a-command-for-evidence'])
  assert.equal(missing.status, 0, missing.stderr)
  assert.equal(JSON.parse(missing.stdout).outcome, 'env-failure')
  const slow = JSON.parse(exec(run, ['--candidate', 'CR-1#1', '--expect-exit', '1', '--timeout', '1'], script('setTimeout(() => {}, 20000)')).stdout)
  assert.equal(slow.outcome, 'env-failure')
  assert.match(slow.outcomeReason, /시간/)
})

test('작업 트리를 바꾼 재현은 기록하되 근거로 쓰지 않는다', t => {
  const run = started(t)
  const out = exec(run, ['--candidate', 'CR-1#1', '--expect-exit', '1'], script("require('fs').writeFileSync('made-by-repro.txt', 'x'); process.exit(1)"))
  assert.equal(out.status, 0, out.stderr)
  const result = JSON.parse(out.stdout)
  assert.equal(result.usable, false)
  assert.equal(result.reason, 'tree-mutated')
  assert.match(out.stderr, /작업 트리를 바꿨다/)
})

test('이 실행의 후보가 아니거나, 기대 종료 코드를 주지 않으면 돌리지 않는다', t => {
  const run = started(t)
  assert.equal(exec(run, ['--candidate', 'X-9#1', '--expect-exit', '1'], script('process.exit(1)')).status, 2)
  const noExpect = exec(run, ['--candidate', 'CR-1#1'], script('process.exit(1)'))
  assert.equal(noExpect.status, 2)
  assert.match(noExpect.stderr, /--expect-exit/)
  assert.equal(existsSync(join(run.timing, `${RUN}.evidence`)), false, '돌리지 않았으면 기록도 없다')
})

test('preflight 뒤에 작업 트리가 바뀌었으면 돌리지 않는다 — 다른 대상의 재현은 이 지적의 근거가 아니다', t => {
  const run = started(t)
  writeFileSync(join(run.repo, 'a.txt'), 'edited after preflight\n')
  const out = exec(run, ['--candidate', 'CR-1#1', '--expect-exit', '1'], script('process.exit(1)'))
  assert.equal(out.status, 2)
  assert.match(out.stderr, /대상이 바뀌었다/)
})

test('note는 실행 기록이 있는 executed와 정해진 항목의 static-trace·not-run만 받는다', t => {
  const run = started(t)
  const executed = JSON.parse(exec(run, ['--candidate', 'CR-1#1', '--expect-exit', '1'], script('process.exit(1)')).stdout)

  // 실행 기록 없이 executed — 거부하고 아무것도 쓰지 않는다
  const claimed = note(run, [{ candidateId: '04-3#1', method: 'executed', condition: 'c', expected: 'e' }])
  assert.equal(claimed.status, 2)
  assert.match(claimed.stderr, /executions/)
  assert.deepEqual(docOf(run).value.entries, [])

  // 다른 지적의 실행 기록을 빌려 붙여도 거부한다
  const borrowed = note(run, [{ candidateId: '04-3#1', method: 'executed', condition: 'c', expected: 'e', executions: [executed.id] }])
  assert.equal(borrowed.status, 2)
  assert.match(borrowed.stderr, /CR-1#1의 것/)

  const ok = note(run, [
    { candidateId: 'CR-1#1', method: 'executed', condition: '취소 뒤 응답 도착', procedure: 'node repro.js', expected: '상태가 그대로', observed: '상태가 덮였다', executions: [executed.id] },
    { candidateId: '04-3#1', method: 'not-run', reason: '재현할 테스트 환경이 없다' },
  ])
  assert.equal(ok.status, 0, ok.stderr)
  assert.deepEqual(docOf(run).value.entries.map(entry => [entry.candidateId, entry.method]), [['CR-1#1', 'executed'], ['04-3#1', 'not-run']])

  // 같은 지적을 다시 적으면 바꾼다
  assert.equal(note(run, [{ candidateId: '04-3#1', method: 'static-trace', condition: 'c', procedure: 'p', expected: 'e', observed: 'o' }]).status, 0)
  assert.deepEqual(docOf(run).value.entries.map(entry => [entry.candidateId, entry.method]), [['CR-1#1', 'executed'], ['04-3#1', 'static-trace']])
})

test('base 쪽 재현은 merge-base를 꺼낸 깨끗한 트리에서만 돌리고, 양쪽 결과로 기존 결함과 신규 회귀를 가른다', t => {
  const run = started(t)
  const baseTree = mkdtempSync(join(tmpdir(), 'evidence-base-'))
  t.after(() => rmSync(baseTree, { recursive: true, force: true }))
  git(baseTree, 'clone', '-q', run.repo, '.')
  git(baseTree, 'checkout', '-q', run.base)

  // HEAD 트리를 base라고 주면 거부한다
  const wrong = exec(run, ['--candidate', 'CR-1#1', '--expect-exit', '1', '--side', 'base', '--repo', run.repo], script('process.exit(1)'))
  assert.equal(wrong.status, 2)
  assert.match(wrong.stderr, /merge-base/)

  // 같은 재현 계획이다 — 명령은 같고, 결과는 트리의 내용(a.txt)에 따라 갈린다
  const probe = script("process.exit(require('fs').readFileSync('a.txt', 'utf8').includes('changed') ? 1 : 0)")
  const head = JSON.parse(exec(run, ['--candidate', 'CR-1#1', '--expect-exit', '1'], probe).stdout)
  const base = exec(run, ['--candidate', 'CR-1#1', '--expect-exit', '1', '--side', 'base', '--repo', baseTree], probe, baseTree)
  assert.equal(base.status, 0, base.stderr)
  const baseResult = JSON.parse(base.stdout)
  assert.equal(baseResult.usable, true)
  assert.equal(baseResult.outcome, 'not-reproduced')
  const written = note(run, [{ candidateId: 'CR-1#1', method: 'executed', condition: 'c', expected: 'e', executions: [head.id, baseResult.id] }])
  assert.equal(written.status, 0, written.stderr)
  assert.match(written.stdout, /CR-1#1 executed .*신규 회귀/)
})

// 실행마다 자기 파일을 새로 만들고 공용 파일을 고쳐 쓰지 않는다. 그래서 여러 재현을 동시에
// 돌려도 서로의 기록을 덮을 자리가 없다 — 이 테스트는 그 구조(실행마다 따로 생기는 파일)만
// 확인하고, 실제로 동시에 돌리지는 않는다.
test('실행 기록 디렉터리에는 실행마다 기록과 로그가 하나씩 따로 남는다', t => {
  const run = started(t)
  const ids = [1, 2, 3].map(() => JSON.parse(exec(run, ['--candidate', 'CR-1#1', '--expect-exit', '1'], script('process.exit(1)')).stdout).id)
  assert.equal(new Set(ids).size, 3)
  const files = readdirSync(join(run.timing, `${RUN}.evidence`)).sort()
  assert.equal(files.filter(file => file.endsWith('.json')).length, 3)
  assert.equal(files.filter(file => file.endsWith('.log')).length, 3)
})

// ── PR #92 리뷰 ────────────────────────────────────────────────────────

const baseCheckout = (t, run) => {
  const tree = mkdtempSync(join(tmpdir(), 'evidence-base-'))
  t.after(() => rmSync(tree, { recursive: true, force: true }))
  git(tree, 'clone', '-q', run.repo, '.')
  git(tree, 'checkout', '-q', run.base)
  return tree
}

test('재현 계획이 다른 HEAD·base 결과는 비교하지 않는다 — 신규 회귀로 확정하지 않는다', t => {
  const run = started(t)
  const tree = baseCheckout(t, run)
  const head = JSON.parse(exec(run, ['--candidate', 'CR-1#1', '--expect-exit', '1'], script('process.exit(1)')).stdout)
  const base = JSON.parse(exec(run, ['--candidate', 'CR-1#1', '--expect-exit', '1', '--side', 'base', '--repo', tree], script('process.exit(0)'), tree).stdout)
  assert.equal(base.usable, true)
  const written = note(run, [{ candidateId: 'CR-1#1', method: 'executed', condition: 'c', expected: 'e', executions: [head.id, base.id] }])
  assert.equal(written.status, 0, written.stderr)
  assert.match(written.stdout, /CR-1#1 executed reproduced · 변경 전 재현과 재현 계획이 달라 비교하지 않았다/)
  assert.doesNotMatch(written.stdout, /신규 회귀/)
})

test('재현을 바꿔 여러 번 돌렸으면 마지막 HEAD와 같은 계획의 base만 짝짓는다', t => {
  const run = started(t)
  const tree = baseCheckout(t, run)
  const probe = script("process.exit(require('fs').readFileSync('a.txt', 'utf8').includes('changed') ? 1 : 0)")
  const first = JSON.parse(exec(run, ['--candidate', 'CR-1#1', '--expect-exit', '1'], probe).stdout)
  const firstBase = JSON.parse(exec(run, ['--candidate', 'CR-1#1', '--expect-exit', '1', '--side', 'base', '--repo', tree], probe, tree).stdout)
  // 계획을 바꿨다 — 같은 명령이라도 기대 결과가 다르면 다른 계획이다
  const second = JSON.parse(exec(run, ['--candidate', 'CR-1#1', '--expect-exit', '1,2'], probe).stdout)
  const written = note(run, [{ candidateId: 'CR-1#1', method: 'executed', condition: 'c', expected: 'e', executions: [first.id, firstBase.id, second.id] }])
  assert.match(written.stdout, /비교하지 않았다/)
  const same = note(run, [{ candidateId: 'CR-1#1', method: 'executed', condition: 'c', expected: 'e', executions: [first.id, firstBase.id] }])
  assert.match(same.stdout, /신규 회귀/)
})

test('인자 배열은 공백·따옴표·괄호가 든 인자와 공백 있는 스크립트 경로를 그대로 넘긴다', t => {
  const run = started(t)
  // 대상 저장소 밖(리포트 디렉터리)에 둔다 — 작업 트리를 바꾸지 않는다
  mkdirSync(join(run.dir, 'probe dir'))
  const probe = join(run.dir, 'probe dir', 'echo args.cjs')
  writeFileSync(probe, 'console.log(JSON.stringify(process.argv.slice(2)))\n')
  const args = ['two words', 'say "hi"', 'f(x) && y']
  const out = exec(run, ['--candidate', 'CR-1#1', '--expect-exit', '0', '--expect-output', JSON.stringify(args)], [process.execPath, probe, ...args])
  assert.equal(out.status, 0, out.stderr)
  assert.equal(JSON.parse(out.stdout).outcome, 'reproduced')
})

test('--shell은 셸 명령 문자열 하나만 받는다 — 인자 배열을 이어 붙이지 않는다', t => {
  const run = started(t)
  const joined = exec(run, ['--candidate', 'CR-1#1', '--expect-exit', '0', '--shell'], [process.execPath, '-e', 'console.log(1)'])
  assert.equal(joined.status, 2)
  assert.match(joined.stderr, /--shell은 셸 명령 문자열 하나를 받는다/)
  const quoted = `"${process.execPath}" -e "console.log(process.argv.length)"`
  const ok = exec(run, ['--candidate', 'CR-1#1', '--expect-exit', '0', '--shell'], [quoted])
  assert.equal(ok.status, 0, ok.stderr)
  const record = JSON.parse(readFileSync(join(run.timing, `${RUN}.evidence`, `${JSON.parse(ok.stdout).id}.json`), 'utf8'))
  assert.deepEqual([record.shell, record.command, record.plan.mode], [true, [quoted], 'shell'])
})

test('다른 실행의 routed 출력이나 실행 ID가 없는 routed 출력으로는 재현도 근거도 받지 않는다', t => {
  const run = started(t)
  const other = join(run.dir, 'other.routed.json')
  writeFileSync(other, JSON.stringify({ candidates: [{ candidateId: 'CR-99#1', ruleId: 'CR-99' }], collected: { sources: [], excludedFailed: [], runId: 'other-run' } }))
  const foreign = exec(run, ['--candidate', 'CR-99#1', '--expect-exit', '1', '--routed', other], script('process.exit(1)'))
  assert.equal(foreign.status, 2)
  assert.match(foreign.stderr, /다른 실행\(other-run\)의 routed 출력이다/)
  assert.equal(existsSync(join(run.timing, `${RUN}.evidence.json`)), false, '거부한 뒤에는 근거 파일을 만들지 않는다')

  const bare = join(run.dir, 'bare.routed.json')
  writeFileSync(bare, JSON.stringify({ candidates: [{ candidateId: 'CR-1#1', ruleId: 'CR-1' }], collected: { sources: [] } }))
  const input = join(run.dir, 'entries.json')
  writeFileSync(input, JSON.stringify({ entries: [{ candidateId: 'CR-1#1', method: 'not-run', reason: 'r' }] }))
  const noted = node(run.repo, 'review-evidence.mjs', ['note', '--dir', run.dir, '--run', RUN, '--input', input, '--routed', bare])
  assert.equal(noted.status, 2)
  assert.match(noted.stderr, /실행 ID\(collected\.runId\)가 없다/)
})

test('검증 준비를 다시 돌려 후보 목록이 바뀌면 그 앞의 재현은 근거로 쓰지 않는다', t => {
  const run = started(t)
  const head = JSON.parse(exec(run, ['--candidate', 'CR-1#1', '--expect-exit', '1'], script('process.exit(1)')).stdout)
  // 같은 실행에서 다시 모았다 — 같은 ID가 다른 지적을 가리킬 수 있다
  const routedPath = join(run.timing, `${RUN}.routed.json`)
  writeFileSync(routedPath, JSON.stringify({ candidates: [{ candidateId: 'CR-1#1', ruleId: 'CR-1', content: { title: '다른 지적' } }], collected: { sources: [], excludedFailed: [], runId: run.runId } }))
  const written = note(run, [{ candidateId: 'CR-1#1', method: 'executed', condition: 'c', expected: 'e', executions: [head.id] }])
  assert.equal(written.status, 2)
  assert.match(written.stderr, /other-candidates/)
})
