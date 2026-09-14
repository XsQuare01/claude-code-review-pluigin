import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The unit tests import the module's functions, so they keep passing even when the CLI
// entry point references something that no longer exists. Running it is the only way to
// catch that, and the CLI is the surface an orchestrator actually uses.

const SCRIPT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'scripts', 'prepare-verification.mjs')
const RUN = 'code-review-full-feat-x-2026-09-08'

// 시작된 타임라인을 심는다. 이 스크립트는 렌더 전 필수 관문이라, `run.start`가
// 없으면 검증 준비를 거부한다 (C-9) — 그래서 CLI 테스트도 그 관문을 지나야 한다.
const started = t => {
  const dir = mkdtempSync(join(tmpdir(), 'prep-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, '.timing'), { recursive: true })
  writeFileSync(join(dir, '.timing', `${RUN}.jsonl`), `${JSON.stringify({
    at: '2026-09-08T00:00:00.000Z', seq: 1, phase: 'run.start',
    host: 'test', rules: 'review-rules', version: '2.11.0', branch: 'b', changedFiles: 1, candidates: 20,
  })}\n`, 'utf8')
  return dir
}

const run = (t, payload) => {
  const dir = started(t)
  const stdout = execFileSync('node', [SCRIPT, '--merge-base', 'HEAD', '--dir', dir, '--run', RUN], {
    input: JSON.stringify(payload), encoding: 'utf8',
  })
  return { result: JSON.parse(stdout), dir }
}

test('the CLI runs end to end on an empty candidate set', t => {
  const { result } = run(t, { candidates: [] })
  assert.equal(result.counts.total, 0)
})

test('the CLI accepts producer results and assigns candidate ids', t => {
  const { result } = run(t, {
    results: [
      {
        schemaVersion: 1,
        openQuestions: [],
        findings: [
          { ruleId: '01-1', title: 't', body: 'b', impact: 'low', confidence: 'high', location: { kind: 'verified', path: 'README.md', line: 1, quote: '# React Code Review Plugin' } },
        ],
      },
    ],
  })
  assert.equal(result.counts.total, 1)
  assert.equal(result.candidates[0].candidateId, '01-1#1')
  assert.equal(result.candidates[0].locationCheck, 'location-ok')
})

test('the CLI reports an unreadable path rather than crashing', t => {
  const { result } = run(t, { candidates: [{ candidateId: 'x#1', ruleId: 'x', impact: 'low', confidence: 'high', location: { kind: 'verified', path: 'does/not/exist.ts', line: 1, quote: 'q' } }] })
  assert.equal(result.candidates[0].locationCheck, 'location-unresolvable')
})

// ── 실행 타임라인 관문 (C-9) ───────────────────────────────────────────────
//
// 2026-09-08의 한 실행은 계약을 읽고도 타임라인을 한 줄도 남기지 않았고, 리포트는
// 그 사실을 말하지 않았다. 시작을 강제하는 것은 preflight의 몫이지만, 이 스크립트는
// 렌더 전 필수 관문이라 여기서 거부하면 타임라인 없이 검증까지 가는 경로가 닫힌다.

test('타임라인 인자 없이는 검증을 준비하지 않는다', () => {
  const out = spawnSync('node', [SCRIPT, '--merge-base', 'HEAD'], {
    input: JSON.stringify({ candidates: [] }), encoding: 'utf8',
  })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /--dir와 --run이 필요하다/)
  assert.match(out.stderr, /review-preflight\.mjs/)
})

test('run.start가 없는 사이드카는 거부하고 무엇을 먼저 할지 말한다', t => {
  const dir = mkdtempSync(join(tmpdir(), 'prep-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const out = spawnSync('node', [SCRIPT, '--merge-base', 'HEAD', '--dir', dir, '--run', RUN], {
    input: JSON.stringify({ candidates: [] }), encoding: 'utf8',
  })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /run\.start가 없다/)
  assert.match(out.stderr, /review-preflight\.mjs/)
})

test('--run에 경로 구분자가 오면 거부한다', t => {
  const dir = started(t)
  const out = spawnSync('node', [SCRIPT, '--merge-base', 'HEAD', '--dir', dir, '--run', '../escape'], {
    input: JSON.stringify({ candidates: [] }), encoding: 'utf8',
  })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /bare basename/)
})

