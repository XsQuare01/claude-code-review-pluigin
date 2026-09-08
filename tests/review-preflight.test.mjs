import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 리뷰가 시작되기 전에 시작됐다는 사실부터 남기는 관문을 고정한다.
//
// 왜 있는가: C-9는 첫 sub-agent보다 먼저 `run.start`를 남기라고 하지만 그것은
// 기억해야 하는 지시였다. 2026-09-08의 한 실행(357개 파일, 3시간 28분)은 계약
// 문서를 읽고도 타임라인을 한 줄도 남기지 않았다 — 컨텍스트 압축 때문이 아니라
// (첫 producer보다 55분 뒤에야 압축이 일어났다) 시작 단계에서 건너뛴 것이다.
// 그래서 기록을 모델이 출력을 필요로 하는 자리로 옮겼다.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(ROOT, 'scripts', 'review-preflight.mjs')
const RULES = join(ROOT, 'review-rules')
const RUN = 'code-review-full-feat-x-2026-09-08'

const freshDir = t => {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const preflight = (dir, extra = []) => spawnSync(process.execPath, [
  SCRIPT, '--dir', dir, '--run', RUN, '--rules', RULES, '--workflow', 'full',
  '--repo', ROOT, '--base', 'main', '--host', 'test', ...extra,
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const linesOf = dir => readFileSync(join(dir, '.timing', `${RUN}.jsonl`), 'utf8')
  .split('\n').filter(Boolean).map(line => JSON.parse(line))

test('후보 수를 catalog에서 세고, 후보가 아닌 모듈은 이유와 함께 낸다', t => {
  // 한 리포트가 후보를 20개가 아니라 21개로 적었다 — synthesis 전용 모듈을
  // 후보로 세면서. 세는 일을 스크립트로 옮기면 그 오류가 생길 자리가 없다.
  const out = preflight(freshDir(t))
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /후보 모듈 +20개/)
  assert.match(out.stdout, /후보 아님 +00 — 공통 컨텍스트 전용/)
  assert.match(out.stdout, /후보 아님 +10 — post-verification-synthesis/)
  assert.match(out.stdout, /특수 패스 +props math exception/)
})

test('run.start를 사이드카에 남긴다', t => {
  const dir = freshDir(t)
  assert.equal(preflight(dir).status, 0)
  const [first] = linesOf(dir)
  assert.equal(first.phase, 'run.start')
  assert.equal(first.candidates, 20)
  assert.equal(first.host, 'test')
  assert.equal(first.workflow, 'full')
  assert.equal(typeof first.changedFiles, 'number')
  assert.match(first.version, /^\d+\.\d+\.\d+$/)
  // 규칙 경로와 버전은 서로 다른 설치에서 올 수 있다(C-1의 홈 사본). 둘을 각각
  // 남겨야 그 어긋남이 사이드카에 보인다.
  assert.equal(first.rules, RULES)
})

test('--dry-run은 계산만 하고 쓰지 않는다', t => {
  const dir = freshDir(t)
  const out = preflight(dir, ['--dry-run'])
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /--dry-run, 쓰지 않았다/)
  assert.equal(existsSync(join(dir, '.timing', `${RUN}.jsonl`)), false)
})

test('이미 시작된 타임라인에 두 번째 시작을 얹지 않는다', t => {
  // 한 파일에 두 실행이 섞이면 어느 줄이 어느 실행인지 가릴 수 없다.
  const dir = freshDir(t)
  assert.equal(preflight(dir).status, 0)
  const again = preflight(dir)
  assert.equal(again.status, 2)
  assert.match(again.stderr, /이미 시작된 타임라인이다/)
  assert.equal(linesOf(dir).length, 1)
})

test('없는 규칙 경로는 거부한다', t => {
  const dir = freshDir(t)
  const out = spawnSync(process.execPath, [
    SCRIPT, '--dir', dir, '--run', RUN, '--rules', join(dir, 'nope'), '--workflow', 'full', '--repo', ROOT,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /--rules not found/)
})

test('해석되지 않는 base는 조용히 HEAD로 바꾸지 않는다', t => {
  // 범위가 조용히 달라지면 리뷰가 무엇을 봤는지 리포트만 보고 알 수 없다.
  const out = spawnSync(process.execPath, [
    SCRIPT, '--dir', freshDir(t), '--run', RUN, '--rules', RULES, '--workflow', 'full',
    '--repo', ROOT, '--base', 'no-such-ref-here',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /맞춰볼 수 없다/)
})

test('인용을 빠뜨려 남은 토큰은 거부한다', t => {
  const dir = freshDir(t)
  const out = spawnSync(process.execPath, [
    SCRIPT, '--dir', dir, '--run', RUN, '--rules', RULES, '--workflow', 'full', '--repo', ROOT, '--host', '검토', '완료',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /unexpected argument/)
})

test('catalog에 없는 워크플로우는 거부한다', t => {
  const out = spawnSync(process.execPath, [
    SCRIPT, '--dir', freshDir(t), '--run', RUN, '--rules', RULES, '--workflow', 'nope', '--repo', ROOT,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /catalog\.json에 없다/)
})

test('같은 플래그가 두 번 오면 거부한다', t => {
  // 값을 읽는 쪽은 첫 번째만 본다. 두 번째를 조용히 버리면 넘긴 값과 쓰인 값이
  // 다른데 아무도 모른다 — 실제로 이 테스트를 쓰다가 그 상태를 만들었다.
  const out = preflight(freshDir(t), ['--base', 'HEAD'])
  assert.equal(out.status, 2)
  assert.match(out.stderr, /두 번 왔다/)
})
