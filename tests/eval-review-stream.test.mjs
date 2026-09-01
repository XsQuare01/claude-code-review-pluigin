import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// runner를 **끝에서 끝까지** 돌린다 — 모델을 한 번도 부르지 않고.
//
// 이 저장소의 계측기 결함 아홉 개 중 여덟 개를 잡은 것은 단위 테스트가 아니라
// 실제 run이었다. 마지막 하나(타임아웃이면 봉투가 없어 진단이 불가능하다)는
// 40분과 그만큼의 사용량을 태운 뒤에야 보였다. 그리고 리뷰 실행은 그 뒤로
// 사용자 지시로 금지됐다 — evals/README.md의 "돌리지 않는다" 절.
//
// 그래서 claude 자리에 NDJSON만 흘리는 가짜를 놓고 spawn·스트림 캡처·kill·
// 판정까지의 배선을 통째로 지킨다. 순수 함수 테스트로는 절대 볼 수 없는 것들이
// 여기 있다: 죽인 프로세스가 실제로 죽는가, 스트림이 정말 디스크에 남는가,
// 결과 파일에 판정이 실리는가.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CASE = 'location-trap'

// 가짜 claude가 흘리는 스트림. producer 3개를 띄워 전부 회수하고, 리포트
// 쓰기를 시작한다. SCENARIO=hang이면 거기서 멈추고(타임아웃 경로),
// 아니면 봉투까지 내고 정상 종료한다.
const FAKE_CLAUDE = `const out = value => process.stdout.write(JSON.stringify(value) + '\\n')
const assistant = (...content) => ({ type: 'assistant', message: { role: 'assistant', content } })
const user = (...content) => ({ type: 'user', message: { role: 'user', content } })
const use = (id, name, input) => ({ type: 'tool_use', id, name, input })
const done = (id, text) => ({ type: 'tool_result', tool_use_id: id, content: text })

out({ type: 'system', subtype: 'init', session_id: 'fake' })
if (process.env.SCENARIO === 'api-error') {
  out({
    type: 'result', subtype: 'success', is_error: true, num_turns: 1,
    terminal_reason: 'api_error', result: 'API Error: Connection refused (ConnectionRefused)',
  })
  process.exitCode = 1
} else {
out(assistant(
  use('t1', 'Task', { description: '02' }),
  use('t2', 'Task', { description: '06' }),
  use('t3', 'Task', { description: '15' }),
))
out(user(done('t1', 'findings: 6')))
out(user(done('t2', 'findings: 9')))
out(user(done('t3', 'findings: 4')))
out(assistant(use('w1', 'Write', { file_path: 'review-reports/fake.md' })))

if (process.env.SCENARIO === 'hang') {
  setInterval(() => {}, 1000)
} else {
  out(user(done('w1', 'wrote 400 lines')))
  out({
    type: 'result', subtype: 'success', is_error: false,
    num_turns: 12, stop_reason: 'end_turn', total_cost_usd: 1.23, permission_denials: [],
    subagent_stats: { spawned: 3, failed: 0, killed: {}, refused: {} },
    result: '# fake report\\n',
  })
}
}
`

// PATH에 먼저 오도록 심는다. resolveClaude가 where/which로 찾는 첫 항목이
// 이것이 되고, 실제 claude가 깔린 머신에서도 그쪽으로 새지 않는다.
const plantFakeClaude = () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'))
  writeFileSync(join(dir, 'fake-claude.mjs'), FAKE_CLAUDE, 'utf8')
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'claude.cmd'), '@echo off\r\nnode "%~dp0fake-claude.mjs" %*\r\n', 'utf8')
  } else {
    const shim = join(dir, 'claude')
    // exec으로 자기 자신을 대체한다 — 그래야 harness가 아는 pid가 실제로
    // 일하는 프로세스이고, SIGKILL이 껍데기만 죽이지 않는다.
    writeFileSync(shim, '#!/bin/sh\nexec node "$(dirname "$0")/fake-claude.mjs" "$@"\n', 'utf8')
    chmodSync(shim, 0o755)
  }
  return dir
}

const resultPath = label => join(ROOT, 'evals', 'results', `${CASE}-${label}.json`)

