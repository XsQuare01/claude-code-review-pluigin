import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseSnapshot, renderSnapshotMarkdown } from '../scripts/lib/review-snapshot.mjs'

// `review-snapshot.mjs`를 실제 실행 순서대로 돌린다 — preflight가 남긴 `run.start` 위에
// 모듈 기록·routed·판정·producer 결과를 쌓고, 스냅숏을 쓰게 한다. 모델은 부르지 않는다.
// 이 테스트가 증명하는 것은 스크립트 사이의 배선이지, 리뷰가 무엇을 찾는지가 아니다.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PREFLIGHT = join(ROOT, 'scripts', 'review-preflight.mjs')
const SCRIPT = join(ROOT, 'scripts', 'review-snapshot.mjs')
const RULES = join(ROOT, 'review-rules')
const RUN = 'code-review-full-feat-x-2026-10-06'

const CATALOG = JSON.parse(readFileSync(join(RULES, 'catalog.json'), 'utf8'))
const ALL = [
  ...CATALOG.modules
    .filter(module => module.role === 'module' && module.workflows.includes('full') && module.phaseByWorkflow?.full !== 'post-verification-synthesis')
    .map(module => module.path.replace(/\.md$/, '')),
  'props', 'math', 'exception',
]

const candidate = extra => ({
  candidateId: '04-3#1', ruleId: '04-3', impact: 'high', confidence: 'high', category: 'data-loss',
  eligibility: 'VERIFY', route: 'bundle', source: '04-state',
  location: { kind: 'verified', path: 'a.txt', line: 1, quote: 'a' },
  locationCheck: 'location-ok',
  content: { title: '제목', body: '본문' },
  memberInstanceIds: ['i1'],
  ...extra,
})

/**
 * 대상 저장소와 리포트 디렉터리를 만들고 preflight로 실행을 시작한다.
 * 모듈은 전부 `ok`로 끝나고 결과 파일이 있다. `04-state`에 열린 질문이 하나 있다.
 */
const startedRun = (t, { candidates = [candidate()], verdicts = [{ candidateId: '04-3#1', disposition: 'upheld', reason: 'r' }] } = {}) => {
  const repo = mkdtempSync(join(tmpdir(), 'snapshot-repo-'))
  const dir = mkdtempSync(join(tmpdir(), 'snapshot-dir-'))
  t.after(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })
  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false',
    '-c', 'init.defaultBranch=main', ...args,
  ], { cwd: repo, stdio: 'ignore' })
  git('init', '-q')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  const started = spawnSync(process.execPath, [
    PREFLIGHT, '--dir', dir, '--run', RUN, '--rules', RULES, '--workflow', 'full',
    '--repo', repo, '--base', 'HEAD', '--host', 'test',
  ], { encoding: 'utf8' })
  assert.equal(started.status, 0, started.stderr)

  const timing = join(dir, '.timing')
  const sidecar = join(timing, `${RUN}.jsonl`)
  for (const name of ALL) {
    const openQuestions = name === '04-state'
      ? [{ title: '열린 질문', body: 'b', location: { kind: 'unverified', reason: 'r' }, reason: '범위 미확인' }]
      : []
    writeFileSync(join(timing, `${RUN}.${name}.json`), JSON.stringify({ schemaVersion: 1, findings: [], openQuestions }))
    fs.appendFileSync(sidecar, `${JSON.stringify({ at: new Date().toISOString(), phase: 'module.done', module: name, attempt: 1, status: 'ok' })}\n`)
  }
  writeFileSync(join(timing, `${RUN}.routed.json`), JSON.stringify({ candidates, collected: { sources: ALL, excludedFailed: [] } }))
  if (verdicts) writeFileSync(join(timing, `${RUN}.verdicts.json`), JSON.stringify({ verdicts }))
  return { repo, dir, timing }
}

const snapshot = (dir, repo, extra = []) => spawnSync(process.execPath, [
  SCRIPT, '--dir', dir, '--run', RUN, '--rules', RULES, '--repo', repo, ...extra,
], { encoding: 'utf8' })

const savedSnapshot = timing => parseSnapshot(readFileSync(join(timing, `${RUN}.snapshot.json`), 'utf8'))

test('스냅숏을 쓰고, 리포트 블록은 저장된 JSON에서 만든 것과 같다', t => {
  const { repo, dir, timing } = startedRun(t)
  const out = snapshot(dir, repo, ['--verification-state', 'ran'])
  assert.equal(out.status, 0, out.stderr)
  const saved = savedSnapshot(timing)
  assert.equal(saved.error, undefined, saved.error)
  assert.equal(saved.value.status, 'complete')
  assert.equal(saved.value.target.worktree, 'clean')
  assert.equal(saved.value.target.head, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim())
  assert.deepEqual(saved.value.drift, [])
  assert.equal(saved.value.findings[0].disposition, 'upheld')
  assert.equal(saved.value.openQuestions.length, 1)
  assert.deepEqual(saved.value.inputs.map(input => input.role).filter((role, at, all) => all.indexOf(role) === at), ['timeline', 'routed', 'verdicts', 'result'])
  // 리포트에 붙이는 블록은 저장된 파일로 다시 만들 수 있다
  assert.equal(out.stdout, `${renderSnapshotMarkdown(saved.value)}\n`)

  // 같은 실행을 다시 돌리면 같은 자리를 바꾼다
  const again = snapshot(dir, repo, ['--verification-state', 'ran'])
  assert.equal(again.status, 0, again.stderr)
})

