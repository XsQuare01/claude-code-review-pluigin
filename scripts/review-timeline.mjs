#!/usr/bin/env node
// 리뷰가 스스로 "지금 어디를 지나고 있는지"를 한 줄씩 남긴다.
//
// 왜 리포트가 아니라 사이드카인가: 리포트 안에 타임라인을 쓰면 **렌더 단계가
// 죽는 순간 타임라인도 같이 사라진다** — 정확히 알고 싶은 그 순간에. 실제로
// 2026-06부터 3개월간 "30분 걸리고 파일이 생성되지 않음"이 반복됐는데, 어느
// 단계에서 멈췄는지 아무 데도 남지 않아 매번 처음부터 추측했다.
//
// 왜 모델이 직접 쓰지 않는가: 모델에게는 시계가 없다. 타임스탬프를 문장으로
// 적게 하면 그것은 측정이 아니라 기억이다. 이 스크립트가 시각을 만들고,
// 경과 시간도 여기서 계산한다 — 리포트의 산술을 모델이 눈으로 세지 않는다는
// 이 저장소의 원칙과 같은 이유다.
//
// Usage — 값을 넘기는 길이 셋이다. 셸을 가리지 않는 --set을 먼저 쓴다.
//
//   review-timeline.mjs --dir review-reports --run <리포트 basename> --phase render.start --set findings=47
//   review-timeline.mjs --dir ... --run ... --phase dispatch.end --data-file payload.json
//   review-timeline.mjs --dir ... --run ... --phase render.start --data '{"findings":47}'
//   review-timeline.mjs --dir ... --run ... --summary
//   review-timeline.mjs --dir ... --run ... --check     종료 직전, 기록 자체를 검사
//
// --set은 따옴표도 중괄호도 쓰지 않는다. PowerShell에서 --data의 JSON이 두 번
// 깨져 기록을 잃은 뒤에 추가했다 — 자세한 사정은 아래 data 블록 주석에 있다.
//
// 파일은 `<dir>/.timing/<run>.jsonl`이고 **append 전용**이다. 이미 쓴 줄은
// 고치지 않는다 — 고치면 죽은 실행의 마지막 줄이 무엇이었는지 믿을 수 없다.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const die = message => {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  if (at === -1) return fallback
  const value = process.argv[at + 1]
  if (value === undefined || value.startsWith('--')) die(`--${name} needs a value`)
  return value
}
const has = name => process.argv.includes(`--${name}`)

// 같은 플래그를 여러 번 받는다. flag()는 첫 값만 읽으므로 --set에는 쓸 수 없다.
const flagAll = name => process.argv
  .map((arg, at) => (arg === `--${name}` ? process.argv[at + 1] : null))
  .filter(value => value !== null && value !== undefined && !value.startsWith('--'))

/**
 * 소비되지 않은 인자를 거부한다.
 *
 * 값에 공백이 있으면 셸이 거기서 쪼갠다 — PowerShell에서 `--set note=검토 완료`는
 * `["--set", "note=검토", "완료"]`가 되고, 남은 `완료`는 어디에도 안 쓰인다.
 * 그것을 조용히 무시하면 **잘린 값이 기록되고 아무도 모른다.** 기록을 남기는
 * 도구에서 가장 나쁜 실패 방식이라, 인용을 잊었으면 시끄럽게 실패시킨다.
 */
const VALUE_FLAGS = new Set(['dir', 'run', 'phase', 'data', 'data-file', 'set'])
const BOOL_FLAGS = new Set(['summary', 'check'])
{
  const argv = process.argv.slice(2)
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at]
    if (!arg.startsWith('--')) {
      die(`unexpected argument ${JSON.stringify(arg)} — 값에 공백이 있으면 따옴표로 감싸라`)
    }
    const name = arg.slice(2)
    if (BOOL_FLAGS.has(name)) continue
    if (!VALUE_FLAGS.has(name)) die(`unknown flag ${arg}`)
    const value = argv[at + 1]
    if (value === undefined || value.startsWith('--')) die(`${arg} needs a value`)
    at += 1
  }
}

const dir = flag('dir', 'review-reports')
const run = flag('run')
if (!run) die('usage: review-timeline.mjs --dir <reports-dir> --run <basename> --phase <name> [--data <json>]')
// 경로 구분자가 들어오면 파일이 엉뚱한 데 생긴다. 리포트 basename만 받는다.
if (/[\\/]/.test(run)) die(`--run must be a bare basename, got ${JSON.stringify(run)}`)

const timingDir = join(dir, '.timing')
const path = join(timingDir, `${run}.jsonl`)

/** 이미 쓴 줄을 읽는다. 깨진 줄은 세지 않되 조용히 버리지도 않는다. */
const readLines = () => {
  if (!existsSync(path)) return { events: [], malformed: 0 }
  const events = []
  let malformed = 0
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      malformed += 1
    }
  }
  return { events, malformed }
}

/**
 * 닫힌 phase 목록과 payload 계약. C-9의 표가 정본이고 여기가 그 표의 실행판이다.
 *
 * 왜 스크립트가 이름을 검사하는가: 표에 "아래 이름만 쓴다"고 적어 두어도, 한
 * 실행이 `verification.prepared`·`final.audit`·`report.saved`를 자체로 지어 쓰고
 * `render.start`·`render.wrote`를 남기지 않았다. 그 실행은 완주해서 드러나지
 * 않았지만, 문서를 쓰다 죽었다면 마지막 줄이 `synthesis.end`로 남아 "synthesis에서
 * 멈췄다"로 오독됐을 것이다. **읽는 쪽이 알던 이름을 못 찾았을 때 그것이 "안
 * 일어났다"인지 "다르게 불렀다"인지 구분할 수 없다**는 것이 이 검사의 이유다.
 *
 * `required`는 없으면 **경고**다. 줄을 거부하면 그 단계의 기록이 통째로 사라지는데,
 * 필드 하나 빠진 기록이 없는 기록보다 낫다. `structured`는 **거부**다 — 중첩 값을
 * `--set` 한 값으로 밀어 넣으면 `counts=total=5,verify=2`가 문자열 하나로 남아
 * 집계가 불가능해지고, 그것이 조용히 통과하면 아무도 고치지 않는다.
 *
 * `tool.start`가 `script.start`와 같은 이유로 있다. 한 실행이 lint·typecheck·test·
 * targeted-test 넷을 돌리고 `tool.done` 넷을 **같은 초에** 찍었다 — 앞 단계와의
 * 간격은 442초였고, 그 442초가 넷 중 어느 도구의 것인지 기록 어디에도 없었다.
 * 끝만 남기면 여러 개를 연달아 돌린 구간이 통째로 하나의 이름 없는 덩어리가 된다.
 */
