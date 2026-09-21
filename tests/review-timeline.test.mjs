import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 리뷰가 스스로 남기는 실행 타임라인(C-9)을 고정한다.
//
// 왜 있는가: 2026-06부터 3개월간 "30분 걸리고 파일이 생성되지 않음"이 반복됐는데,
// 어느 단계에서 멈췄는지가 아무 데도 남지 않아 매번 처음부터 추측했다. 리포트
// 안에 타임라인을 적으면 렌더가 죽는 순간 함께 사라지므로, 사이드카에 한 줄씩
// append한다.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(ROOT, 'scripts', 'review-timeline.mjs')
const RUN = 'code-review-full-feat-x-2026-09-01'

const freshDir = t => {
  const dir = mkdtempSync(join(tmpdir(), 'timeline-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const log = (dir, phase, data) => spawnSync(process.execPath, [
  SCRIPT, '--dir', dir, '--run', RUN, '--phase', phase,
  ...(data ? ['--data', JSON.stringify(data)] : []),
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const summary = dir => spawnSync(process.execPath, [
  SCRIPT, '--dir', dir, '--run', RUN, '--summary',
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const linesOf = dir => readFileSync(join(dir, '.timing', `${RUN}.jsonl`), 'utf8')
  .split('\n').filter(Boolean).map(line => JSON.parse(line))

// 미리 만든 타임라인을 심는다. 경과 시간을 재려면 실제로 기다릴 수 없다.
const plant = (dir, events) => {
  mkdirSync(join(dir, '.timing'), { recursive: true })
  writeFileSync(join(dir, '.timing', `${RUN}.jsonl`), events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8')
}

test('단계마다 한 줄씩 append하고 순번을 매긴다', t => {
  const dir = freshDir(t)
  assert.equal(log(dir, 'run.start', { host: 'opencode' }).status, 0)
  assert.equal(log(dir, 'dispatch.start', { modules: 21 }).status, 0)
  assert.equal(log(dir, 'render.start', { findings: 47 }).status, 0)

  const events = linesOf(dir)
  assert.deepEqual(events.map(e => e.phase), ['run.start', 'dispatch.start', 'render.start'])
  assert.deepEqual(events.map(e => e.seq), [1, 2, 3])
  assert.equal(events[0].host, 'opencode')
  assert.equal(events[2].findings, 47)
})

test('시각과 경과는 스크립트가 만든다 — 호출자가 넘긴 값은 버린다', t => {
  // 모델에게는 시계가 없다. 타임스탬프를 문장으로 적게 하면 그것은 측정이
  // 아니라 기억이고, 측정값과 주장값이 같은 자리에 있으면 나중에 읽는 사람이
  // 둘을 구분할 방법이 없다.
  const dir = freshDir(t)
  log(dir, 'run.start')
  assert.equal(log(dir, 'render.start', { at: '거짓말', seq: 999, sinceStartSec: 99999, phase: 'render.end', findings: 3 }).status, 0)

  const last = linesOf(dir).at(-1)
  assert.equal(last.phase, 'render.start')
  assert.equal(last.seq, 2)
  assert.notEqual(last.at, '거짓말')
  assert.ok(Number.isFinite(Date.parse(last.at)))
  assert.ok(last.sinceStartSec < 60)
  // 측정값이 아닌 것은 그대로 남는다.
  assert.equal(last.findings, 3)
})

test('경과 시간을 첫 줄 기준으로 센다', t => {
  const dir = freshDir(t)
  const base = new Date('2026-09-01T00:00:00.000Z')
  plant(dir, [{ at: base.toISOString(), seq: 1, sinceStartSec: 0, phase: 'run.start' }])
  log(dir, 'render.start')
  const last = linesOf(dir).at(-1)
  // 지금과 2026-09-01 사이만큼 벌어져야 한다 — 0이면 첫 줄을 안 읽은 것이다.
  assert.ok(last.sinceStartSec > 1000, `sinceStartSec=${last.sinceStartSec}`)
})

// ── --summary ──────────────────────────────────────────────────────────────

test('요약 표를 스크립트가 만든다', t => {
  const dir = freshDir(t)
  const base = Date.parse('2026-09-01T00:00:00.000Z')
  plant(dir, [
    { at: new Date(base).toISOString(), seq: 1, sinceStartSec: 0, phase: 'run.start' },
    { at: new Date(base + 60_000).toISOString(), seq: 2, sinceStartSec: 60, phase: 'dispatch.end', ok: 19 },
    { at: new Date(base + 1_860_000).toISOString(), seq: 3, sinceStartSec: 1860, phase: 'render.start', findings: 47 },
  ])
  const out = summary(dir)
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /\| 단계 \| 경과 \| 구간 \| 상세 \|/)
  assert.match(out.stdout, /`render.start`/)
  // 30분짜리 구간이 최장으로 표시된다 — 어디가 느렸는지를 눈으로 찾게 하지 않는다.
  assert.match(out.stdout, /`render\.start` \*\*←최장\*\* \| 1860s \| 1800s/)
})

test('run.end가 없으면 그 사실을 적는다', t => {
  // 마지막 단계가 성공했다는 뜻이 아니다. 없는 것과 0은 다르다.
  //
  // 끊긴 자리로 `render.start`를 쓰지 않는다 — 거기는 C-7이 이 표를 만들라고
  // 지정한 자리라서 종료 줄이 없는 것이 정상이고, 그 구분은 아래 렌더 시점
  // 요약 테스트가 따로 고정한다.
  const dir = freshDir(t)
  log(dir, 'run.start')
  log(dir, 'synthesis.end', { clusters: 9 })
  const out = summary(dir)
  assert.match(out.stdout, /`run\.end`가 없다/)
  assert.match(out.stdout, /마지막으로 남은 단계는 `synthesis\.end`/)
})

test('run.end가 있으면 없다고 하지 않는다', t => {
  const dir = freshDir(t)
  log(dir, 'run.start')
  log(dir, 'run.end', { verdict: 'PASS' })
  assert.doesNotMatch(summary(dir).stdout, /없다/)
})

test('깨진 줄은 세되 조용히 버리지 않는다', t => {
  const dir = freshDir(t)
  mkdirSync(join(dir, '.timing'), { recursive: true })
  writeFileSync(join(dir, '.timing', `${RUN}.jsonl`),
    `{"at":"2026-09-01T00:00:00.000Z","seq":1,"phase":"run.start"}\n{"at":"쓰다 만\n`, 'utf8')
  const out = summary(dir)
  assert.match(out.stdout, /읽지 못한 줄 1개/)
})

test('타임라인이 없으면 빈 표를 내지 않고 사유를 낸다', t => {
  const dir = freshDir(t)
  const out = summary(dir)
  assert.equal(out.status, 2)
  assert.match(out.stderr, /타임라인이 비었다/)
})

// ── 셸을 통과하지 않는 값 전달 ─────────────────────────────────────────────
//
// `--data`만 있던 때 실제 실행에서 두 번 연속 깨졌다. Windows 경로의 백슬래시와
// 한글이 섞인 JSON이 PowerShell 명령줄을 지나면서 따옴표가 사라졌고, 기록을
// 남기라고 만든 도구가 기록을 못 남겼다. 그 사이 다음 단계가 먼저 기록돼
// 이벤트 순서까지 뒤집혔다.

test('--set은 따옴표 없이 값을 싣는다', t => {
  const dir = freshDir(t)
  const out = spawnSync(process.execPath, [
    SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'run.end',
    '--set', 'lines=694', '--set', 'verdict=MERGE_BLOCKED',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  assert.equal(out.status, 0, out.stderr)
  const last = linesOf(dir).at(-1)
  assert.equal(last.lines, 694)
  assert.equal(last.verdict, 'MERGE_BLOCKED')
})

test('--set의 숫자와 참거짓은 문자열로 남지 않는다', t => {
  // "694"와 694가 섞이면 나중에 세는 쪽이 형을 맞추느라 또 틀린다.
  const dir = freshDir(t)
  spawnSync(process.execPath, [
    SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'synthesis.start',
    '--set', 'n=41', '--set', 'ok=true', '--set', 'missing=null', '--set', 'name=17-3',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  const last = linesOf(dir).at(-1)
  assert.strictEqual(last.n, 41)
  assert.strictEqual(last.ok, true)
  assert.strictEqual(last.missing, null)
  // 규칙 ID처럼 숫자로 안 읽히는 값은 문자열 그대로여야 한다.
  assert.strictEqual(last.name, '17-3')
})

test('--set은 등호 없는 값을 거부한다', t => {
  const dir = freshDir(t)
  const out = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'synthesis.start', '--set', 'lines694'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /--set must be key=value/)
})

test('--data-file은 중첩 값을 싣는다', t => {
  // failureClasses처럼 중첩이 필요한 값은 --set으로 못 쓴다.
  const dir = freshDir(t)
  const payload = join(dir, 'payload.json')
  writeFileSync(payload, JSON.stringify({ failureClasses: { 'task-not-found': 5 }, ok: 18 }), 'utf8')

  spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'dispatch.end', '--data-file', payload],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  const last = linesOf(dir).at(-1)
  assert.deepEqual(last.failureClasses, { 'task-not-found': 5 })
  assert.equal(last.ok, 18)
})

test('--data-file이 없으면 조용히 빈 값으로 기록하지 않는다', t => {
  const dir = freshDir(t)
  const out = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'synthesis.start', '--data-file', join(dir, 'nope.json')],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /--data-file not found/)
})

test('셋을 함께 주면 --set이 마지막으로 이긴다', t => {
  // 급히 한 값만 바꿔 다시 돌리는 쪽이 파일을 고치는 쪽보다 흔하다.
  const dir = freshDir(t)
  const payload = join(dir, 'payload.json')
  writeFileSync(payload, JSON.stringify({ lines: 2, from: 'file' }), 'utf8')

  spawnSync(process.execPath, [
    SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'synthesis.start',
    '--data', '{"lines":1,"from":"data"}', '--data-file', payload, '--set', 'lines=3',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  const last = linesOf(dir).at(-1)
  assert.equal(last.lines, 3)
  assert.equal(last.from, 'file')
})

test('--set으로도 측정값은 덮어쓸 수 없다', t => {
  const dir = freshDir(t)
  spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'render.start', '--set', 'phase=거짓', '--set', 'seq=99'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const last = linesOf(dir).at(-1)
  assert.equal(last.phase, 'render.start')
  assert.equal(last.seq, 1)
})

// ── 총량을 어디서 읽는가 ───────────────────────────────────────────────────

test('run.end가 두 번이면 나중 것을 총량으로 쓴다', t => {
  // 계약은 기록이 밀렸을 때 run.end를 다시 적도록 허용한다. 앞의 것을 집으면
  // 오래된 값이 전체 총량으로 나간다.
  const dir = freshDir(t)
  log(dir, 'run.end', { tokensIn: 10, tokensOut: 1 })
  log(dir, 'render.wrote', {})
  log(dir, 'run.end', { tokensIn: 20, tokensOut: 2 })

  const out = summary(dir).stdout
  assert.match(out, /입력 20/)
  assert.doesNotMatch(out, /입력 10/)
})

test('run.end가 마지막이 아니면 총량을 최종으로 내세우지 않는다', t => {
  const dir = freshDir(t)
  log(dir, 'run.end', { tokensIn: 10, tokensOut: 1 })
  log(dir, 'render.wrote', {})

  assert.match(summary(dir).stdout, /이 총량은 최종이 아닐 수 있다/)
})

test('측정된 0을 미측정과 구분한다', t => {
  // truthy로 거르면 실제로 0을 쓴 실행이 재지 못한 실행과 같은 모습이 된다.
  const dir = freshDir(t)
  log(dir, 'run.end', { tokensIn: 0, tokensOut: 0, usageSource: 'envelope' })

  const out = summary(dir).stdout
  assert.match(out, /입력 0 · 출력 0/)
  assert.doesNotMatch(out, /재지 못했다/)
})

test('한쪽만 측정된 값을 0으로 채우지 않는다', t => {
  const dir = freshDir(t)
  log(dir, 'run.end', { tokensIn: 500 })

  assert.match(summary(dir).stdout, /입력 500 · 출력 미측정/)
})

test('음수나 소수 토큰은 값으로 보지 않는다', t => {
  const dir = freshDir(t)
  log(dir, 'module.done', { tokensIn: -5, tokensOut: 1.5 })
  log(dir, 'run.end', {})

  assert.doesNotMatch(summary(dir).stdout, /토큰/)
})

// ── 부분 합계를 전체로 내세우지 않는다 ─────────────────────────────────────

test('일부 단계만 보고하면 부분 합계라고 부른다', t => {
  // 덜 보고한 실행이 더 싸 보이면, 그 값으로 무엇을 덜어낼지 정할 수 없다.
  const dir = freshDir(t)
  log(dir, 'module.done', { module: '03-react-rules', tokensIn: 100, tokensOut: 10 })
  log(dir, 'module.done', { module: '20-deletion-regression' })
  log(dir, 'run.end', {})

  const out = summary(dir).stdout
  assert.match(out, /토큰\(부분 합계\)/)
  assert.match(out, /전체 총량이 아니다/)
  assert.match(out, /1개 단계만/)
  assert.match(out, /비교하지 않는다/)
})

test('모듈 밖의 단계도 사용량을 낸다', t => {
  // 교차검증이 값을 하는지 물으려면 그 단계의 몫이 따로 있어야 한다.
  const dir = freshDir(t)
  log(dir, 'crossverify.end', { upheld: 1, tokensIn: 700, tokensOut: 40 })
  log(dir, 'synthesis.end', { clusters: 1, tokensIn: 200, tokensOut: 20 })
  log(dir, 'run.end', {})

  assert.match(summary(dir).stdout, /토큰\(부분 합계\)\*\* 입력 900 · 출력 60/)
})

test('총량이 있으면 단계 합계와 귀속되지 않은 몫을 함께 낸다', t => {
  // 차이가 크면 단계별 값만 보고 판단하면 안 된다는 뜻이다.
  const dir = freshDir(t)
  log(dir, 'crossverify.end', { tokensIn: 700, tokensOut: 40 })
  log(dir, 'run.end', { tokensIn: 1000, tokensOut: 60, usageSource: 'envelope' })

  const out = summary(dir).stdout
  assert.match(out, /입력 1,000/)
  assert.match(out, /단계별 입력 합계 700/)
  assert.match(out, /귀속되지 않은 300/)
})

// ── 두 실행이 한 파일에 섞이지 않는다 ──────────────────────────────────────

test('끝난 타임라인에 새 실행을 이어붙이지 않는다', t => {
  // 파일 이름이 날짜까지만 담으므로, 같은 날 같은 브랜치를 두 번 리뷰하면
  // 두 실행이 한 파일에 섞인다. 반복 측정이 필요한 용도에서 가장 먼저 깨진다.
  const dir = freshDir(t)
  log(dir, 'run.start')
  log(dir, 'run.end')

  const again = log(dir, 'run.start')
  assert.equal(again.status, 2)
  assert.match(again.stderr, /이미 끝난 타임라인이다/)
  assert.equal(linesOf(dir).length, 2)
})

test('끝나지 않은 타임라인에는 이어 쓴다', t => {
  const dir = freshDir(t)
  log(dir, 'run.start')
  log(dir, 'module.done', {})
  assert.equal(log(dir, 'render.wrote', {}).status, 0)
})

// ── 타입이 섞인 필드 ───────────────────────────────────────────────────────
//
// `--set`은 원문으로 되돌아오는 값만 숫자로 둔다. 그래서 `module=01`은 문자열,
// `module=11`은 숫자가 된다 — 실제 실행이 01~09를 문자열로, 11~20을 숫자로
// 기록했다. 계약은 번호가 아니라 이름을 적으라고 하지만 지시는 지켜지지 않을 수
// 있어서, 섞인 결과를 요약에서 보이게 한다.

test('같은 필드가 줄마다 다른 타입이면 짚는다', t => {
  const dir = freshDir(t)
  log(dir, 'module.start', { module: '01' })
  log(dir, 'module.start', { module: 11 })
  log(dir, 'run.end', {})

  const out = summary(dir).stdout
  assert.match(out, /타입이 섞인 필드가 있다/)
  assert.match(out, /\`module\`\(string\/number\)/)
})

test('타입이 일관되면 짚지 않는다', t => {
  const dir = freshDir(t)
  log(dir, 'module.start', { module: '01-fsd' })
  log(dir, 'module.start', { module: '11-styling' })
  log(dir, 'run.end', {})

  assert.doesNotMatch(summary(dir).stdout, /타입이 섞인/)
})

test('null은 타입 판정에서 빼고 센다', t => {
  // 값이 없는 것은 다른 형이 아니다. 그것까지 섞였다고 하면 경고가 흔해져
  // 진짜 섞임이 묻힌다.
  const dir = freshDir(t)
  log(dir, 'module.done', { findings: 3 })
  log(dir, 'module.done', { findings: null })
  log(dir, 'run.end', {})

  assert.doesNotMatch(summary(dir).stdout, /타입이 섞인/)
})

test('섞인 필드를 여러 개면 여러 개 다 짚는다', t => {
  const dir = freshDir(t)
  log(dir, 'synthesis.start', { module: '01', clusters: 'pending' })
  log(dir, 'synthesis.end', { module: 11, clusters: 1 })
  log(dir, 'run.end', {})

  const out = summary(dir).stdout
  assert.match(out, /\`module\`/)
  assert.match(out, /\`clusters\`/)
})

// ── 사용량 ─────────────────────────────────────────────────────────────────
//
// 시간은 남는데 무엇을 얼마나 썼는지가 남지 않았다. "이 패스가 값을 하는가"를
// 시간이라는 대리 지표로만 판단해야 했다. 표 상세 칸에만 두면 긴 JSON 사이에
// 묻히므로 따로 한 줄로 낸다.

test('run.end의 총량을 표 아래 한 줄로 낸다', t => {
  const dir = freshDir(t)
  log(dir, 'run.start')
  log(dir, 'run.end', { tokensIn: 1840000, tokensOut: 96000, tokensCacheRead: 1520000, usageSource: 'envelope' })

  const out = summary(dir).stdout
  assert.match(out, /\*\*토큰\*\* 입력 1,840,000/)
  assert.match(out, /출력 96,000/)
  assert.match(out, /캐시 읽기 1,520,000/)
  assert.match(out, /출처: envelope/)
})

test('총량이 없으면 모듈별 값을 합산한다', t => {
  const dir = freshDir(t)
  log(dir, 'module.done', { tokensIn: 100, tokensOut: 10 })
  log(dir, 'module.done', { tokensIn: 250, tokensOut: 30 })
  log(dir, 'run.end', {})

  const out = summary(dir).stdout
  assert.match(out, /입력 350/)
  assert.match(out, /출력 40/)
})

test('재지 못한 것과 0을 구분한다', t => {
  // 필드를 통째로 빼면 "0이었다"와 "재지 못했다"가 같은 모습이 된다.
  const dir = freshDir(t)
  log(dir, 'run.end', { usageSource: 'unavailable' })

  const out = summary(dir).stdout
  assert.match(out, /사용량을 재지 못했다/)
  assert.doesNotMatch(out, /\*\*토큰\*\*/)
})

test('사용량이 없으면 토큰 줄을 만들지 않는다', t => {
  const dir = freshDir(t)
  log(dir, 'run.start')
  log(dir, 'run.end', { verdict: 'PASS' })

  const out = summary(dir).stdout
  assert.doesNotMatch(out, /\*\*토큰\*\*/)
  assert.doesNotMatch(out, /재지 못했다/)
})

test('금액은 정가 환산이라고 적는다', t => {
  // 구독 실행에서 이 값은 청구액이 아니다. "비용"으로 읽히면 안 된다.
  const dir = freshDir(t)
  log(dir, 'run.end', { tokensIn: 100, tokensOut: 10, costUsd: 12.4, usageSource: 'envelope' })

  assert.match(summary(dir).stdout, /정가 환산 \$12\.4/)
})

// ── PowerShell이 만든 파일을 읽는다 ────────────────────────────────────────
//
// 이 경로는 PowerShell의 JSON 인용 문제를 피하려고 만든 것이다. 그런데 정작
// PowerShell 5.1이 만드는 파일을 못 읽었다 — `Set-Content -Encoding UTF8`은 BOM을
// 붙이고 기본 `Out-File`은 UTF-16LE로 쓴다. 우회로가 우회하려던 것에 걸렸다.

const writeBytes = (path, ...chunks) => writeFileSync(path, Buffer.concat(chunks))

test('UTF-8 BOM이 붙은 --data-file을 읽는다', t => {
  const dir = freshDir(t)
  const payload = join(dir, 'bom8.json')
  writeBytes(payload, Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ note: '한글' }), 'utf8'))

  const out = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'synthesis.start', '--data-file', payload],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 0, out.stderr)
  assert.equal(linesOf(dir).at(-1).note, '한글')
})

test('UTF-16LE로 쓴 --data-file을 읽는다', t => {
  const dir = freshDir(t)
  const payload = join(dir, 'bom16.json')
  writeBytes(payload, Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify({ note: '한글' }), 'utf16le'))

  const out = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'synthesis.start', '--data-file', payload],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 0, out.stderr)
  assert.equal(linesOf(dir).at(-1).note, '한글')
})

test('UTF-16BE로 쓴 --data-file을 읽는다', t => {
  const dir = freshDir(t)
  const payload = join(dir, 'bom16be.json')
  const body = Buffer.from(JSON.stringify({ note: '한글' }), 'utf16le')
  body.swap16()
  writeBytes(payload, Buffer.from([0xfe, 0xff]), body)

  const out = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'synthesis.start', '--data-file', payload],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 0, out.stderr)
  assert.equal(linesOf(dir).at(-1).note, '한글')
})

// ── 식별자를 숫자로 바꾸지 않는다 ──────────────────────────────────────────

test('앞에 0이 붙은 값은 문자열로 남는다', t => {
  // 모듈 번호와 task ID는 세는 값이 아니라 가리키는 값이다. 앞의 0이 사라지면
  // 무엇을 가리키는지가 사라진다.
  const dir = freshDir(t)
  spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'module.start',
    '--set', 'module=01', '--set', 'taskId=001'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  const last = linesOf(dir).at(-1)
  assert.strictEqual(last.module, '01')
  assert.strictEqual(last.taskId, '001')
})

test('원문과 다르게 되돌아오는 값은 숫자로 바꾸지 않는다', t => {
  const dir = freshDir(t)
  spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'synthesis.start',
    '--set', 'a=1e3', '--set', 'b=0x10', '--set', 'c=+5', '--set', 'd=1.50'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  const last = linesOf(dir).at(-1)
  for (const [key, expected] of [['a', '1e3'], ['b', '0x10'], ['c', '+5'], ['d', '1.50']]) {
    assert.strictEqual(last[key], expected, key)
  }
})

test('세는 값은 여전히 숫자다', t => {
  const dir = freshDir(t)
  spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'synthesis.start',
    '--set', 'lines=694', '--set', 'ratio=1.5', '--set', 'zero=0'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  const last = linesOf(dir).at(-1)
  assert.strictEqual(last.lines, 694)
  assert.strictEqual(last.ratio, 1.5)
  assert.strictEqual(last.zero, 0)
})

// ── 잘린 인자를 조용히 넘기지 않는다 ───────────────────────────────────────

test('공백으로 쪼개진 인자를 거부한다', t => {
  // PowerShell에서 --set note=검토 완료 는 세 토큰이 된다. 남은 토큰을 무시하면
  // 잘린 값이 기록되고 아무도 모른다.
  const dir = freshDir(t)
  const out = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'synthesis.start', '--set', 'note=검토', '완료'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /unexpected argument/)
  assert.match(out.stderr, /따옴표/)
  assert.ok(!existsSync(join(dir, '.timing')))
})

test('모르는 플래그를 무시하지 않는다', t => {
  const dir = freshDir(t)
  const out = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'synthesis.start', '--sset', 'a=1'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /unknown flag --sset/)
})

// ── 종료 줄은 마지막 자리에 있어야 한다 ────────────────────────────────────

test('run.end 뒤에 줄이 더 있으면 정상 종료로 보지 않는다', t => {
  // 기록 실패로 순서가 밀리면 실제로 이런 타임라인이 만들어진다.
  const dir = freshDir(t)
  log(dir, 'run.start')
  log(dir, 'run.end')
  log(dir, 'module.done')

  const out = summary(dir)
  assert.match(out.stdout, /\`run\.end\` 뒤에 줄이 더 있다/)
  assert.match(out.stdout, /마지막 줄은 \`module\.done\`/)
})

// ── 인자 검증 ──────────────────────────────────────────────────────────────

test('run에 경로 구분자가 들어오면 거부한다', t => {
  // 통과시키면 파일이 리포트 디렉터리 밖에 생긴다.
  const dir = freshDir(t)
  const out = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', '../escape', '--phase', 'run.start'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /bare basename/)
  assert.ok(!existsSync(join(dir, '.timing')))
})

test('data가 JSON이 아니거나 객체가 아니면 거부한다', t => {
  const dir = freshDir(t)
  const bad = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'synthesis.start', '--data', 'findings=3'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /must be JSON/)

  const array = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'synthesis.start', '--data', '[1,2]'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(array.status, 2)
  assert.match(array.stderr, /JSON object/)
})

test('phase 없이 부르면 조용히 빈 줄을 쓰지 않는다', t => {
  const dir = freshDir(t)
  const out = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /--phase is required/)
})

// ── 닫힌 단계 목록과 payload 계약 ─────────────────────────────────────────
//
// 한 실행이 `verification.prepared`·`final.audit`·`report.saved`를 자체로 지어
// 쓰고 `render.start`·`render.wrote`를 남기지 않았다. 완주해서 드러나지 않았지만
// 문서를 쓰다 죽었다면 마지막 줄이 `synthesis.end`로 남아 "synthesis에서 멈췄다"로
// 오독됐을 것이다. 그래서 이름을 스크립트가 검사한다.

const check = dir => spawnSync(process.execPath, [
  SCRIPT, '--dir', dir, '--run', RUN, '--check',
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

test('표에 없는 단계 이름은 거부한다', t => {
  const dir = freshDir(t)
  const out = log(dir, 'final.audit', { status: 'verification-unavailable' })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /닫힌 목록에 없다/)
  assert.match(out.stderr, /run\.start/)
  assert.equal(existsSync(join(dir, '.timing', `${RUN}.jsonl`)), false)
})

test('중첩이어야 하는 값을 --set으로 밀어 넣으면 거부한다', t => {
  // `--set`은 첫 =에서만 자른다. `counts=total=5,verify=2`는 값 전체가 문자열
  // 하나로 남아 다섯 수치를 다시 꺼낼 수 없다 — 실제로 그렇게 기록된 실행이 있다.
  const dir = freshDir(t)
  const out = spawnSync(process.execPath, [
    SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'script.done',
    '--set', 'ran=true', '--set', 'counts=total=5,verify=2,skipVerify=3',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /--data-file/)
})

test('중첩 값을 --data-file로 넘기면 통과한다', t => {
  const dir = freshDir(t)
  const payload = join(dir, 'counts.json')
  writeFileSync(payload, JSON.stringify({ ran: true, counts: { total: 5, verify: 2 } }), 'utf8')
  const out = spawnSync(process.execPath, [
    SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'script.done', '--data-file', payload,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 0, out.stderr)
  assert.equal(linesOf(dir).at(-1).counts.verify, 2)
})

test('필수 필드가 빠지면 경고하되 줄은 남긴다', t => {
  // 줄을 거부하면 그 단계의 기록이 통째로 사라진다. 필드 하나 빠진 기록이
  // 없는 기록보다 낫고, 빠진 사실은 --check가 종료 전에 다시 짚는다.
  const dir = freshDir(t)
  const out = log(dir, 'run.start', { host: 'win32', version: '2.11.0' })
  assert.equal(out.status, 0)
  assert.match(out.stderr, /rules/)
  assert.equal(linesOf(dir).length, 1)
})

test('--check는 run.end가 마지막이면 통과한다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-08T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'win32', rules: 'r', version: '2.11.0', branch: 'b', changedFiles: 9 },
    { at: '2026-09-08T00:10:00.000Z', seq: 2, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.equal(out.status, 0, out.stdout)
  assert.match(out.stdout, /^OK/)
})

test('--check는 run.end가 없으면 실패한다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-08T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'win32', rules: 'r', version: '2.11.0', branch: 'b', changedFiles: 9 },
    { at: '2026-09-08T00:10:00.000Z', seq: 2, phase: 'synthesis.end', clusters: 1 },
  ])
  const out = check(dir)
  assert.equal(out.status, 1)
  assert.match(out.stdout, /run\.end`가 없다/)
})

test('--check는 첫 줄이 run.start가 아니면 짚는다', t => {
  // 첫 줄이 run.start가 아니면 어느 버전·어느 규칙으로 돌았는지가 기록에 없다.
  // 실제로 그런 사이드카가 남아, 죽은 실행의 규칙 버전을 끝내 알 수 없었다.
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-08T00:00:00.000Z', seq: 1, phase: 'module.done', module: '01-fsd', attempt: 1, status: 'ok', failureClass: 'none' },
    { at: '2026-09-08T00:10:00.000Z', seq: 2, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.equal(out.status, 1)
  assert.match(out.stdout, /run\.start`가 아니라/)
})

test('--check는 표에 없는 이름과 빠진 필수 필드를 짚는다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-08T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'win32', rules: 'r', version: '2.11.0', branch: 'b', changedFiles: 9 },
    { at: '2026-09-08T00:05:00.000Z', seq: 2, phase: 'final.audit', attempts: 3 },
    { at: '2026-09-08T00:06:00.000Z', seq: 3, phase: 'render.wrote', lines: 694 },
    { at: '2026-09-08T00:10:00.000Z', seq: 4, phase: 'run.end', verdict: 'MERGE_BLOCKED' },
  ])
  const out = check(dir)
  assert.equal(out.status, 1)
  assert.match(out.stdout, /final\.audit/)
  assert.match(out.stdout, /path/)
})

test('--check는 후보 수가 두 자리에서 어긋나면 짚는다', t => {
  // 한 리포트가 후보를 20개가 아니라 21개로 적었다 — synthesis 전용 모듈을
  // 후보로 세면서. 산술을 모델이 눈으로 세지 않는다는 원칙이 여기서도 같다.
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-08T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'win32', rules: 'r', version: '2.11.0', branch: 'b', changedFiles: 357, candidates: 20 },
    { at: '2026-09-08T00:01:00.000Z', seq: 2, phase: 'modules.planned', candidates: 21, applied: 19 },
    { at: '2026-09-08T00:10:00.000Z', seq: 3, phase: 'run.end', verdict: 'MERGE_BLOCKED' },
  ])
  const out = check(dir)
  assert.equal(out.status, 1)
  assert.match(out.stdout, /후보 수가 어긋난다/)
})

test('--check는 applied와 module.done 수가 어긋나면 경고로만 짚는다', t => {
  // fan-out 증거는 자동으로 남길 수 없다. 사후에 짚는 것까지가 전부이고,
  // 이것만으로 실행을 실패로 부를 수는 없다.
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-08T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'win32', rules: 'r', version: '2.11.0', branch: 'b', changedFiles: 9 },
    { at: '2026-09-08T00:01:00.000Z', seq: 2, phase: 'modules.planned', candidates: 20, applied: 3 },
    { at: '2026-09-08T00:01:30.000Z', seq: 3, phase: 'module.start', module: '01-fsd', attempt: 1 },
    { at: '2026-09-08T00:02:00.000Z', seq: 4, phase: 'module.done', module: '01-fsd', attempt: 1, status: 'ok', failureClass: 'none' },
    { at: '2026-09-08T00:02:10.000Z', seq: 5, phase: 'dispatch.end', terminalOk: 1, terminalFailed: 0, attemptsTotal: 1, attemptsFailed: 0 },
    { at: '2026-09-08T00:10:00.000Z', seq: 6, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.equal(out.status, 0, out.stdout)
  assert.match(out.stdout, /module\.done`이 남은 모듈은 1개/)
})

test('--check는 사이드카가 없으면 실패하고 어디를 봐야 하는지 말한다', t => {
  const dir = freshDir(t)
  const out = check(dir)
  assert.equal(out.status, 1)
  assert.match(out.stderr, /사이드카가 없다/)
  assert.match(out.stderr, /실행 타임라인/)
})

// ── 세는 단위·재시도·실패 클래스 정규형 ───────────────────────────────────
//
// 한 실행이 `ok:18, failed:0, failureClasses:{task-not-found:1, …}`을 남겼다.
// 실패가 0인데 실패 클래스가 3건이라, 세는 단위가 계약에 없으면 기록을 기계적으로
// 신뢰할 수 없다는 것이 드러났다.

test('dispatch.end는 최종 모듈 단위와 시도 단위를 따로 받는다', t => {
  const dir = freshDir(t)
  const out = spawnSync(process.execPath, [
    SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'dispatch.end',
    '--set', 'terminalOk=18', '--set', 'terminalFailed=0',
    '--set', 'attemptsTotal=21', '--set', 'attemptsFailed=3',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 0, out.stderr)
  assert.equal(out.stderr, '')
  const last = linesOf(dir).at(-1)
  assert.equal(last.terminalFailed, 0)
  assert.equal(last.attemptsFailed, 3)
})

test('attemptFailureClasses를 --set 한 값으로 밀어 넣으면 거부한다', t => {
  const dir = freshDir(t)
  const out = spawnSync(process.execPath, [
    SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'dispatch.end',
    '--set', 'terminalOk=18', '--set', 'terminalFailed=0',
    '--set', 'attemptsTotal=21', '--set', 'attemptsFailed=3',
    '--set', 'attemptFailureClasses=task-not-found:1,poll-timeout:2',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /--data-file/)
})

test('modules.planned의 skipped는 문자열로 받지 않는다', t => {
  // `"17,18,21"`로 남기면 왜 건너뛰었는지가 사라진다 — 트리거 부재인지 오류인지
  // 구분할 수 없다. 그 구분이 C-8이 요구하는 SKIPPED/FAILED/UNKNOWN이다.
  const dir = freshDir(t)
  const out = spawnSync(process.execPath, [
    SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'modules.planned',
    '--set', 'candidates=20', '--set', 'applied=17', '--set', 'skipped=17,18,21',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /--data-file/)
})

test('tool.done은 트리와 baseline을 함께 받는다', t => {
  const dir = freshDir(t)
  const out = spawnSync(process.execPath, [
    SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'tool.done',
    '--set', 'name=npm test', '--set', 'exit=1', '--set', 'treeSha=a6f9531',
    '--set', 'failedNow=140', '--set', 'failedBaseline=140',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 0, out.stderr)
  const last = linesOf(dir).at(-1)
  assert.equal(last.name, 'npm test')
  assert.equal(last.failedNow, last.failedBaseline)
})

test('표에 없는 failureClass는 경고하되 줄은 남긴다', t => {
  // 실패를 기록하려는 줄을 실패 이름 때문에 버리는 것은 앞뒤가 맞지 않는다.
  const dir = freshDir(t)
  const out = spawnSync(process.execPath, [
    SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'module.done',
    '--set', 'module=01-fsd', '--set', 'attempt=1', '--set', 'status=failed',
    '--set', 'failureClass=explore-provider-model-not-found',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 0)
  assert.match(out.stderr, /닫힌 목록에 없다/)
  assert.equal(linesOf(dir).length, 1)
})

test('--check는 표에 없는 failureClass를 짚는다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-08T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'h', rules: 'r', version: '2.11.0', branch: 'b', changedFiles: 9 },
    { at: '2026-09-08T00:01:00.000Z', seq: 2, phase: 'module.done', module: '01-fsd', attempt: 1, status: 'failed', failureClass: 'final-audit-weird' },
    { at: '2026-09-08T00:02:00.000Z', seq: 3, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.equal(out.status, 1)
  assert.match(out.stdout, /표에 없는 failureClass: final-audit-weird/)
})

test('--check는 같은 모듈·시도가 두 번 끝난 것을 짚는다', t => {
  // 한 실행이 모듈 01–04를 task-not-found로 찍고 같은 이름으로 다시 ok를 찍었다.
  // 재시도인지 늦게 돌아온 결과인지 구분할 수 없었다.
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-08T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'h', rules: 'r', version: '2.11.0', branch: 'b', changedFiles: 9 },
    { at: '2026-09-08T00:01:00.000Z', seq: 2, phase: 'module.done', module: '01-fsd', attempt: 1, status: 'failed', failureClass: 'task-not-found' },
    { at: '2026-09-08T00:02:00.000Z', seq: 3, phase: 'module.done', module: '01-fsd', attempt: 1, status: 'ok', failureClass: 'none' },
    { at: '2026-09-08T00:03:00.000Z', seq: 4, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.equal(out.status, 1)
  assert.match(out.stdout, /같은 모듈·시도가 두 번 끝났다/)
})

test('--check는 attempt를 올린 재시도는 짚지 않는다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-08T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'h', rules: 'r', version: '2.11.0', branch: 'b', changedFiles: 9 },
    { at: '2026-09-08T00:01:00.000Z', seq: 2, phase: 'modules.planned', candidates: 20, applied: 1 },
    { at: '2026-09-08T00:01:30.000Z', seq: 3, phase: 'module.start', module: '01-fsd', attempt: 1 },
    { at: '2026-09-08T00:02:00.000Z', seq: 4, phase: 'module.done', module: '01-fsd', attempt: 1, status: 'failed', failureClass: 'task-not-found' },
    { at: '2026-09-08T00:02:30.000Z', seq: 5, phase: 'module.start', module: '01-fsd', attempt: 2 },
    { at: '2026-09-08T00:03:00.000Z', seq: 6, phase: 'module.done', module: '01-fsd', attempt: 2, status: 'ok', failureClass: 'none' },
    { at: '2026-09-08T00:03:10.000Z', seq: 7, phase: 'dispatch.end', terminalOk: 1, terminalFailed: 0, attemptsTotal: 2, attemptsFailed: 1 },
    { at: '2026-09-08T00:04:00.000Z', seq: 8, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.equal(out.status, 0, out.stdout)
})

// --------------------------------------------------------------- 렌더 시점 요약
//
// C-7은 이 표를 `render.start` **직후**, `render.wrote`와 `run.end`를 적기 전에
// 만들라고 한다. 그 자리에서 종료 줄이 없는 것은 사고가 아니라 순서다. 그런데도
// "run.end가 없다"를 찍어, 계약을 지킨 2026-09-11 실행이 그 경보를 리포트에
// 싣고 **모델이 그 밑에 정상이라는 문단을 손으로 붙였다.** 늘 울리는 경보는
// 신호가 아니다.

test('--summary는 render.start에서 끝난 표를 사고가 아니라 순서로 적는다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-11T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'h', rules: 'r', version: '2.12.1', branch: 'b', changedFiles: 68 },
    { at: '2026-09-11T00:10:00.000Z', seq: 2, phase: 'render.start', findings: 47 },
  ])
  const out = summary(dir)
  assert.equal(out.status, 0, out.stderr)
  assert.doesNotMatch(out.stdout, /실행은 거기서 끝나지 않았다/)
  assert.match(out.stdout, /아직 일어나지 않은 것/)
})

test('--summary는 render.start가 아닌 자리에서 끊긴 실행에는 경보를 유지한다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-11T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'h', rules: 'r', version: '2.12.1', branch: 'b', changedFiles: 68 },
    { at: '2026-09-11T00:10:00.000Z', seq: 2, phase: 'synthesis.end', clusters: 9 },
  ])
  const out = summary(dir)
  assert.match(out.stdout, /`run.end`가 없다/)
  assert.match(out.stdout, /실행은 거기서 끝나지 않았다/)
})

test('--summary는 재렌더의 render.start도 순서로 읽는다', t => {
  // 렌더를 고쳐 다시 쓰면 run.end 뒤에 render.start가 온다. 계약은 그때
  // run.end를 다시 적어 마지막 자리를 되찾으라고 한다 — 이 표는 그 사이에서
  // 만들어지므로, "종료 뒤에 줄이 더 있다"도 같은 거짓 경보가 된다.
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-11T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'h', rules: 'r', version: '2.12.1', branch: 'b', changedFiles: 68 },
    { at: '2026-09-11T00:10:00.000Z', seq: 2, phase: 'render.wrote', path: 'r.md', lines: 1524 },
    { at: '2026-09-11T00:11:00.000Z', seq: 3, phase: 'run.end', verdict: 'merge-blocked' },
    { at: '2026-09-11T00:13:00.000Z', seq: 4, phase: 'render.start', findings: 47, note: '고쳐 다시 쓴다' },
  ])
  const out = summary(dir)
  assert.doesNotMatch(out.stdout, /종료가 마지막 자리에 있지 않으므로/)
  assert.match(out.stdout, /아직 일어나지 않은 것/)
  assert.match(out.stdout, /다시 적어/)
})

// ------------------------------------------------------- script.start 와 필드 이름

test('script.start는 닫힌 목록에 있다', t => {
  const dir = freshDir(t)
  const out = log(dir, 'script.start')
  assert.equal(out.status, 0, out.stderr)
  assert.equal(linesOf(dir)[0].phase, 'script.start')
})

test('표에 없는 필드는 경고하되 줄은 남긴다', t => {
  // 2026-09-11 실행이 `crossverify.end`에 `malformedCorrected`를 지어 넣었다.
  // 계약 어디에도 없는 이름이고 단위도 없어서, 그것이 verdict 수인지 task 수인지
  // 리포트 본문을 읽어야 알 수 있었다. phase 이름만 닫아 두면 필드가 샌다.
  const dir = freshDir(t)
  const out = log(dir, 'crossverify.end', { upheld: 12, rejected: 4, malformedCorrected: 3 })
  assert.equal(out.status, 0)
  assert.match(out.stderr, /malformedCorrected/)
  assert.match(out.stderr, /닫힌 목록에 없다/)
  assert.equal(linesOf(dir).length, 1)
})

test('선언된 필드와 note는 경고하지 않는다', t => {
  const dir = freshDir(t)
  const out = log(dir, 'crossverify.end', { upheld: 12, rejected: 4, needsContext: 0, malformedTasksCorrected: 3, note: '다시 셌다' })
  assert.equal(out.status, 0)
  assert.doesNotMatch(out.stderr, /닫힌 목록에 없다/)
})

test('--check는 표에 없는 필드 이름을 짚는다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-08T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'h', rules: 'r', version: '2.12.1', branch: 'b', changedFiles: 9 },
    { at: '2026-09-08T00:01:00.000Z', seq: 2, phase: 'crossverify.end', upheld: 12, rejected: 4, malformedCorrected: 3 },
    { at: '2026-09-08T00:02:00.000Z', seq: 3, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.equal(out.status, 1)
  assert.match(out.stdout, /crossverify\.end.*malformedCorrected/)
})

// ── 기록이 통째로 빠진 실행·디스패치의 모양 ────────────────────────────────
//
// 2026-09-18 실행이 `run.start` 다음에 곧장 `script.start`를 찍고 그 사이 1863초를
// 비운 채 `--check`를 통과했다. `modules.planned`까지 없으면 기존의 "applied와
// module.done 수가 어긋난다" 경고가 아예 돌지 않기 때문이다 — **하나도 안 남긴
// 실행이 몇 개 빠뜨린 실행보다 조용했다.**

test('tool.start는 닫힌 목록에 있다', t => {
  // 도구 넷을 돌리고 끝만 넷 찍으면 442초가 이름 없는 덩어리 하나로 남는다.
  const dir = freshDir(t)
  const out = log(dir, 'tool.start', { name: 'typecheck' })
  assert.equal(out.status, 0, out.stderr)
  assert.equal(linesOf(dir)[0].name, 'typecheck')
})

test('tool.start에 name이 없으면 경고하되 줄은 남긴다', t => {
  const dir = freshDir(t)
  const out = log(dir, 'tool.start', {})
  assert.equal(out.status, 0)
  assert.match(out.stderr, /name/)
  assert.equal(linesOf(dir).length, 1)
})

test('--check는 디스패치 기록이 한 줄도 없으면 실패한다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T02:21:46.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.0', branch: 'b', changedFiles: 12, candidates: 20 },
    { at: '2026-09-18T02:52:49.000Z', seq: 2, phase: 'script.start', script: 'prepare-verification' },
    { at: '2026-09-18T03:03:58.000Z', seq: 3, phase: 'run.end', verdict: 'CHANGES_REQUIRED' },
  ])
  const out = check(dir)
  assert.equal(out.status, 1)
  assert.match(out.stdout, /디스패치 기록이 한 줄도 없다/)
  assert.match(out.stdout, /script\.start/)
})