const runHarness = ({ scenario, label, timeoutMinutes }) => {
  const binDir = plantFakeClaude()
  try {
    try {
      execFileSync(process.execPath, [
      join(ROOT, 'scripts', 'eval-review.mjs'),
      '--case', CASE, '--label', label, '--runs', '1',
      '--timeout-minutes', String(timeoutMinutes),
    ], {
      cwd: ROOT,
      env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH}`, SCENARIO: scenario },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // harness가 매달리면 여기서 시끄럽게 실패한다. 조용히 CI를 세우는 것보다
      // 낫다 — 실제로 kill 순서가 틀렸을 때 정확히 이 증상이었다.
      timeout: 90_000,
      killSignal: 'SIGKILL',
      })
    } catch (error) {
      // 실패 run을 포함한 배치는 의도적으로 non-zero다. 결과 파일이 생겼다면
      // harness의 판정을 검증하고, 파일조차 없으면 진짜 실행 결함을 다시 던진다.
      if (!existsSync(resultPath(label))) throw error
    }
  } finally {
    rmSync(binDir, { recursive: true, force: true })
  }
  return JSON.parse(readFileSync(resultPath(label), 'utf8'))
}

// 결과 파일·스트림·보관 리포트·fixture를 남기지 않는다. 자기 검증이 저장소와
// 임시 디렉터리에 찌꺼기를 쌓으면, 다음 사람이 그것을 실제 측정 결과로 읽는다.
const cleanUp = label => {
  const results = join(ROOT, 'evals', 'results')
  const path = resultPath(label)
  if (existsSync(path)) {
    for (const run of JSON.parse(readFileSync(path, 'utf8')).results ?? []) {
      if (run.fixtureRoot) rmSync(dirname(run.fixtureRoot), { recursive: true, force: true })
    }
  }
  rmSync(path, { force: true })
  for (const sub of ['streams', 'reports']) {
    const dir = join(results, sub)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (name.startsWith(`${CASE}-${label}`)) rmSync(join(dir, name), { force: true })
    }
  }
}

test('완주한 run은 스트림으로 바꿔도 잃는 것이 없다', t => {
  const label = 'selftest-done'
  t.after(() => cleanUp(label))
  const saved = runHarness({ scenario: 'done', label, timeoutMinutes: 1 })
  const run = saved.results[0]

  assert.equal(saved.streamMode, true)
  assert.equal(run.completed, true)
  // 봉투를 스트림의 마지막 result 이벤트에서 건졌다. 이 값이 null이면
  // stream-json의 모양이 예상과 다른 것이고, 그때는 아래 숫자들이 비는 것을
  // "실패가 없었다"로 읽으면 안 된다.
  assert.equal(run.envelopeSource, 'stream-result')
  assert.equal(run.numTurns, 12)
  assert.equal(run.totalCostUsd, 1.23)
  assert.deepEqual(run.opFailures, { spawned: 3, failed: 0, killed: 0, refused: 0, total: 0 })
  // 완주한 run에는 판정을 붙이지 않는다.
  assert.equal(run.stall, null)
})

test('타임아웃으로 죽은 run도 병목이 어디였는지 말한다', t => {
  // 2026-08-31에 못 했던 바로 그것. 그때는 completed=timeout과
  // reportFound=false만 있었고 opFailures·numTurns가 전부 비어 있어서,
  // case.json에 미리 등록해 둔 판별 규칙을 적용할 값이 없었다.
  const label = 'selftest-stall'
  t.after(() => cleanUp(label))
  const saved = runHarness({ scenario: 'hang', label, timeoutMinutes: 0.08 })
  const run = saved.results[0]

  assert.equal(run.completed, 'timeout')
  // 봉투는 여전히 없다 — 죽인 프로세스는 그것을 쓰지 못한다. 그 사실을
  // null로 정직하게 남기고, 진단은 다른 축이 든다.
  assert.equal(run.envelopeSource, null)
  assert.equal(run.progress.producersDone, true)
  assert.equal(run.progress.writesStarted, 1)
  assert.equal(run.progress.writesFinished, 0)
  assert.deepEqual(run.progress.pending, [{ name: 'Write', target: 'review-reports/fake.md' }])
  assert.equal(run.stall.verdict, 'render')
})

test('죽기 직전까지의 스트림이 디스크에 남는다', t => {
  // 메모리에만 있으면 harness 자신이 죽는 순간 함께 사라진다. 흘려 쓰는 것이
  // 요점이라, 파일이 실제로 있는지를 본다.
  const label = 'selftest-file'
  t.after(() => cleanUp(label))
  const saved = runHarness({ scenario: 'hang', label, timeoutMinutes: 0.08 })
  const run = saved.results[0]

  assert.ok(existsSync(run.streamPath), `스트림 파일이 없다: ${run.streamPath}`)
  const lines = readFileSync(run.streamPath, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 6)
  assert.equal(JSON.parse(lines[0]).type, 'system')
})

test('API 오류 문구를 리포트로 보관하지 않고 배치를 실패시킨다', t => {
  const label = 'selftest-api-error'
  t.after(() => cleanUp(label))
  const saved = runHarness({ scenario: 'api-error', label, timeoutMinutes: 1 })
  const run = saved.results[0]

  assert.equal(run.completed, 'failed')
  assert.equal(run.reportSource, null)
  assert.equal(run.keptReport, null)
  assert.equal(run.stall.verdict, 'not-started')
  assert.match(run.stall.why, /Connection refused/)
})