const PHASES = new Map([
  ['run.start', { required: ['host', 'rules', 'version', 'branch', 'changedFiles'], structured: [], allowed: ['candidates', 'workflow', 'mergeBase', 'os'] }],
  ['scope.done', { required: ['files', 'excluded'], structured: [], allowed: [] }],
  ['modules.planned', { required: ['candidates', 'applied'], structured: ['skipped', 'unknown'], allowed: [] }],
  ['dispatch.start', { required: ['modules', 'inflight'], structured: [], allowed: [] }],
  ['module.start', { required: ['module', 'attempt'], structured: [], allowed: ['taskId', 'retryOf'] }],
  ['module.done', { required: ['module', 'attempt', 'status'], structured: [], allowed: ['findings', 'failureClass', 'taskId'] }],
  ['dispatch.end', { required: ['terminalOk', 'terminalFailed', 'attemptsTotal', 'attemptsFailed'], structured: ['attemptFailureClasses'], allowed: [] }],
  ['script.start', { required: [], structured: [], allowed: ['script'] }],
  ['script.done', { required: ['ran'], structured: ['counts'], allowed: [] }],
  ['tool.start', { required: ['name'], structured: [], allowed: [] }],
  ['tool.done', { required: ['name', 'exit', 'treeSha'], structured: ['failing'], allowed: ['failedNow', 'failedBaseline'] }],
  ['crossverify.start', { required: ['targets'], structured: [], allowed: [] }],
  ['crossverify.end', { required: ['upheld', 'rejected'], structured: [], allowed: ['needsContext', 'malformedTasksCorrected', 'countsFrom'] }],
  ['synthesis.start', { required: [], structured: [], allowed: ['findings'] }],
  ['synthesis.end', { required: [], structured: [], allowed: ['clusters'] }],
  ['render.start', { required: ['findings'], structured: [], allowed: [] }],
  ['render.wrote', { required: ['path', 'lines'], structured: [], allowed: [] }],
  ['run.end', { required: ['verdict'], structured: [], allowed: ['usageSource', 'costUsd', 'tokensCacheRead'] }],
])

/**
 * 어느 단계에서든 쓸 수 있는 필드.
 *
 * `note`는 append-only 기록에서 앞 줄을 고치지 않고 바로잡는 유일한 길이다 —
 * 실제로 한 실행이 `crossverify.end`를 잘못 세고, 줄을 고치는 대신 다음 줄에
 * `note`로 정정했다. 토큰은 C-9가 "있으면 적는다"로 둔 값이라 단계를 가리지 않는다.
 */
const ALWAYS_ALLOWED = new Set(['note', 'tokensIn', 'tokensOut'])

/**
 * 필드 이름도 닫는다.
 *
 * phase 이름만 닫아 두었더니 2026-09-11 실행이 `crossverify.end`에
 * `malformedCorrected`를 지어 넣었다. 계약 어디에도 없는 이름이고, 더 나쁜 것은
 * **단위가 없다**는 것이다 — verdict를 센 것인지 verifier task를 센 것인지
 * 리포트 본문을 읽어야 알 수 있었다. `dispatch.end`의 `ok`/`failed`에서 이미 한 번
 * 겪은 실패이고, 그때 계약이 내린 결론이 "세는 단위를 이름에 담는다"였다.
 *
 * 이름을 거부하지는 않는다. 기록을 남기려는 줄을 필드 이름 때문에 버리면
 * 그 단계가 통째로 사라진다 — `failureClass`와 같은 처리다.
 */
const undeclaredKeys = (phase, data) => {
  const spec = PHASES.get(phase)
  if (!spec) return []
  const known = new Set([...spec.required, ...spec.structured, ...(spec.allowed ?? [])])
  return Object.keys(data).filter(key => !known.has(key) && !ALWAYS_ALLOWED.has(key))
}

/**
 * 실패 클래스도 닫힌 목록이다.
 *
 * phase 이름만 닫아 두었더니 실패 클래스가 실행마다 새로 지어졌다. 문서에 정의된
 * 것은 둘뿐인데 기록에는 `inactivity-timeout`·`poll-timeout`·`malformed-corrected`·
 * `explore-provider-model-not-found`가 나타났고, 그중 어느 것이 최종 실패인지가
 * 이름만으로 갈리지 않았다.
 *
 * 이름이 틀렸다고 줄을 거부하지는 않는다 — 실패를 기록하려는 줄을 실패 이름 때문에
 * 버리는 것은 앞뒤가 맞지 않는다. append에서는 경고하고 `--check`가 짚는다.
 */
const FAILURE_CLASSES = new Set([
  'none', 'malformed-corrected',
  'no-start', 'task-not-found', 'inactivity-timeout', 'queue-expiry', 'empty-result',
  'skill-injection-invalid', 'malformed-output', 'provider-model-not-found', 'poll-timeout',
  'unknown',
])

/**
 * 모듈 시도를 구간으로 접는다. **끝나지 않은 시도도 구간으로 낸다.**
 *
 * 처음에는 끝난 시도만 셌다. 그랬더니 `module.start` 넷을 남기고 죽은 실행에서
 * 구간이 0개가 되어 디스패치 요약이 통째로 사라지고, 30분짜리 최장 구간이
 * "돌고 있던 모듈이 기록에 없다"로 적혔다 — 셋이 돌고 있었는데. **죽은 실행에서
 * 가장 조용해지는 계측은 존재 이유와 정반대다.** 열린 구간은 마지막으로 관측된
 * 시각까지의 **최소** 시간으로 두고, 추정이라는 사실을 `open`으로 들고 다닌다.
 *
 * 구간의 단위는 모듈이 아니라 **시도**다. 재시도한 모듈은 구간이 둘이고, 그것을
 * 모듈 둘로 세면 C-9가 애써 나눠 둔 "최종 모듈 단위"와 "시도 단위"가 다시 섞인다.
 */
const attemptSpans = events => {
  if (!events.length) return []
  const lastSeen = new Date(events[events.length - 1].at).getTime()
  const opened = new Map()
  const spans = []
  for (const event of events) {
    const at = new Date(event.at).getTime()
    const key = `${event.module}#${event.attempt ?? '?'}`
    if (event.phase === 'module.start') opened.set(key, { from: at, module: String(event.module) })
    if (event.phase === 'module.done' && opened.has(key)) {
      const start = opened.get(key)
      spans.push({ from: start.from, to: at, module: start.module, open: false })
      opened.delete(key)
    }
  }
  for (const start of opened.values()) {
    spans.push({ from: start.from, to: Math.max(lastSeen, start.from), module: start.module, open: true })
  }
  return spans.sort((a, b) => a.from - b.from)
}