test('--check는 모듈이 한 줄이라도 남았으면 디스패치를 없다고 하지 않는다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.0', branch: 'b', changedFiles: 12, candidates: 20 },
    { at: '2026-09-18T00:01:00.000Z', seq: 2, phase: 'dispatch.start', modules: 19, inflight: 4 },
    { at: '2026-09-18T00:30:00.000Z', seq: 3, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.doesNotMatch(out.stdout, /디스패치 기록이 한 줄도 없다/)
})

test('--check는 fan-out을 예정하지 않은 기록을 디스패치 누락으로 부르지 않는다', t => {
  // 후보가 0이면 띄울 모듈이 없다. 없는 것을 빠뜨렸다고 하면 경보가 늘 울린다.
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.0', branch: 'b', changedFiles: 0, candidates: 0 },
    { at: '2026-09-18T00:10:00.000Z', seq: 2, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.equal(out.status, 0, out.stdout)
})

test('--check는 가장 긴 구간을 수치로 내고 그 사이 돌던 모듈 수를 함께 적는다', t => {
  // 모듈 넷이 나란히 도는 동안 줄이 안 남는 것은 정상이다. 그 구간을 "기록이
  // 비었다"로만 부르면 진짜 빈 구간과 구분되지 않는다.
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-17T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.0', branch: 'b', changedFiles: 13, candidates: 20 },
    { at: '2026-09-17T00:00:10.000Z', seq: 2, phase: 'module.start', module: '01-fsd', attempt: 1 },
    { at: '2026-09-17T00:00:11.000Z', seq: 3, phase: 'module.start', module: '02-type', attempt: 1 },
    { at: '2026-09-17T00:11:00.000Z', seq: 4, phase: 'module.done', module: '01-fsd', attempt: 1, status: 'ok', failureClass: 'none' },
    { at: '2026-09-17T00:11:01.000Z', seq: 5, phase: 'module.done', module: '02-type', attempt: 1, status: 'ok', failureClass: 'none' },
    { at: '2026-09-17T00:12:00.000Z', seq: 6, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.match(out.stdout, /가장 긴 무기록 구간 649s/)
  assert.match(out.stdout, /모듈 2개가 그 사이 돌고 있었다/)
})

test('--check는 아무것도 돌지 않은 빈 구간을 그렇게 부른다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T02:21:46.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.0', branch: 'b', changedFiles: 12, candidates: 20 },
    { at: '2026-09-18T02:52:49.000Z', seq: 2, phase: 'script.start', script: 'prepare-verification' },
    { at: '2026-09-18T02:52:50.000Z', seq: 3, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.match(out.stdout, /돌고 있던 것이 기록에 없다/)
})

test('--summary는 디스패치의 합계와 벽시계를 따로 낸다', t => {
  // 합계만 있으면 "느렸다"와 "놀았다"가 갈리지 않는다.
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-17T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.0', branch: 'b', changedFiles: 13 },
    { at: '2026-09-17T00:00:00.000Z', seq: 2, phase: 'module.start', module: '01-fsd', attempt: 1 },
    { at: '2026-09-17T00:00:00.000Z', seq: 3, phase: 'module.start', module: '02-type', attempt: 1 },
    { at: '2026-09-17T00:01:40.000Z', seq: 4, phase: 'module.done', module: '01-fsd', attempt: 1, status: 'ok', failureClass: 'none' },
    { at: '2026-09-17T00:01:40.000Z', seq: 5, phase: 'module.done', module: '02-type', attempt: 1, status: 'ok', failureClass: 'none' },
    { at: '2026-09-17T00:01:40.000Z', seq: 6, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = summary(dir)
  assert.equal(out.status, 0)
  assert.match(out.stdout, /\*\*디스패치\*\* 모듈 2개 · 시도 2개\(완료 2 · 미완료 0\) · 합 200s · 벽시계 100s · 실효 동시 2\.00 · 최대 동시 2 · 슬롯 유휴 0s/)
  assert.doesNotMatch(out.stdout, /0으로 떨어졌다/)
})

test('--summary는 인플라이트가 0으로 떨어진 횟수를 센다', t => {
  // 4개를 띄우고 4개가 모두 끝나기를 기다린 실행이 있다. 스킬은 정확히 그것을
  // 하지 말라고 적어 두었고, 지시는 세어 보기 전까지 지켜지지 않았다.
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-17T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.0', branch: 'b', changedFiles: 13 },
    { at: '2026-09-17T00:00:00.000Z', seq: 2, phase: 'module.start', module: '01-fsd', attempt: 1 },
    { at: '2026-09-17T00:01:00.000Z', seq: 3, phase: 'module.done', module: '01-fsd', attempt: 1, status: 'ok', failureClass: 'none' },
    { at: '2026-09-17T00:02:00.000Z', seq: 4, phase: 'module.start', module: '02-type', attempt: 1 },
    { at: '2026-09-17T00:03:00.000Z', seq: 5, phase: 'module.done', module: '02-type', attempt: 1, status: 'ok', failureClass: 'none' },
    { at: '2026-09-17T00:03:00.000Z', seq: 6, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = summary(dir)
  assert.match(out.stdout, /인플라이트가 1번 0으로 떨어졌다/)
  assert.match(out.stdout, /비어 있는 동안 60s가 쌓였다/)
})

test('--summary는 끝나지 않은 시도를 최소 관측 시간으로 세고 그 사실을 적는다', t => {
  // 끝난 시도만 세면 `module.start`만 남기고 죽은 실행에서 디스패치 요약이
  // 통째로 사라진다 — 계측이 가장 필요한 순간에 가장 조용해진다.
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-17T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.1', branch: 'b', changedFiles: 13 },
    { at: '2026-09-17T00:00:00.000Z', seq: 2, phase: 'module.start', module: '01-fsd', attempt: 1 },
    { at: '2026-09-17T00:00:00.000Z', seq: 3, phase: 'module.start', module: '02-type', attempt: 1 },
    { at: '2026-09-17T00:01:40.000Z', seq: 4, phase: 'module.done', module: '01-fsd', attempt: 1, status: 'ok', failureClass: 'none' },
    { at: '2026-09-17T00:01:40.000Z', seq: 5, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = summary(dir)
  assert.match(out.stdout, /모듈 2개 · 시도 2개\(완료 1 · 미완료 1\) · 합 200s/)
  assert.match(out.stdout, /끝을 남기지 않은 시도가 1개다/)
  assert.match(out.stdout, /\*\*최소\*\* 관측 시간/)
})

test('--summary는 module.done이 하나도 없는 실행에서도 디스패치를 낸다', t => {
  // 리뷰 지적: 첫 wave가 전부 미완료로 죽으면 블록 자체가 사라졌다. 죽은 실행의
  // 병목을 설명하려는 계측에서 가장 중요한 실패 경로다.
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.1', branch: 'b', changedFiles: 9, candidates: 20 },
    { at: '2026-09-18T00:00:00.000Z', seq: 2, phase: 'module.start', module: '01-fsd', attempt: 1 },
    { at: '2026-09-18T00:00:00.000Z', seq: 3, phase: 'module.start', module: '02-type', attempt: 1 },
    { at: '2026-09-18T00:30:00.000Z', seq: 4, phase: 'module.start', module: '03-react-rules', attempt: 1 },
  ])
  const out = summary(dir)
  assert.match(out.stdout, /모듈 3개 · 시도 3개\(완료 0 · 미완료 3\)/)
  assert.match(out.stdout, /끝을 남기지 않은 시도가 3개다/)
})

test('--check는 시작만 남은 모듈도 인플라이트로 센다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.1', branch: 'b', changedFiles: 9, candidates: 20 },
    { at: '2026-09-18T00:00:00.000Z', seq: 2, phase: 'module.start', module: '01-fsd', attempt: 1 },
    { at: '2026-09-18T00:00:01.000Z', seq: 3, phase: 'module.start', module: '02-type', attempt: 1 },
    { at: '2026-09-18T00:30:01.000Z', seq: 4, phase: 'module.start', module: '03-react-rules', attempt: 1 },
  ])
  const out = check(dir)
  assert.match(out.stdout, /모듈 2개가 그 사이 돌고 있었다/)
  assert.doesNotMatch(out.stdout, /돌고 있던 것이 기록에 없다/)
})