test('준비 수치를 script.done으로 남기고 counts는 객체로 남는다', t => {
  // `--set`으로 넘기면 `total=5,verify=2,…`가 문자열 하나로 남아 다시 꺼낼 수
  // 없다. 실제로 그렇게 기록된 실행이 있어서, 이 스크립트가 직접 남긴다.
  const { dir } = run(t, { candidates: [] })
  const lines = readFileSync(join(dir, '.timing', `${RUN}.jsonl`), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  const done = lines.at(-1)
  assert.equal(done.phase, 'script.done')
  assert.equal(done.ran, true)
  assert.equal(typeof done.counts, 'object')
  assert.equal(done.counts.total, 0)
})

// --------------------------------------------------------------- 입력 전달
//
// 계약이 지시한 것은 `echo '{"results":[…]}' | node …` 한 줄이었다. 2026-09-11
// 실행은 그 파이프를 **두 번 연달아 실패**하고 세 번째에 Node `spawnSync`로 우회했다.
// 47개 finding은 한국어 산문·코드 인용·`C:\…` 역슬래시 경로를 담고 있어서, 그것을
// 셸 단일 인용부호 하나에 넣는 구조는 깨지는 쪽이 정상이다. 파일로 넘기면 셸이
// 볼 것이 경로 하나뿐이라 깨질 자리가 없다.

const timelineOf = (dir, run = RUN) => readFileSync(join(dir, '.timing', `${run}.jsonl`), 'utf8')
  .split('\n').filter(Boolean).map(line => JSON.parse(line))

test('--input은 파일에서 후보를 읽는다', t => {
  const dir = started(t)
  const input = join(dir, 'candidates.json')
  writeFileSync(input, JSON.stringify({
    results: [{
      schemaVersion: 1,
      openQuestions: [],
      findings: [
        { ruleId: '01-1', title: '제목', body: '본문', impact: 'low', confidence: 'high', location: { kind: 'verified', path: 'README.md', line: 1, quote: '# React Code Review Plugin' } },
      ],
    }],
  }), 'utf8')

  const out = spawnSync('node', [SCRIPT, '--merge-base', 'HEAD', '--dir', dir, '--run', RUN, '--input', input],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 0, out.stderr)
  const result = JSON.parse(out.stdout)
  assert.equal(result.counts.total, 1)
  assert.equal(result.candidates[0].candidateId, '01-1#1')
})

test('--input이 가리키는 파일이 없으면 무엇을 못 읽었는지 말한다', t => {
  const dir = started(t)
  const out = spawnSync('node', [SCRIPT, '--merge-base', 'HEAD', '--dir', dir, '--run', RUN, '--input', join(dir, 'nope.json')],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /nope\.json/)
})

test('JSON이 깨졌으면 어느 입력이 깨졌는지 말한다', t => {
  const dir = started(t)
  const input = join(dir, 'broken.json')
  writeFileSync(input, '{"results": [', 'utf8')
  const out = spawnSync('node', [SCRIPT, '--merge-base', 'HEAD', '--dir', dir, '--run', RUN, '--input', input],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /broken\.json/)
})

// ------------------------------------------------------------ script.start
//
// 2026-09-11 실행에서 `dispatch.end` → `script.done` 구간이 1086초로 전체 최장이었다.
// 그 안에 ① 19개 producer 출력을 하나의 JSON으로 조립 ② 실패한 파이프 두 번
// ③ 실제 스크립트 실행이 전부 들어 있고, 셋을 나눌 방법이 기록에 없었다.
// 다른 다단계 단계는 전부 start/end 쌍인데 script 단계만 done 하나였다.

test('스크립트가 자기 시작과 끝을 모두 남긴다', t => {
  const dir = started(t)
  execFileSync('node', [SCRIPT, '--merge-base', 'HEAD', '--dir', dir, '--run', RUN], {
    input: JSON.stringify({ candidates: [] }), encoding: 'utf8',
  })
  const phases = timelineOf(dir).map(event => event.phase)
  assert.deepEqual(phases, ['run.start', 'script.start', 'script.done'])
})

test('입력이 깨져 끝내지 못해도 시작한 사실은 남는다', t => {
  // script.start만 있고 script.done이 없는 기록은 "스크립트를 불렀고 끝내지
  // 못했다"는 뜻이다. 아무 줄도 없으면 부르지도 않은 것과 구분되지 않는다.
  const dir = started(t)
  const input = join(dir, 'broken.json')
  writeFileSync(input, 'not json', 'utf8')
  spawnSync('node', [SCRIPT, '--merge-base', 'HEAD', '--dir', dir, '--run', RUN, '--input', input],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const phases = timelineOf(dir).map(event => event.phase)
  assert.deepEqual(phases, ['run.start', 'script.start'])
})