/**
 * 도구 실행을 시작·끝 쌍으로 접는다.
 *
 * **이름의 유일성으로 짝짓지 않는다.** C-6은 baseline과 현재를 각각 재라고 하므로
 * 같은 `lint`가 두 트리에서 두 번 도는 것이 정상이고, "이름마다 한 번"으로 짝지으면
 * 정상 실행을 중복으로 부른다. 열린 시작을 큐로 들고 먼저 열린 것부터 닫으면
 * 그 경우가 따로 다룰 것 없이 풀린다.
 *
 * 시작 없이 끝만 있는 것은 **이 계약이 `tool.start`를 넣은 이유 그 자체**다 —
 * 끝만 넷 남은 기록에서 442초가 어느 도구의 것인지 갈리지 않았다.
 */
const toolRuns = events => {
  const open = new Map()
  const runs = []
  const orphanDone = []
  for (const event of events) {
    if (event.phase !== 'tool.start' && event.phase !== 'tool.done') continue
    const at = new Date(event.at).getTime()
    const name = String(event.name)
    if (event.phase === 'tool.start') {
      if (!open.has(name)) open.set(name, [])
      open.get(name).push(at)
      continue
    }
    const queue = open.get(name)
    if (queue && queue.length) {
      runs.push({ name, from: queue.shift(), to: at, exit: event.exit })
    } else {
      runs.push({ name, from: null, to: at, exit: event.exit })
      orphanDone.push({ name, seq: event.seq })
    }
  }
  const unfinished = []
  for (const [name, queue] of open) {
    for (const from of queue) {
      runs.push({ name, from, to: null, exit: undefined })
      unfinished.push(name)
    }
  }
  return { runs, orphanDone, unfinished }
}

/**
 * 종료 직전에 기록 자체를 검사한다.
 *
 * `--summary`는 리포트에 실을 표를 만드는 것이고 이쪽은 **기록이 쓸 만한지**를
 * 묻는다. 둘을 나눈 이유는 요약이 사람 눈에 들어가는 것이라 경고를 섞으면 표가
 * 지저분해지고, 반대로 경고만 필요할 때 표를 만들 이유가 없기 때문이다.
 *
 * 종료 코드는 0(문제 없음) / 1(기록에 문제) / 2(사용법)로 나눈다 — 호출부가
 * "돌리다 실패"와 "돌려 보니 문제"를 구분해야 한다.
 */