test('--summary는 재시도를 모듈이 아니라 시도로 센다', t => {
  // 구간의 단위는 module#attempt인데 출력이 "모듈 N개"였다. 재시도한 모듈
  // 하나가 둘로 세어져, C-9가 나눠 둔 모듈 단위와 시도 단위가 다시 섞였다.
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.1', branch: 'b', changedFiles: 9 },
    { at: '2026-09-18T00:00:00.000Z', seq: 2, phase: 'module.start', module: '01-fsd', attempt: 1 },
    { at: '2026-09-18T00:00:30.000Z', seq: 3, phase: 'module.done', module: '01-fsd', attempt: 1, status: 'failed', failureClass: 'task-not-found' },
    { at: '2026-09-18T00:00:30.000Z', seq: 4, phase: 'module.start', module: '01-fsd', attempt: 2, retryOf: 'bg_a' },
    { at: '2026-09-18T00:01:40.000Z', seq: 5, phase: 'module.done', module: '01-fsd', attempt: 2, status: 'ok', failureClass: 'none' },
    { at: '2026-09-18T00:01:41.000Z', seq: 6, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = summary(dir)
  assert.match(out.stdout, /모듈 1개 · 시도 2개\(완료 2 · 미완료 0\)/)
})

test('--summary는 같은 시각에 인계된 시도를 배리어로 세지 않는다', t => {
  // 앞 시도 종료와 다음 시도 시작의 타임스탬프가 같으면 슬롯이 빈 것이 아니다.
  // `>=`로 두었더니 "인플라이트가 1번 0으로 떨어졌다, 유휴 0s"라는 자기모순적인
  // 경고가 나왔다 — 배리어가 아닌 것을 배리어로 세면 이 수치를 못 믿는다.
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.1', branch: 'b', changedFiles: 9 },
    { at: '2026-09-18T00:00:00.000Z', seq: 2, phase: 'module.start', module: '01-fsd', attempt: 1 },
    { at: '2026-09-18T00:00:30.000Z', seq: 3, phase: 'module.done', module: '01-fsd', attempt: 1, status: 'ok', failureClass: 'none' },
    { at: '2026-09-18T00:00:30.000Z', seq: 4, phase: 'module.start', module: '02-type', attempt: 1 },
    { at: '2026-09-18T00:01:40.000Z', seq: 5, phase: 'module.done', module: '02-type', attempt: 1, status: 'ok', failureClass: 'none' },
    { at: '2026-09-18T00:01:41.000Z', seq: 6, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = summary(dir)
  assert.doesNotMatch(out.stdout, /0으로 떨어졌다/)
})

test('--summary는 진짜로 빈 구간은 배리어로 센다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.1', branch: 'b', changedFiles: 9 },
    { at: '2026-09-18T00:00:00.000Z', seq: 2, phase: 'module.start', module: '01-fsd', attempt: 1 },
    { at: '2026-09-18T00:00:30.000Z', seq: 3, phase: 'module.done', module: '01-fsd', attempt: 1, status: 'ok', failureClass: 'none' },
    { at: '2026-09-18T00:01:30.000Z', seq: 4, phase: 'module.start', module: '02-type', attempt: 1 },
    { at: '2026-09-18T00:02:00.000Z', seq: 5, phase: 'module.done', module: '02-type', attempt: 1, status: 'ok', failureClass: 'none' },
    { at: '2026-09-18T00:02:01.000Z', seq: 6, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = summary(dir)
  assert.match(out.stdout, /인플라이트가 1번 0으로 떨어졌다/)
  assert.match(out.stdout, /비어 있는 동안 60s가 쌓였다/)
})

// ── 도구 실행의 시작·끝 짝 ────────────────────────────────────────────────
//
// `tool.start`를 닫힌 목록에 넣는 것만으로는 아무것도 강제되지 않는다. 끝만 넷
// 남긴 기록이 그대로 통과하면, 442초를 귀속할 수 없던 상태가 그대로 재발한다.

test('--check는 tool.start 없이 끝난 도구를 실패로 짚는다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.1', branch: 'b', changedFiles: 9 },
    { at: '2026-09-18T00:10:00.000Z', seq: 2, phase: 'tool.done', name: 'lint', exit: 0, treeSha: 't' },
    { at: '2026-09-18T00:10:00.000Z', seq: 3, phase: 'tool.done', name: 'typecheck', exit: 2, treeSha: 't' },
    { at: '2026-09-18T00:10:01.000Z', seq: 4, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.equal(out.status, 1)
  assert.match(out.stdout, /`tool\.start` 없이 끝난 도구/)
  assert.match(out.stdout, /lint.*typecheck/)
})