test('preflight 뒤에 작업 트리가 바뀌면 스냅숏이 그 사실을 남긴다', t => {
  const { repo, dir, timing } = startedRun(t)
  writeFileSync(join(repo, 'a.txt'), 'edited after preflight\n')
  const out = snapshot(dir, repo, ['--verification-state', 'ran'])
  assert.equal(out.status, 0, out.stderr)
  const saved = savedSnapshot(timing).value
  assert.equal(saved.target.worktree, 'clean', '대상은 시작할 때 기록한 값이다')
  assert.deepEqual(saved.drift.map(entry => entry.field), ['worktree'])
  assert.match(out.stdout, /검토 도중 대상이 바뀌었다/)
})

test('검증 대상이 있는데 판정 파일이 없으면 멈춘다 — 검증 실패로 조용히 채우지 않는다', t => {
  const { repo, dir, timing } = startedRun(t, { verdicts: null })
  const out = snapshot(dir, repo, ['--verification-state', 'ran'])
  assert.equal(out.status, 2)
  assert.match(out.stderr, /판정 파일이 없다/)
  // 검증자가 하나도 결과를 내지 못했다는 것을 호출자가 말하면 그대로 남긴다
  const declared = snapshot(dir, repo, ['--verification-state', 'ran', '--no-verdicts'])
  assert.equal(declared.status, 0, declared.stderr)
  assert.equal(savedSnapshot(timing).value.findings[0].disposition, 'verification-unavailable')
})

test('검증 대상이 없으면 판정 파일이 없어도 된다', t => {
  const { repo, dir } = startedRun(t, { candidates: [candidate({ eligibility: 'SKIP-VERIFY', route: 'none' })], verdicts: null })
  assert.equal(snapshot(dir, repo, ['--verification-state', 'ran']).status, 0)
})

test('검증을 끈 실행에 판정 파일을 주면 거부한다', t => {
  const { repo, dir, timing } = startedRun(t)
  const out = snapshot(dir, repo, ['--verification-state', 'disabled', '--verdicts', join(timing, `${RUN}.verdicts.json`)])
  assert.equal(out.status, 2)
  assert.match(out.stderr, /disabled/)
  assert.equal(snapshot(dir, repo, ['--verification-state', 'disabled']).status, 0)
})

test('--verification-state가 없으면 추측하지 않고 멈춘다', t => {
  const { repo, dir } = startedRun(t)
  const out = snapshot(dir, repo)
  assert.equal(out.status, 2)
  assert.match(out.stderr, /--verification-state/)
})

test('routed 출력이나 수집한 결과 파일이 없으면 멈춘다', t => {
  const { repo, dir, timing } = startedRun(t)
  rmSync(join(timing, `${RUN}.props.json`))
  const missingResult = snapshot(dir, repo, ['--verification-state', 'ran'])
  assert.equal(missingResult.status, 2)
  assert.match(missingResult.stderr, /props/)
  rmSync(join(timing, `${RUN}.routed.json`))
  const missingRouted = snapshot(dir, repo, ['--verification-state', 'ran'])
  assert.equal(missingRouted.status, 2)
  assert.match(missingRouted.stderr, /routed/)
})

test('시작되지 않은 실행에는 스냅숏을 만들지 않는다', t => {
  const dir = mkdtempSync(join(tmpdir(), 'snapshot-empty-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const out = snapshot(dir, dir, ['--verification-state', 'ran'])
  assert.equal(out.status, 2)
  assert.match(out.stderr, /run\.start/)
})

test('--show는 저장된 스냅숏을 검사하고 같은 블록을 낸다. 잘린 파일은 거부한다', t => {
  const { repo, dir, timing } = startedRun(t)
  const written = snapshot(dir, repo, ['--verification-state', 'ran'])
  assert.equal(written.status, 0, written.stderr)
  const path = join(timing, `${RUN}.snapshot.json`)
  const shown = spawnSync(process.execPath, [SCRIPT, '--show', path], { encoding: 'utf8' })
  assert.equal(shown.status, 0, shown.stderr)
  assert.equal(shown.stdout, written.stdout)

  const text = readFileSync(path, 'utf8')
  writeFileSync(path, text.slice(0, Math.floor(text.length / 2)))
  const truncated = spawnSync(process.execPath, [SCRIPT, '--show', path], { encoding: 'utf8' })
  assert.equal(truncated.status, 1)
  assert.match(truncated.stderr, /JSON이 아니다/)
  assert.equal(truncated.stdout, '')
})

test('모르는 플래그와 남은 토큰은 거부한다', t => {
  const { repo, dir } = startedRun(t)
  assert.equal(snapshot(dir, repo, ['--verification-state', 'ran', '--bogus', 'x']).status, 2)
  assert.equal(snapshot(dir, repo, ['--verification-state', 'ran', 'stray']).status, 2)
})