if (has('check')) {
  const problems = []
  const notes = []

  if (!existsSync(path)) {
    process.stderr.write(`사이드카가 없다: ${path}\nC-9는 첫 sub-agent보다 먼저 run.start를 남기라고 한다. 남기지 못했으면 리포트의 \`실행 타임라인\` 섹션에 그 사실을 적어라.\n`)
    process.exit(1)
  }

  const { events, malformed } = readLines()
  if (!events.length) {
    process.stderr.write(`사이드카가 비었다: ${path}\n`)
    process.exit(1)
  }

  const unknown = [...new Set(events.map(event => event.phase).filter(name => !PHASES.has(name)))]
  if (unknown.length) problems.push(`표에 없는 단계 이름: ${unknown.join(', ')}. 실행마다 이름이 달라지면 실행 간 비교가 불가능해진다`)

  const missing = []
  for (const event of events) {
    const spec = PHASES.get(event.phase)
    if (!spec) continue
    const absent = spec.required.filter(key => event[key] === undefined)
    if (absent.length) missing.push(`\`${event.phase}\`(seq ${event.seq}) → ${absent.join(', ')}`)
  }
  if (missing.length) problems.push(`필수 필드가 빠진 줄: ${missing.join(' / ')}`)

  const first = events[0]
  if (first.phase !== 'run.start') problems.push(`첫 줄이 \`run.start\`가 아니라 \`${first.phase}\`다. 어느 버전·어느 규칙으로 돌았는지가 기록에 없다`)

  const finalPhase = events[events.length - 1].phase
  if (finalPhase !== 'run.end') {
    problems.push(events.some(event => event.phase === 'run.end')
      ? `\`run.end\` 뒤에 줄이 더 있다. 마지막 줄은 \`${finalPhase}\`다`
      : `\`run.end\`가 없다. 마지막으로 남은 단계는 \`${finalPhase}\`이고 실행은 거기서 끝나지 않았다`)
  }

  // 후보 수는 두 자리에 적힌다. 어긋나면 한쪽이 세다가 틀린 것이고, 실제로 한
  // 리포트가 후보를 20개가 아니라 21개로 적었다 — synthesis 전용 모듈을 후보로
  // 세면서. 산술을 모델이 눈으로 세지 않는다는 원칙이 여기서도 같다.
  const startedWith = events.find(event => event.phase === 'run.start')?.candidates
  const planned = events.find(event => event.phase === 'modules.planned')?.candidates
  if (startedWith !== undefined && planned !== undefined && startedWith !== planned) {
    problems.push(`후보 수가 어긋난다: \`run.start\`는 ${startedWith}, \`modules.planned\`는 ${planned}`)
  }

  const invented = []
  for (const event of events) {
    if (!PHASES.has(event.phase)) continue
    const { at: _at, seq: _seq, sinceStartSec: _since, phase: _phase, ...rest } = event
    const keys = undeclaredKeys(event.phase, rest)
    if (keys.length) invented.push(`\`${event.phase}\`(seq ${event.seq}) → ${keys.join(', ')}`)
  }
  if (invented.length) problems.push(`표에 없는 필드 이름: ${invented.join(' / ')}. 이름이 실행마다 달라지면 무엇을 센 값인지 기록만으로 알 수 없다`)

  const badClasses = [...new Set(events
    .map(event => event.failureClass)
    .filter(value => value !== undefined && !FAILURE_CLASSES.has(value)))]
  if (badClasses.length) {
    problems.push(`표에 없는 failureClass: ${badClasses.join(', ')}. 쓸 수 있는 값은 C-9의 표에 있다`)
  }

  // 같은 모듈·같은 시도가 두 번 끝났으면 재시도인지 중복 기록인지 알 수 없다.
  // 시도마다 한 쌍이라는 정규형이 지켜졌는지를 여기서 본다.
  const seenAttempts = new Set()
  const doubled = new Set()
  for (const event of events) {
    if (event.phase !== 'module.done') continue
    const key = `${event.module}#${event.attempt ?? '?'}`
    if (seenAttempts.has(key)) doubled.add(key)
    seenAttempts.add(key)
  }
  if (doubled.size) {
    problems.push(`같은 모듈·시도가 두 번 끝났다: ${[...doubled].join(', ')}. 재시도는 \`attempt\`를 올려 남긴다`)
  }

  // fan-out 증거는 자동으로 남길 수 없다 — 이 플러그인은 task launcher를 갖고
  // 있지 않다. 그래서 강제하지 못하고 **사후에 짚는** 것까지가 여기서 할 수 있는
  // 전부다. 경고로 두는 이유는 이것만으로 실행을 실패로 부를 수 없기 때문이다.
  const applied = events.find(event => event.phase === 'modules.planned')?.applied
  const finished = new Set(events.filter(event => event.phase === 'module.done').map(event => String(event.module)))
  if (Number.isInteger(applied) && finished.size !== applied) {
    notes.push(`\`modules.planned.applied\`는 ${applied}인데 \`module.done\`이 남은 모듈은 ${finished.size}개다`)
  }

  // fan-out 기록이 **한 줄도** 없는 것은 위의 수 불일치와 다른 사건이다.
  //
  // 위 검사는 `modules.planned`가 있어야 돈다. 그 줄까지 없는 실행에서는
  // `applied`가 undefined라 아무 말도 나오지 않았고, 실제로 2026-09-18 실행이
  // `run.start` 다음에 곧장 `script.start`를 찍고 그 사이 1863초를 비운 채
  // `--check`를 통과했다. 같은 플러그인 버전·같은 harness의 전날 실행은 같은
  // 자리에 47줄을 남겼으므로 **일은 일어났고 기록만 빠진 것**인데, 기록만 보면
  // 그 1863초에 무엇이 있었는지 말할 수 없다. 이것이 C-9가 막으려던 바로 그
  // 상태이므로 경고가 아니라 문제로 짚는다.
  //
  // **띄울 모듈이 있었는지를 `applied`로 판정한다.** 계획 줄이 있기만 하면
  // fan-out을 예상하도록 두었더니 `applied: 0`인 기록 — 적용할 모듈이 하나도
  // 없다고 스스로 적은 정상 실행 — 이 디스패치 누락으로 실패했다. 없는 것을
  // 빠뜨렸다고 부르면 경보가 늘 울리고, 늘 울리는 경보는 신호가 아니다.
  // 계획 줄이 없을 때만 `run.start`의 후보 수로 물러선다.
  const DISPATCH_EVIDENCE = ['dispatch.start', 'module.start', 'module.done', 'dispatch.end']
  const POST_DISPATCH = ['script.start', 'script.done', 'crossverify.start', 'crossverify.end', 'render.start', 'render.wrote', 'run.end']
  const candidates = events.find(event => event.phase === 'run.start')?.candidates
  const plannedAny = events.some(event => event.phase === 'modules.planned')
  const someCandidates = Number.isInteger(candidates) && candidates > 0
  const expectedFanOut = plannedAny
    ? (Number.isInteger(applied) ? applied > 0 : someCandidates)
    : someCandidates
  const reachedAfter = events.find(event => POST_DISPATCH.includes(event.phase))
  if (expectedFanOut && reachedAfter && !events.some(event => DISPATCH_EVIDENCE.includes(event.phase))) {
    problems.push(`디스패치 기록이 한 줄도 없다: \`${DISPATCH_EVIDENCE.join('`/`')}\` 중 아무것도 없이 \`${reachedAfter.phase}\`(seq ${reachedAfter.seq})까지 갔다. 모듈이 언제 몇 개 돌았는지가 기록에 없으므로 그 사이 시간은 귀속 불가다`)
  }

  // 두 줄 사이가 비어 있으면 그 시간에 무엇이 있었는지 기록으로 말할 수 없다.
  // 경보가 아니라 **수치**로 낸다 — 정상 실행에도 최장 구간은 늘 하나 있고,
  // 늘 울리는 경보는 신호가 아니다. 리포트가 이 값을 그대로 옮기면 "어디서
  // 오래 걸렸나"에 체감이 아니라 숫자로 답하게 된다.
  //
  // **돌고 있던 모듈 수를 함께 낸다.** 모듈 넷이 나란히 도는 동안에는 줄이 안
  // 남는 것이 정상이고, 그 구간을 "기록이 비었다"로만 부르면 진짜 빈 구간과
  // 구분되지 않는다. 09-17 실행의 최장 656초는 모듈 4개가 도는 중이었고,
  // 09-18 실행의 최장 1863초는 아무것도 돌고 있지 않은 것으로 **기록됐다** —
  // 둘을 같은 문장으로 부르면 뒤쪽이 묻힌다. 열린 시도도 인플라이트로 센다.
  //
  // **한 개가 아니라 최대 세 개를 낸다.** 09-18 실행에서 1위는 1863초였고 2위는
  // 442초(전체의 17%)였는데, 1위만 내면 2위가 그 뒤에 가린다. 실제로 그 리포트는
  // 442초 구간을 한 번도 언급하지 않았다. 2·3위는 전체의 10% 이상일 때만 낸다 —
  // 정상 실행에서 잔구간까지 줄줄이 내면 읽히지 않는다.
  if (events.length > 1) {
    const msOf = event => new Date(event.at).getTime()
    const span = msOf(events[events.length - 1]) - msOf(events[0])
    const spans = attemptSpans(events)
    // 도구가 도는 동안에도 줄은 안 남는다. 그 구간까지 "돌고 있던 모듈이 기록에
    // 없다"로 적으면 **아무 일도 없었다**로 읽히는데, 이 계약이 442초를 귀속하려고
    // `tool.start`를 넣은 바로 그 구간이 그렇게 적힌다.
    const running = toolRuns(events).runs.filter(one => one.from !== null && one.to !== null)
    const overlap = (list, from, to) => list.filter(one => one.from < to && one.to > from).length
    const gaps = []
    for (let at = 1; at < events.length; at += 1) {
      const from = msOf(events[at - 1])
      const to = msOf(events[at])
      const sec = Math.round((to - from) / 1000)
      if (sec <= 0) continue
      gaps.push({
        sec,
        share: span > 0 ? Math.round((sec * 1000 * 100) / span) : 0,
        from: events[at - 1].phase,
        to: events[at].phase,
        modules: overlap(spans, from, to),
        tools: overlap(running, from, to),
      })
    }
    gaps.sort((a, b) => b.sec - a.sec)
    const shown = gaps.filter((gap, at) => at === 0 || gap.share >= 10).slice(0, 3)
    shown.forEach((gap, at) => {
      const busy = [gap.modules && `모듈 ${gap.modules}개`, gap.tools && `도구 ${gap.tools}개`].filter(Boolean)
      notes.push(`${at === 0 ? '가장 긴 무기록 구간' : `그 다음 ${at + 1}위`} ${gap.sec}s (전체의 ${gap.share}%): \`${gap.from}\` → \`${gap.to}\` — ${
        busy.length ? `${busy.join('와 ')}가 그 사이 돌고 있었다` : '돌고 있던 것이 기록에 없다'}`)
    })
  }

  // 도구는 시작과 끝이 짝을 이뤄야 한다.
  //
  // `tool.start`를 닫힌 목록에 넣는 것만으로는 아무것도 강제되지 않는다 —
  // 끝만 넷 남긴 기록이 그대로 통과하고, 442초를 귀속할 수 없던 상태가 그대로
  // 재발한다. 이름으로 짝짓지 않는 이유는 `toolRuns`에 적어 두었다.
  {
    const tools = toolRuns(events)
    if (tools.orphanDone.length) {
      problems.push(`\`tool.start\` 없이 끝난 도구: ${tools.orphanDone.map(one => `\`${one.name}\`(seq ${one.seq})`).join(', ')}. 끝만 남기면 앞 단계와의 간격이 어느 도구의 것인지 갈리지 않는다`)
    }
    if (tools.unfinished.length) {
      notes.push(`끝을 남기지 않은 도구 ${tools.unfinished.length}개: ${tools.unfinished.map(name => `\`${name}\``).join(', ')}`)
    }
  }

  if (malformed) notes.push(`읽지 못한 줄 ${malformed}개`)

  const out = []
  out.push(problems.length ? `FAIL ${path}` : `OK ${path}`)
  out.push(`이벤트 ${events.length}개, 마지막 \`${finalPhase}\``)
  for (const problem of problems) out.push(`  - ${problem}`)
  for (const note of notes) out.push(`  · ${note}`)
  process.stdout.write(out.join('\n') + '\n')
  process.exit(problems.length ? 1 : 0)
}