test('--check는 끝을 남기지 않은 도구를 경고로만 짚는다', t => {
  // 시작만 있고 끝이 없는 것은 "돌렸고 끝내지 못했다"는 유효한 기록이다 —
  // `script.start`에 대해 계약이 이미 그렇게 정했다.
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.1', branch: 'b', changedFiles: 9 },
    { at: '2026-09-18T00:01:00.000Z', seq: 2, phase: 'tool.start', name: 'test' },
    { at: '2026-09-18T00:10:00.000Z', seq: 3, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.equal(out.status, 0, out.stdout)
  assert.match(out.stdout, /끝을 남기지 않은 도구 1개.*test/)
})

test('--check는 시작과 끝의 이름이 다르면 양쪽 다 짚는다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.1', branch: 'b', changedFiles: 9 },
    { at: '2026-09-18T00:01:00.000Z', seq: 2, phase: 'tool.start', name: 'typecheck' },
    { at: '2026-09-18T00:02:00.000Z', seq: 3, phase: 'tool.done', name: 'lint', exit: 0, treeSha: 't' },
    { at: '2026-09-18T00:02:01.000Z', seq: 4, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.equal(out.status, 1)
  assert.match(out.stdout, /`tool\.start` 없이 끝난 도구.*lint/)
  assert.match(out.stdout, /끝을 남기지 않은 도구 1개.*typecheck/)
})

