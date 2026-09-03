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
  const dir = freshDir(t)
  log(dir, 'run.start')
  log(dir, 'render.start')
  const out = summary(dir)
  assert.match(out.stdout, /`run\.end`가 없다/)
  assert.match(out.stdout, /마지막으로 남은 단계는 `render\.start`/)
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
    SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'report.saved',
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
    SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'x',
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
  const out = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'x', '--set', 'lines694'],
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
  const out = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'x', '--data-file', join(dir, 'nope.json')],
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
    SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'x',
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
  log(dir, 'a', { module: '01', clusters: 'pending' })
  log(dir, 'b', { module: 11, clusters: 1 })
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

  const out = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'x', '--data-file', payload],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 0, out.stderr)
  assert.equal(linesOf(dir).at(-1).note, '한글')
})

test('UTF-16LE로 쓴 --data-file을 읽는다', t => {
  const dir = freshDir(t)
  const payload = join(dir, 'bom16.json')
  writeBytes(payload, Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify({ note: '한글' }), 'utf16le'))

  const out = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'x', '--data-file', payload],
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

  const out = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'x', '--data-file', payload],
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
  spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'x',
    '--set', 'a=1e3', '--set', 'b=0x10', '--set', 'c=+5', '--set', 'd=1.50'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  const last = linesOf(dir).at(-1)
  for (const [key, expected] of [['a', '1e3'], ['b', '0x10'], ['c', '+5'], ['d', '1.50']]) {
    assert.strictEqual(last[key], expected, key)
  }
})

test('세는 값은 여전히 숫자다', t => {
  const dir = freshDir(t)
  spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'x',
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
  const out = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'x', '--set', 'note=검토', '완료'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /unexpected argument/)
  assert.match(out.stderr, /따옴표/)
  assert.ok(!existsSync(join(dir, '.timing')))
})

test('모르는 플래그를 무시하지 않는다', t => {
  const dir = freshDir(t)
  const out = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'x', '--sset', 'a=1'],
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
  const bad = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'x', '--data', 'findings=3'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /must be JSON/)

  const array = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--phase', 'x', '--data', '[1,2]'],
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