if (has('summary')) {
  const { events, malformed } = readLines()
  if (!events.length) die(`타임라인이 비었다: ${path}`)

  const started = new Date(events[0].at).getTime()
  const rows = events.map((event, at) => {
    const now = new Date(event.at).getTime()
    const previous = at === 0 ? now : new Date(events[at - 1].at).getTime()
    const { at: _at, seq, sinceStartSec, phase, ...rest } = event
    return {
      phase,
      elapsed: Math.round((now - started) / 1000),
      step: Math.round((now - previous) / 1000),
      detail: Object.keys(rest).length ? JSON.stringify(rest) : '',
    }
  })

  // 가장 오래 걸린 구간을 표시한다. 표를 눈으로 훑어 찾게 하면 그 판단이
  // 리포트에 "체감"으로 들어간다.
  const slowest = rows.reduce((worst, row) => (row.step > worst.step ? row : worst), rows[0])

  const out = [
    '| 단계 | 경과 | 구간 | 상세 |',
    '|---|---:|---:|---|',
    ...rows.map(row => `| \`${row.phase}\`${row === slowest && row.step > 0 ? ' **←최장**' : ''} | ${row.elapsed}s | ${row.step}s | ${row.detail} |`),
  ]
  // 끝 표시를 **마지막 자리에서** 찾는다. 있기만 하면 통과시키면, 종료 뒤에
  // 줄이 더 붙은 실행을 정상 종료로 읽는다 — 실제로 기록 실패 때문에 순서가
  // 밀려 그런 타임라인이 만들어진 적이 있다. 없는 것과 자리에 없는 것은 다르다.
  const finalPhase = events[events.length - 1].phase
  const ended = events.some(event => event.phase === 'run.end')
  if (finalPhase === 'render.start') {
    // C-7은 이 표를 `render.start` 직후, `render.wrote`와 `run.end`를 적기 전에
    // 만들라고 한다. 그 자리에서 종료 줄이 없는 것은 사고가 아니라 순서다.
    // 그런데도 경보를 찍으면 **계약을 지킨 실행마다** 뜨고, 실제로 한 실행은
    // 그 경보 밑에 "이것이 정상"이라는 문단을 손으로 붙여 리포트에 실었다.
    // 늘 울리는 경보는 신호가 아니다.
    out.push('', `> 이 표는 \`render.start\` 시점까지의 기록이다. \`render.wrote\`와 \`run.end\`는 이 표를 만든 뒤에 기록되므로 여기 없다 — 빠진 것이 아니라 아직 일어나지 않은 것이다.${
      ended ? ' 앞선 `run.end`는 이 렌더를 고쳐 쓴 것이므로, 렌더 뒤에 다시 적어 마지막 자리를 되찾는다.' : ''
    } 실행 전체의 정본은 사이드카다.`)
  } else if (finalPhase !== 'run.end') {
    out.push('', ended
      ? `> **\`run.end\` 뒤에 줄이 더 있다.** 마지막 줄은 \`${finalPhase}\`다. 종료가 마지막 자리에 있지 않으므로 실행이 어디서 끝났는지 이 기록만으로는 알 수 없다.`
      : `> **\`run.end\`가 없다.** 마지막으로 남은 단계는 \`${finalPhase}\`이고, 실행은 거기서 끝나지 않았다.`)
  }

  // `←최장`이 **그 단계의 소요**로 읽힌다.
  //
  // 구간 칸은 앞 줄과 이 줄 사이의 시간인데, 표시는 줄 하나에 붙는다. 한 리포트가
  // `script.start`에 1863초가 찍힌 표를 그대로 싣고 본문에서 그 시간을 언급하지
  // 않았다 — `script.start`는 스크립트 진입 직후에 찍히므로 그 자체는 0초이고,
  // 1863초는 **그 앞의 아무 기록도 없는 구간**이었다. 시작 표시에 붙은 최장
  // 구간은 "여기까지 오는 데"라고 읽어야 한다.
  if (slowest && slowest.step > 0 && /\.start$/.test(slowest.phase)) {
    out.push('', `> \`←최장\`은 앞 줄과 \`${slowest.phase}\` **사이**의 ${slowest.step}s이고, \`${slowest.phase}\`가 그만큼 걸렸다는 뜻이 아니다. 그 사이에 남은 기록이 없으므로 무엇이 그 시간을 썼는지는 이 표로 알 수 없다.`)
  }

  // 디스패치의 모양. 합계와 벽시계가 따로 있어야 "느렸다"와 "놀았다"가 갈린다.
  //
  // 왜 스크립트가 세는가: 2026-09-17 실행의 모듈 합계는 5587초인데 벽시계는
  // 1962초였고, 그 차이를 사람이 47줄에서 눈으로 복원해야 했다. 더 중요한 것은
  // **인플라이트가 0으로 떨어진 지점이 여섯 번**이라는 사실이다 — 4개씩 띄우고
  // 넷이 모두 끝나기를 기다린 모양이고, 스킬은 정확히 그것을 하지 말라고 적어
  // 두었다. 지시는 적혀 있었고 지켜지지 않았으며, 아무도 그것을 몰랐다.
  // 사후 탐지가 이 플러그인이 할 수 있는 전부이므로 여기서 한다.
  {
    const spans = attemptSpans(events)
    if (spans.length) {
      const seconds = ms => Math.round(ms / 1000)
      const lastDone = spans.reduce((last, span) => Math.max(last, span.to), spans[0].to)
      const wall = lastDone - spans[0].from
      const attemptMs = spans.reduce((sum, span) => sum + (span.to - span.from), 0)
      const unfinished = spans.filter(span => span.open).length
      const modules = new Set(spans.map(span => span.module)).size

      // 겹치는 구간을 합쳐 **하나라도 돌고 있던** 시간을 낸다. 벽시계에서 그것을
      // 빼면 슬롯이 통째로 빈 시간이 남는다 — 그것이 배리어의 값이다.
      //
      // 새 wave의 기준을 `>=`가 아니라 `>`로 둔다. 같은 타임스탬프로 인계되는
      // 것은 슬롯이 빈 것이 아니다 — 재시도가 앞 시도의 종료와 같은 초에 시작한
      // 기록에서 "인플라이트가 1번 0으로 떨어졌다, 유휴 0s"라는 **자기모순적인**
      // 경고가 나왔다. 배리어가 아닌 것을 배리어로 세면 이 수치 전체를 못 믿는다.
      let busy = 0
      let waves = 0
      let cursor = -Infinity
      let waveEnd = -Infinity
      for (const span of spans) {
        if (span.from > waveEnd) waves += 1
        busy += Math.max(0, span.to - Math.max(span.from, cursor))
        cursor = Math.max(cursor, span.to)
        waveEnd = Math.max(waveEnd, span.to)
      }
      const idle = Math.max(0, wall - busy)

      // 동시에 열려 있던 시도의 최대치. 상한에 닿았는지를 기록만으로 말할 수 있게
      // 한다 — 실효 동시가 낮은 것이 상한 때문인지 배리어 때문인지가 여기서 갈린다.
      const edges = spans.flatMap(span => [{ at: span.from, delta: 1 }, { at: span.to, delta: -1 }])
        .sort((a, b) => (a.at - b.at) || (a.delta - b.delta))
      let live = 0
      let peak = 0
      for (const edge of edges) {
        live += edge.delta
        peak = Math.max(peak, live)
      }

      out.push('', `**디스패치** 모듈 ${modules}개 · 시도 ${spans.length}개(완료 ${spans.length - unfinished} · 미완료 ${unfinished}) · 합 ${
        seconds(attemptMs)}s · 벽시계 ${seconds(wall)}s · 실효 동시 ${wall > 0 ? (attemptMs / wall).toFixed(2) : '—'} · 최대 동시 ${peak} · 슬롯 유휴 ${seconds(idle)}s`)
      if (unfinished) {
        out.push('', `> **끝을 남기지 않은 시도가 ${unfinished}개다.** 그 구간은 마지막 기록 시각까지의 **최소** 관측 시간으로 셌으므로, 합계와 실효 동시는 실제보다 작다. 시도가 정말 그때 끝났다는 뜻이 아니다.`)
      }
      if (waves > 1) {
        out.push('', `> **인플라이트가 ${waves - 1}번 0으로 떨어졌다** (연속 구간 ${waves}개). 한 모듈이 끝나면 즉시 다음을 넣으라는 규칙대로면 구간은 하나다. 비어 있는 동안 ${seconds(idle)}s가 쌓였다.`)
      }
    }
  }

  // 도구별 몫. `tool.start`를 넣은 목적이 여기서 눈에 보이는 값이 된다 —
  // 넷을 연달아 돌린 442초가 각각 몇 초였는지를 뺄셈으로 낸다. 모듈 이벤트가
  // 사이에 끼어도 상관없다. 짝은 이름이 아니라 열린 시작의 큐로 맞춘다.
  {
    const { runs } = toolRuns(events)
    if (runs.length) {
      const describe = one => {
        if (one.from === null) return `\`${one.name}\` 시작 기록 없음(exit ${one.exit ?? '?'})`
        if (one.to === null) return `\`${one.name}\` 끝 기록 없음`
        return `\`${one.name}\` ${Math.round((one.to - one.from) / 1000)}s(exit ${one.exit ?? '?'})`
      }
      out.push('', `**도구** ${runs.map(describe).join(' · ')}`)
    }
  }

  // 사용량. 표 상세 칸에만 두면 긴 JSON 사이에 묻혀 아무도 안 읽으므로 따로 낸다.
  //
  // 이 블록은 "숫자를 보여주는" 것이 아니라 **무엇을 근거로 그 숫자를 말하는지**를
  // 함께 내는 것이 목적이다. 어떤 패스를 덜어낼지 정하는 데 쓰일 값이라, 부분
  // 합계를 전체처럼 보이면 잘못된 것을 덜어내게 된다.
  {
    // 토큰은 음수도 소수도 아니다. 그렇지 않은 값은 없는 것으로 본다 —
    // 조용히 0으로 더하면 부분 합계가 전체처럼 보이는 바로 그 문제가 된다.
    const count = value => (Number.isInteger(value) && value >= 0 ? value : null)
    const usageOf = event => {
      const tokensIn = count(event.tokensIn)
      const tokensOut = count(event.tokensOut)
      return tokensIn === null && tokensOut === null ? null : { tokensIn, tokensOut, event }
    }
    const show = value => (value === null ? '미측정' : value.toLocaleString())

    // 마지막 run.end를 쓴다. 기록이 밀려 다시 적힌 경우 **나중 것이 정본**이고,
    // 앞의 것을 집으면 오래된 값을 전체 총량으로 내놓는다.
    let lastEnd = null
    for (let at = events.length - 1; at >= 0; at -= 1) {
      if (events[at].phase === 'run.end') { lastEnd = events[at]; break }
    }
    const endIsFinal = events[events.length - 1].phase === 'run.end'
    const total = lastEnd ? usageOf(lastEnd) : null

    // 단계별 사용량. 모듈만이 아니라 덜어낼 후보가 되는 단계 전부를 본다 —
    // 교차검증이 값을 하는지 물으려면 그 단계의 몫이 따로 있어야 한다.
    const STAGES = ['module.done', 'dispatch.end', 'script.done', 'crossverify.end', 'synthesis.end', 'render.wrote']
    const stages = events.filter(event => STAGES.includes(event.phase)).map(usageOf).filter(Boolean)
    const stageTotal = key => stages.reduce((sum, item) => sum + (item[key] ?? 0), 0)
    const stagesComplete = stages.length > 0 && stages.every(item => item.tokensIn !== null && item.tokensOut !== null)

    const extras = []
    if (lastEnd && Number.isFinite(lastEnd.tokensCacheRead)) extras.push(`캐시 읽기 ${lastEnd.tokensCacheRead.toLocaleString()}`)
    // 금액은 구독 실행에서 청구액이 아니라 정가 환산이다. "비용"으로 읽히지
    // 않도록 이름을 붙여서만 낸다.
    if (lastEnd && Number.isFinite(lastEnd.costUsd)) extras.push(`정가 환산 $${lastEnd.costUsd}`)
    const source = lastEnd?.usageSource ? ` (출처: ${lastEnd.usageSource})` : ''

    if (total) {
      // **필드가 있으면 낸다.** 0/0도 측정 결과다 — truthy로 거르면 실제로 0을
      // 쓴 실행이 "재지 못한" 실행과 같은 모습이 된다.
      out.push('', `**토큰** 입력 ${show(total.tokensIn)} · 출력 ${show(total.tokensOut)}${extras.length ? ` · ${extras.join(' · ')}` : ''}${source}`)
      if (!endIsFinal) {
        out.push('', '> **이 총량은 최종이 아닐 수 있다.** `run.end`가 마지막 줄이 아니므로 그 뒤의 사용량은 포함되지 않았다.')
      }
      if (stages.length) {
        const attributedIn = stageTotal('tokensIn')
        const unattributed = total.tokensIn === null ? null : total.tokensIn - attributedIn
        out.push('', `단계별 입력 합계 ${attributedIn.toLocaleString()} (${stages.length}개 단계)${
          unattributed === null ? '' : ` · 단계에 귀속되지 않은 ${unattributed.toLocaleString()}`}`)
      }
    } else if (stages.length) {
      // 전체 총량이 없다. 단계 합계는 **부분 합계**이고, 그렇게 부른다.
      out.push('', `**토큰(부분 합계)** 입력 ${stageTotal('tokensIn').toLocaleString()} · 출력 ${stageTotal('tokensOut').toLocaleString()}`)
      out.push('', `> **전체 총량이 아니다.** ${stages.length}개 단계만 사용량을 보고했고 \`run.end\`에는 총량이 없다.${
        stagesComplete ? '' : ' 보고한 단계 중에도 입력·출력 한쪽이 빠진 것이 있다.'} 이 값으로 두 실행을 비교하지 않는다.`)
    } else if (lastEnd?.usageSource === 'unavailable') {
      out.push('', '> **사용량을 재지 못했다.** 0이 아니라 관측되지 않았다는 뜻이다.')
    }
  }
  // 같은 이름의 필드가 줄마다 다른 타입이면 짚는다.
  //
  // `--set`은 원문으로 되돌아오는 값만 숫자로 두므로 `module=01`은 문자열,
  // `module=11`은 숫자가 된다. 그러면 모듈별로 묶거나 두 실행을 비교할 때
  // `"11"`과 `11`이 서로 다른 것으로 읽힌다. 계약은 이름을 적으라고 하지만
  // 지시는 지켜지지 않을 수 있어서, 섞인 결과를 여기서 보이게 한다.
  {
    const types = new Map()
    for (const event of events) {
      for (const [key, value] of Object.entries(event)) {
        if (value === null) continue
        if (!types.has(key)) types.set(key, new Set())
        types.get(key).add(typeof value)
      }
    }
    const mixed = [...types].filter(([, kinds]) => kinds.size > 1).map(([key, kinds]) => `\`${key}\`(${[...kinds].join('/')})`)
    if (mixed.length) {
      out.push('', `> **타입이 섞인 필드가 있다:** ${mixed.join(', ')}. 같은 필드를 줄마다 다른 형으로 적으면 묶거나 비교할 때 어긋난다.`)
    }
  }
  if (malformed) out.push('', `> 읽지 못한 줄 ${malformed}개.`)
  process.stdout.write(out.join('\n') + '\n')
  process.exit(0)
}