test('--check는 같은 도구가 중복 시작되면 끝나지 않은 쪽을 남긴다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.1', branch: 'b', changedFiles: 9 },
    { at: '2026-09-18T00:01:00.000Z', seq: 2, phase: 'tool.start', name: 'test' },
    { at: '2026-09-18T00:01:30.000Z', seq: 3, phase: 'tool.start', name: 'test' },
    { at: '2026-09-18T00:02:00.000Z', seq: 4, phase: 'tool.done', name: 'test', exit: 0, treeSha: 't' },
    { at: '2026-09-18T00:02:01.000Z', seq: 5, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.equal(out.status, 0, out.stdout)
  assert.match(out.stdout, /끝을 남기지 않은 도구 1개/)
})

test('--check는 같은 도구를 여러 번 정상 실행한 기록을 통과시킨다', t => {
  // C-6은 baseline과 현재를 각각 재라고 한다. 같은 `lint`가 두 트리에서 두 번
  // 도는 것이 정상이므로, 이름 유일성으로 짝지으면 정상 실행을 중복으로 부른다.
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.1', branch: 'b', changedFiles: 9 },
    { at: '2026-09-18T00:01:00.000Z', seq: 2, phase: 'tool.start', name: 'lint' },
    { at: '2026-09-18T00:01:30.000Z', seq: 3, phase: 'tool.done', name: 'lint', exit: 0, treeSha: 'base' },
    { at: '2026-09-18T00:02:00.000Z', seq: 4, phase: 'tool.start', name: 'lint' },
    { at: '2026-09-18T00:03:00.000Z', seq: 5, phase: 'tool.done', name: 'lint', exit: 1, treeSha: 'head' },
    { at: '2026-09-18T00:03:01.000Z', seq: 6, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.equal(out.status, 0, out.stdout)
  assert.doesNotMatch(out.stdout, /없이 끝난 도구|끝을 남기지 않은 도구/)
  assert.match(summary(dir).stdout, /\*\*도구\*\* `lint` 30s\(exit 0\) · `lint` 60s\(exit 1\)/)
})

test('--summary는 도구 이벤트가 없으면 도구 줄을 만들지 않는다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.1', branch: 'b', changedFiles: 9 },
    { at: '2026-09-18T00:10:00.000Z', seq: 2, phase: 'run.end', verdict: 'WARN' },
  ])
  assert.doesNotMatch(summary(dir).stdout, /\*\*도구\*\*/)
})