const phase = flag('phase')
if (!phase) die('--phase is required')
// 표에 없는 이름은 거부한다. 표에 없는 일을 남겨야 하면 이름을 짓지 말고 가장
// 가까운 단계의 `--set` 필드로 적는다 — 이름이 정말 부족하면 표를 고치는 것이
// 순서다 (C-9).
if (!PHASES.has(phase)) {
  die(`--phase ${JSON.stringify(phase)}는 C-9의 닫힌 목록에 없다. 쓸 수 있는 이름: ${[...PHASES.keys()].join(', ')}`)
}

/**
 * 값을 받는 세 가지 길.
 *
 * `--data`만 있던 때, 실제 실행에서 두 번 연속 깨졌다. Windows 경로의
 * 백슬래시와 한글이 섞인 JSON을 PowerShell 명령줄로 넘기려다 이렇게 됐다:
 *
 *   --data must be JSON, got "{\"path\":\"C:\\\\\\\\Users\\\\\\\\<user>\\\\..."
 *   --data must be JSON, got "{yellow:25,verdict:MERGE BLOCKED,...}"
 *
 * 두 번째는 따옴표가 통째로 사라져 JSON도 아니게 된 모습이다. 기록을 남기라고
 * 만든 도구가 **기록을 못 남기게 하는 셸 문제**를 갖고 있었던 것이고, 그 사이에
 * 다음 단계가 먼저 기록돼 이벤트 순서까지 뒤집혔다.
 *
 * 그래서 셸 인용을 아예 통과하지 않는 길을 둔다.
 *
 *   --set lines=694 --set verdict=MERGE_BLOCKED     따옴표도 중괄호도 없다
 *   --data-file payload.json                        중첩 값이 필요할 때
 *   --data '{"lines":694}'                          종전 방식, bash에서는 그대로
 *
 * 셋을 함께 주면 --data → --data-file → --set 순으로 덮어쓴다. 명령줄에 직접
 * 쓴 것이 파일보다 뒤에 오는 이유는, 급히 한 값만 바꿔 다시 돌리는 쪽이
 * 파일을 고치는 쪽보다 흔하기 때문이다.
 */
/**
 * BOM과 UTF-16을 견디며 텍스트를 읽는다.
 *
 * 이 경로는 PowerShell의 JSON 인용 문제를 피하려고 만든 것인데, 정작 PowerShell
 * 5.1이 만드는 파일을 못 읽으면 아무 소용이 없다. `Set-Content -Encoding UTF8`은
 * **BOM을 붙이고**, 기본 `Out-File`은 **UTF-16LE**로 쓴다. 둘 다 JSON.parse가
 * 첫 글자에서 실패한다.
 *
 * UTF-16BE는 Node 디코더가 없어 바이트를 뒤집어 LE로 읽는다.
 */
const readTextFile = path => {
  const bytes = readFileSync(path)
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.toString('utf16le').replace(/^﻿/, '')
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes)
    swapped.swap16()
    return swapped.toString('utf16le').replace(/^﻿/, '')
  }
  return bytes.toString('utf8').replace(/^﻿/, '')
}

const parseObject = (raw, where) => {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    die(`${where} must be JSON, got ${JSON.stringify(String(raw).slice(0, 120))}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) die(`${where} must be a JSON object`)
  return parsed
}

const data = (() => {
  const merged = {}

  const raw = flag('data')
  if (raw) Object.assign(merged, parseObject(raw, '--data'))

  // 바깥의 `path`는 사이드카 파일을 가리킨다. 같은 이름을 쓰면 바로 아래에서
  // 다른 뜻으로 읽히므로 이름을 나눈다.
  const dataFile = flag('data-file')
  if (dataFile) {
    if (!existsSync(dataFile)) die(`--data-file not found: ${dataFile}`)
    Object.assign(merged, parseObject(readTextFile(dataFile), '--data-file'))
  }

  for (const pair of flagAll('set')) {
    const at = pair.indexOf('=')
    if (at < 1) die(`--set must be key=value, got ${JSON.stringify(pair)}`)
    const key = pair.slice(0, at)
    const value = pair.slice(at + 1)
    // 숫자로 **되돌아오는** 값만 숫자로 둔다. 왕복이 같지 않으면 문자열이다.
    //
    // 처음에는 Number()로 읽히기만 하면 숫자로 바꿨는데, 그것이 식별자를
    // 망가뜨렸다: `module=01`이 `1`이 되고 `taskId=001`도 `1`이 됐다. 모듈
    // 번호와 task ID는 세는 값이 아니라 가리키는 값이라, 앞의 0이 사라지면
    // 무엇을 가리키는지가 사라진다. `1e3`·`0x10`도 원문과 다른 것으로 바뀐다.
    //
    // `String(Number(v)) === v`는 그 셋을 전부 걸러내면서 694·41·1.5는 통과시킨다.
    const asNumber = Number(value)
    merged[key] = value === 'true' ? true
      : value === 'false' ? false
      : value === 'null' ? null
      : value !== '' && Number.isFinite(asNumber) && String(asNumber) === value ? asNumber
      : value
  }

  return merged
})()

{
  const spec = PHASES.get(phase)
  // 중첩이어야 하는 값이 스칼라로 오면 거부한다. `--set counts=total=5,verify=2`는
  // 첫 `=`에서만 잘리므로 값 전체가 문자열 하나로 남고, 그렇게 기록된 다섯 수치는
  // 다시 꺼낼 수 없다. 실제로 한 실행의 `script.done`이 그 모습으로 남았다.
  const flattened = spec.structured.filter(key => key in data && (data[key] === null || typeof data[key] !== 'object'))
  if (flattened.length) {
    die(`\`${phase}\`의 ${flattened.join(', ')}는 중첩 값이다. \`--set\`은 첫 =에서만 자르므로 값이 문자열 하나로 남는다 — \`--data-file <경로>\`로 넘겨라`)
  }
  // 빠진 필수 필드는 경고만 한다. 줄을 거부하면 그 단계가 통째로 사라지는데,
  // 필드 하나 빠진 기록이 없는 기록보다 낫다. `--check`가 종료 전에 다시 짚는다.
  const absent = spec.required.filter(key => data[key] === undefined)
  if (absent.length) {
    process.stderr.write(`경고: \`${phase}\`에 ${absent.join(', ')}가 없다 (C-9 표가 요구한다)\n`)
  }
  // 실패를 기록하려는 줄을 실패 이름 때문에 버리지는 않는다. 이름만 짚는다.
  if (data.failureClass !== undefined && !FAILURE_CLASSES.has(data.failureClass)) {
    process.stderr.write(`경고: failureClass ${JSON.stringify(data.failureClass)}는 C-9의 닫힌 목록에 없다. 쓸 수 있는 값: ${[...FAILURE_CLASSES].join(', ')}\n`)
  }
  const undeclared = undeclaredKeys(phase, data)
  if (undeclared.length) {
    const usable = [...spec.required, ...spec.structured, ...(spec.allowed ?? []), ...ALWAYS_ALLOWED]
    process.stderr.write(`경고: \`${phase}\`의 ${undeclared.join(', ')}는 C-9의 닫힌 목록에 없다. 쓸 수 있는 이름: ${usable.join(', ')}\n`)
  }
}