test('--check는 applied가 0이면 디스패치 누락으로 부르지 않는다', t => {
  // 적용할 모듈이 하나도 없다고 스스로 적은 정상 실행이다. 없는 것을
  // 빠뜨렸다고 하면 경보가 늘 울리고, 늘 울리는 경보는 신호가 아니다.
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.1', branch: 'b', changedFiles: 1, candidates: 20 },
    { at: '2026-09-18T00:00:10.000Z', seq: 2, phase: 'modules.planned', candidates: 20, applied: 0 },
    { at: '2026-09-18T00:01:00.000Z', seq: 3, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.equal(out.status, 0, out.stdout)
})

test('--check는 applied가 0보다 크면 디스패치 누락을 짚는다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.1', branch: 'b', changedFiles: 9, candidates: 20 },
    { at: '2026-09-18T00:00:10.000Z', seq: 2, phase: 'modules.planned', candidates: 20, applied: 19 },
    { at: '2026-09-18T00:31:00.000Z', seq: 3, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.equal(out.status, 1)
  assert.match(out.stdout, /디스패치 기록이 한 줄도 없다/)
})

test('--check는 1위에 가린 2위 구간도 낸다', t => {
  // 09-18 실행에서 1위는 1863초, 2위는 442초(전체의 17%)였는데 1위만 내면
  // 2위가 그 뒤에 가린다. 실제로 그 리포트는 442초를 한 번도 언급하지 않았다.
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.1', branch: 'b', changedFiles: 12, candidates: 20 },
    { at: '2026-09-18T00:31:03.000Z', seq: 2, phase: 'dispatch.start', modules: 19, inflight: 4 },
    { at: '2026-09-18T00:34:49.000Z', seq: 3, phase: 'crossverify.end', upheld: 3, rejected: 0 },
    { at: '2026-09-18T00:42:11.000Z', seq: 4, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.match(out.stdout, /가장 긴 무기록 구간 1863s \(전체의 74%\)/)
  assert.match(out.stdout, /그 다음 2위 442s \(전체의 17%\)/)
})

test('--check는 짧은 잔구간까지 줄줄이 내지 않는다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.1', branch: 'b', changedFiles: 12 },
    { at: '2026-09-18T00:30:00.000Z', seq: 2, phase: 'crossverify.end', upheld: 3, rejected: 0 },
    { at: '2026-09-18T00:30:20.000Z', seq: 3, phase: 'synthesis.end', clusters: 2 },
    { at: '2026-09-18T00:30:40.000Z', seq: 4, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.match(out.stdout, /가장 긴 무기록 구간 1800s/)
  assert.doesNotMatch(out.stdout, /그 다음/)
})