const { events } = readLines()

// 끝난 타임라인에 새 실행을 이어붙이지 않는다.
//
// 파일 이름은 리포트 basename이고 그것은 날짜까지만 담는다. 같은 날 같은
// 브랜치를 두 번 리뷰하면 **두 실행이 한 파일에 섞인다** — 단계가 두 벌씩
// 들어가고, 합계는 두 실행의 합이 되고, 어느 줄이 어느 실행인지 가릴 수 없다.
// 토큰을 줄이려면 같은 대상을 반복해서 재야 하므로, 하필 그 용도에서 가장
// 먼저 깨진다.
if (phase === 'run.start' && events.length && events[events.length - 1].phase === 'run.end') {
  die(`이미 끝난 타임라인이다(${path}). 새 실행은 다른 --run 이름으로 남겨라 — 같은 파일에 이어붙이면 두 실행이 섞인다`)
}

const at = new Date()
const startedAt = events.length ? new Date(events[0].at) : at

mkdirSync(timingDir, { recursive: true })
// 시각·순번·경과를 **여기서** 만든다. 호출자가 같은 이름으로 값을 넘겨도
// 버린다 — 측정한 값과 주장한 값이 같은 자리에 있으면, 나중에 읽는 사람이
// 둘을 구분할 방법이 없다.
const MEASURED = new Set(['at', 'seq', 'sinceStartSec', 'phase'])
const claimed = Object.fromEntries(Object.entries(data).filter(([key]) => !MEASURED.has(key)))
const line = JSON.stringify({
  at: at.toISOString(),
  seq: events.length + 1,
  sinceStartSec: Math.round((at.getTime() - startedAt.getTime()) / 1000),
  phase,
  ...claimed,
})
appendFileSync(path, line + '\n', 'utf8')
process.stdout.write(line + '\n')