test('--summary는 모듈 기록이 없으면 디스패치 줄을 만들지 않는다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.0', branch: 'b', changedFiles: 12 },
    { at: '2026-09-18T00:30:00.000Z', seq: 2, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = summary(dir)
  assert.doesNotMatch(out.stdout, /\*\*디스패치\*\*/)
})

test('--summary는 최장 구간이 시작 표시에 붙으면 그 단계의 소요가 아니라고 적는다', t => {
  // 한 리포트가 `script.start`에 1863초가 찍힌 표를 그대로 싣고 본문에서 그
  // 시간을 언급하지 않았다. script.start 자체는 0초이고, 1863초는 그 앞의
  // 아무 기록도 없는 구간이었다.
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T02:21:46.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.0', branch: 'b', changedFiles: 12 },
    { at: '2026-09-18T02:52:49.000Z', seq: 2, phase: 'script.start', script: 'prepare-verification' },
    { at: '2026-09-18T02:52:49.000Z', seq: 3, phase: 'script.done', ran: true, counts: { total: 17 } },
    { at: '2026-09-18T02:53:00.000Z', seq: 4, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = summary(dir)
  assert.match(out.stdout, /사이\*\*의 1863s이고/)
})

test('--summary는 최장 구간이 끝 표시에 붙으면 그 문장을 붙이지 않는다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.0', branch: 'b', changedFiles: 12 },
    { at: '2026-09-18T00:30:00.000Z', seq: 2, phase: 'crossverify.end', upheld: 3, rejected: 0 },
    { at: '2026-09-18T00:30:10.000Z', seq: 3, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = summary(dir)
  assert.doesNotMatch(out.stdout, /사이\*\*의/)
})

// ── 검증 대상과 판정 수 ────────────────────────────────────────────────────
//
// 2026-09-18 실행이 대상 16건을 잡고 판정 13건을 남겼다. 3건은 verifier
// 타임아웃으로 판정이 없었고, 그 사실은 리포트 산문에만 있었다. 사이드카만
// 읽으면 "검증하고 통과했다"인지 "검증하지 못했다"인지 갈리지 않는다.

const withVerify = (verify, verdicts) => ([
  { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.3', branch: 'b', changedFiles: 22 },
  { at: '2026-09-18T00:01:00.000Z', seq: 2, phase: 'script.done', ran: true, counts: { total: 35, verify } },
  { at: '2026-09-18T01:00:00.000Z', seq: 3, phase: 'crossverify.end', ...verdicts },
  { at: '2026-09-18T01:01:00.000Z', seq: 4, phase: 'run.end', verdict: 'MERGE_BLOCKED' },
])

test('noVerdict는 닫힌 목록에 있다', t => {
  const dir = freshDir(t)
  const out = log(dir, 'crossverify.end', { upheld: 13, rejected: 0, needsContext: 0, noVerdict: 3 })
  assert.equal(out.status, 0, out.stderr)
  assert.doesNotMatch(out.stderr, /닫힌 목록에 없다/)
  assert.equal(linesOf(dir)[0].noVerdict, 3)
})

test('--check는 대상보다 판정이 적으면 실패한다', t => {
  const dir = freshDir(t)
  plant(dir, withVerify(16, { upheld: 13, rejected: 0, needsContext: 0 }))
  const out = check(dir)
  assert.equal(out.status, 1)
  assert.match(out.stdout, /검증 대상과 판정 수가 맞지 않는다/)
  assert.match(out.stdout, /16건을 대상으로 적었는데.*13건/)
})

test('--check는 noVerdict로 채워진 차이는 짚지 않는다', t => {
  const dir = freshDir(t)
  plant(dir, withVerify(16, { upheld: 13, rejected: 0, needsContext: 0, noVerdict: 3 }))
  const out = check(dir)
  assert.equal(out.status, 0, out.stdout)
})

test('--check는 대상보다 판정이 많아도 짚는다', t => {
  // 후보별 마지막 판정만 세야 하는데 재판정을 두 번 세면 이렇게 된다.
  const dir = freshDir(t)
  plant(dir, withVerify(10, { upheld: 9, rejected: 3, needsContext: 0 }))
  const out = check(dir)
  assert.equal(out.status, 1)
  assert.match(out.stdout, /검증 대상과 판정 수가 맞지 않는다/)
})

test('--check는 대상 수가 없으면 대조하지 않는다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.3', branch: 'b', changedFiles: 22 },
    { at: '2026-09-18T01:00:00.000Z', seq: 2, phase: 'crossverify.end', upheld: 13, rejected: 0 },
    { at: '2026-09-18T01:01:00.000Z', seq: 3, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.equal(out.status, 0, out.stdout)
})

test('--check는 교차검증을 돌리지 않은 실행을 불일치로 부르지 않는다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.3', branch: 'b', changedFiles: 22 },
    { at: '2026-09-18T00:01:00.000Z', seq: 2, phase: 'script.done', ran: true, counts: { total: 35, verify: 16 } },
    { at: '2026-09-18T01:01:00.000Z', seq: 3, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.equal(out.status, 0, out.stdout)
})

test('--check는 나중에 적힌 crossverify.end를 정본으로 쓴다', t => {
  // append-only 기록에서 정정은 앞 줄을 고치는 대신 새 줄로 온다.
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.3', branch: 'b', changedFiles: 22 },
    { at: '2026-09-18T00:01:00.000Z', seq: 2, phase: 'script.done', ran: true, counts: { total: 35, verify: 16 } },
    { at: '2026-09-18T01:00:00.000Z', seq: 3, phase: 'crossverify.end', upheld: 13, rejected: 0, needsContext: 0 },
    { at: '2026-09-18T01:00:44.000Z', seq: 4, phase: 'crossverify.end', upheld: 13, rejected: 0, needsContext: 0, noVerdict: 3, note: '다시 셌다' },
    { at: '2026-09-18T01:01:00.000Z', seq: 5, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.equal(out.status, 0, out.stdout)
})

// ── 시작 없는 끝·열린 도구·재시도 짝 ───────────────────────────────────────
//
// `tool.done`만 남은 기록을 막았더니 `module.done`만 남은 기록이 같은 자리에
// 그대로 있었다. 검사에는 정상이고 요약에는 없는 상태가 되는데, 그것이 이
// 변경이 없애려는 "시간 귀속이 조용히 비는" 상태 그 자체다.

test('--check는 module.start 없이 끝난 시도를 실패로 짚는다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.4', branch: 'b', changedFiles: 9, candidates: 20 },
    { at: '2026-09-18T00:00:10.000Z', seq: 2, phase: 'modules.planned', candidates: 20, applied: 1 },
    { at: '2026-09-18T00:30:00.000Z', seq: 3, phase: 'module.done', module: '01-fsd', attempt: 1, status: 'ok', findings: 2 },
    { at: '2026-09-18T00:30:01.000Z', seq: 4, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.equal(out.status, 1)
  assert.match(out.stdout, /`module\.start` 없이 끝난 시도.*01-fsd/)
})

test('--summary는 시작 기록이 없어도 완료를 내고 소요를 미측정이라고 적는다', t => {
  // 블록이 없으면 "모듈이 안 돌았다"로 읽히는데, 끝은 남아 있으므로 돌기는 했다.
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.4', branch: 'b', changedFiles: 9 },
    { at: '2026-09-18T00:30:00.000Z', seq: 2, phase: 'module.done', module: '01-fsd', attempt: 1, status: 'ok', findings: 2 },
    { at: '2026-09-18T00:30:01.000Z', seq: 3, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = summary(dir)
  assert.match(out.stdout, /\*\*디스패치\*\* 모듈 1개 · 완료 1개 · \*\*소요 미측정\*\*/)
})

test('--summary는 짝이 있는 시도와 시작 없는 완료를 함께 낸다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.4', branch: 'b', changedFiles: 9 },
    { at: '2026-09-18T00:00:00.000Z', seq: 2, phase: 'module.start', module: '01-fsd', attempt: 1 },
    { at: '2026-09-18T00:01:40.000Z', seq: 3, phase: 'module.done', module: '01-fsd', attempt: 1, status: 'ok', failureClass: 'none' },
    { at: '2026-09-18T00:01:40.000Z', seq: 4, phase: 'module.done', module: '02-type', attempt: 1, status: 'ok', failureClass: 'none' },
    { at: '2026-09-18T00:01:41.000Z', seq: 5, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = summary(dir)
  assert.match(out.stdout, /모듈 1개 · 시도 1개\(완료 1 · 미완료 0\)/)
  assert.match(out.stdout, /시작 기록 없는 완료 1개\(소요 미측정\)/)
})

test('--check는 같은 모듈·시도가 두 번 시작되면 짚는다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.4', branch: 'b', changedFiles: 9 },
    { at: '2026-09-18T00:00:00.000Z', seq: 2, phase: 'module.start', module: '01-fsd', attempt: 1 },
    { at: '2026-09-18T00:00:30.000Z', seq: 3, phase: 'module.start', module: '01-fsd', attempt: 1 },
    { at: '2026-09-18T00:01:40.000Z', seq: 4, phase: 'module.done', module: '01-fsd', attempt: 1, status: 'ok', failureClass: 'none' },
    { at: '2026-09-18T00:01:41.000Z', seq: 5, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.equal(out.status, 1)
  assert.match(out.stdout, /같은 모듈·시도가 두 번 시작됐다/)
})

test('--check는 attempt를 올린 재시도의 시작은 짚지 않는다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.4', branch: 'b', changedFiles: 9 },
    { at: '2026-09-18T00:00:00.000Z', seq: 2, phase: 'module.start', module: '01-fsd', attempt: 1 },
    { at: '2026-09-18T00:00:30.000Z', seq: 3, phase: 'module.done', module: '01-fsd', attempt: 1, status: 'failed', failureClass: 'task-not-found' },
    { at: '2026-09-18T00:00:31.000Z', seq: 4, phase: 'module.start', module: '01-fsd', attempt: 2 },
    { at: '2026-09-18T00:01:40.000Z', seq: 5, phase: 'module.done', module: '01-fsd', attempt: 2, status: 'ok', failureClass: 'none' },
    { at: '2026-09-18T00:01:45.000Z', seq: 6, phase: 'dispatch.end', terminalOk: 1, terminalFailed: 0, attemptsTotal: 2, attemptsFailed: 1 },
    { at: '2026-09-18T00:01:46.000Z', seq: 7, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.equal(out.status, 0, out.stdout)
})

test('--check는 끝나지 않은 도구도 그 구간에 돌던 것으로 센다', t => {
  // 도구 요약은 "끝 기록 없음"이라고 하는데 구간은 비었다고 하면 같은 기록이
  // 두 말을 한다.
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.4', branch: 'b', changedFiles: 9 },
    { at: '2026-09-18T00:00:10.000Z', seq: 2, phase: 'tool.start', name: 'test' },
    { at: '2026-09-18T00:30:10.000Z', seq: 3, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.match(out.stdout, /도구 1개가 그 사이 돌고 있었다/)
})

test('--summary는 타임아웃 뒤 재시작한 도구의 끝을 마지막 시작에 붙인다', t => {
  // 먼저 열린 것부터 닫았더니 5분짜리 재실행이 25분으로 기록됐다.
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.4', branch: 'b', changedFiles: 9 },
    { at: '2026-09-18T00:00:00.000Z', seq: 2, phase: 'tool.start', name: 'test' },
    { at: '2026-09-18T00:20:00.000Z', seq: 3, phase: 'tool.start', name: 'test' },
    { at: '2026-09-18T00:25:00.000Z', seq: 4, phase: 'tool.done', name: 'test', exit: 0, treeSha: 't' },
    { at: '2026-09-18T00:25:01.000Z', seq: 5, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = summary(dir)
  assert.match(out.stdout, /`test` 300s\(exit 0\) · `test` 끝 기록 없음/)
})

test('--summary는 attempt가 있으면 그것으로 도구의 짝을 맞춘다', t => {
  // 추측할 것이 없어진다. 끝이 1차 시도의 것이라고 기록이 말하면 그대로 붙인다.
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.4', branch: 'b', changedFiles: 9 },
    { at: '2026-09-18T00:00:00.000Z', seq: 2, phase: 'tool.start', name: 'test', attempt: 1 },
    { at: '2026-09-18T00:20:00.000Z', seq: 3, phase: 'tool.start', name: 'test', attempt: 2 },
    { at: '2026-09-18T00:25:00.000Z', seq: 4, phase: 'tool.done', name: 'test', attempt: 1, exit: 0, treeSha: 't' },
    { at: '2026-09-18T00:25:01.000Z', seq: 5, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = summary(dir)
  assert.match(out.stdout, /`test` 1500s\(exit 0\)/)
})

test('도구의 attempt는 닫힌 목록에 있다', t => {
  const dir = freshDir(t)
  const out = log(dir, 'tool.start', { name: 'test', attempt: 2 })
  assert.equal(out.status, 0, out.stderr)
  assert.doesNotMatch(out.stderr, /닫힌 목록에 없다/)
})

// ── 디스패치의 끝·사이드카와 리포트의 짝·표의 출처 ─────────────────────────
//
// 2026-09-18 실행이 `dispatch.start`만 남기고 끝냈는데 리포트에는 "초기 실패
// 4건 · malformed 1건 · 최종 미회수 0건"이 적혀 있었다. 그 셋이 정확히
// `dispatch.end`가 담는 값이므로 손으로 옮긴 수치다.

const dispatched = (extra = []) => ([
  { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.5', branch: 'b', changedFiles: 73, candidates: 20 },
  { at: '2026-09-18T00:00:10.000Z', seq: 2, phase: 'modules.planned', candidates: 20, applied: 1 },
  { at: '2026-09-18T00:00:20.000Z', seq: 3, phase: 'dispatch.start', modules: 1, inflight: 4 },
  { at: '2026-09-18T00:00:21.000Z', seq: 4, phase: 'module.start', module: '01-fsd', attempt: 1 },
  { at: '2026-09-18T00:01:00.000Z', seq: 5, phase: 'module.done', module: '01-fsd', attempt: 1, status: 'failed', failureClass: 'skill-injection-invalid' },
  { at: '2026-09-18T00:01:10.000Z', seq: 6, phase: 'module.start', module: '01-fsd', attempt: 2 },
  { at: '2026-09-18T00:02:00.000Z', seq: 7, phase: 'module.done', module: '01-fsd', attempt: 2, status: 'ok', failureClass: 'none' },
  ...extra,
  { at: '2026-09-18T00:10:00.000Z', seq: 90, phase: 'run.end', verdict: 'WARN' },
])

test('--check는 dispatch.end가 없으면 실패한다', t => {
  const dir = freshDir(t)
  plant(dir, dispatched())
  const out = check(dir)
  assert.equal(out.status, 1)
  assert.match(out.stdout, /`dispatch\.end`가 없다/)
  assert.match(out.stdout, /기억에서 온 것/)
})

test('--check는 dispatch.end의 수치를 module.done으로 다시 센다', t => {
  const dir = freshDir(t)
  plant(dir, dispatched([
    { at: '2026-09-18T00:03:00.000Z', seq: 8, phase: 'dispatch.end', terminalOk: 1, terminalFailed: 0, attemptsTotal: 1, attemptsFailed: 0 },
  ]))
  const out = check(dir)
  assert.equal(out.status, 1)
  assert.match(out.stdout, /attemptsTotal 1 → 기록으로 세면 2/)
  assert.match(out.stdout, /attemptsFailed 0 → 기록으로 세면 1/)
})

test('--check는 맞는 dispatch.end는 짚지 않는다', t => {
  const dir = freshDir(t)
  plant(dir, dispatched([
    { at: '2026-09-18T00:03:00.000Z', seq: 8, phase: 'dispatch.end', terminalOk: 1, terminalFailed: 0, attemptsTotal: 2, attemptsFailed: 1 },
  ]))
  const out = check(dir)
  assert.doesNotMatch(out.stdout, /`dispatch\.end`가 없다|`dispatch\.end`의 수치/)
})

test('--check는 특수 패스를 dispatch.end 집계에 넣지 않는다', t => {
  // numbered 모듈만 센다. 두 단위가 한 필드에서 섞이면 `ok:18`과 `module.done`
  // 20건이 어긋나던 그 문제로 돌아간다.
  const dir = freshDir(t)
  plant(dir, dispatched([
    { at: '2026-09-18T00:02:30.000Z', seq: 8, phase: 'module.start', module: 'exception', attempt: 1 },
    { at: '2026-09-18T00:02:50.000Z', seq: 9, phase: 'module.done', module: 'exception', attempt: 1, status: 'ok', failureClass: 'none' },
    { at: '2026-09-18T00:03:00.000Z', seq: 10, phase: 'dispatch.end', terminalOk: 1, terminalFailed: 0, attemptsTotal: 2, attemptsFailed: 1 },
  ]))
  const out = check(dir)
  assert.doesNotMatch(out.stdout, /dispatch\.end`의 수치/)
})

test('--check는 디스패치가 없던 실행에 dispatch.end를 요구하지 않는다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.5', branch: 'b', changedFiles: 1, candidates: 0 },
    { at: '2026-09-18T00:10:00.000Z', seq: 2, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.equal(out.status, 0, out.stdout)
})

// 사이드카는 `<리포트 디렉터리>/.timing/<리포트 basename>.jsonl`이다. 한 실행이
// 리포트를 Docs에 쓰고 사이드카는 워크트리에 남겼다 — 이름도 디렉터리도 달랐다.

const wroteTo = path => ([
  { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.5', branch: 'b', changedFiles: 9 },
  { at: '2026-09-18T00:10:00.000Z', seq: 2, phase: 'render.wrote', path, lines: 681 },
  { at: '2026-09-18T00:10:01.000Z', seq: 3, phase: 'run.end', verdict: 'WARN' },
])

test('--check는 사이드카와 리포트의 이름이 다르면 짚는다', t => {
  const dir = freshDir(t)
  plant(dir, wroteTo(join(dir, 'code-review-full-refactor-3d-scan-ux-2026-09-18.md')))
  const out = check(dir)
  assert.equal(out.status, 1)
  assert.match(out.stdout, /사이드카와 리포트의 이름이 다르다/)
})

test('--check는 사이드카와 리포트가 다른 디렉터리면 짚는다', t => {
  const dir = freshDir(t)
  const elsewhere = mkdtempSync(join(tmpdir(), 'elsewhere-'))
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }))
  plant(dir, wroteTo(join(elsewhere, `${RUN}.md`)))
  const out = check(dir)
  assert.equal(out.status, 1)
  assert.match(out.stdout, /다른 디렉터리에 있다/)
})

test('--check는 짝이 맞으면 짚지 않는다', t => {
  const dir = freshDir(t)
  plant(dir, wroteTo(join(dir, `${RUN}.md`)))
  const out = check(dir)
  assert.equal(out.status, 0, out.stdout)
})

test('--check는 render.wrote가 없으면 짝을 따지지 않는다', t => {
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.5', branch: 'b', changedFiles: 9 },
    { at: '2026-09-18T00:10:00.000Z', seq: 2, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = check(dir)
  assert.equal(out.status, 0, out.stdout)
})

test('--summary는 표의 출처와 이벤트 수를 함께 낸다', t => {
  // 한 리포트가 71행짜리 표를 실었는데 그중 4행이 사이드카와 달랐다. 위조를
  // 막을 수는 없지만 대조할 수 있게는 만든다.
  const dir = freshDir(t)
  plant(dir, [
    { at: '2026-09-18T00:00:00.000Z', seq: 1, phase: 'run.start', host: 'opencode', rules: 'r', version: '2.13.5', branch: 'b', changedFiles: 9 },
    { at: '2026-09-18T00:10:00.000Z', seq: 2, phase: 'run.end', verdict: 'WARN' },
  ])
  const out = summary(dir)
  assert.equal(out.status, 0)
  assert.match(out.stdout, /> 출처: `.*code-review-full-feat-x-2026-09-01\.jsonl` · 이벤트 2개 · 마지막 `run\.end`/)
  assert.match(out.stdout, /손으로 고치면 대조가 깨진다/)
})
