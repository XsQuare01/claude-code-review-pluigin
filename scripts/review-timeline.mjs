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
const BOOL_FLAGS = new Set(['summary'])
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
  if (finalPhase !== 'run.end') {
    out.push('', events.some(event => event.phase === 'run.end')
      ? `> **\`run.end\` 뒤에 줄이 더 있다.** 마지막 줄은 \`${finalPhase}\`다. 종료가 마지막 자리에 있지 않으므로 실행이 어디서 끝났는지 이 기록만으로는 알 수 없다.`
      : `> **\`run.end\`가 없다.** 마지막으로 남은 단계는 \`${finalPhase}\`이고, 실행은 거기서 끝나지 않았다.`)
  }
  // 사용량은 표 아래 한 줄로 따로 낸다. 상세 칸에만 두면 긴 JSON 사이에 묻혀
  // 아무도 안 읽는다 — 기록해두고 읽히지 않는 것은 기록하지 않은 것과 같다.
  {
    const end = events.find(event => event.phase === 'run.end') ?? {}
    const sum = key => events.reduce((total, event) => total + (typeof event[key] === 'number' ? event[key] : 0), 0)
    const tokensIn = typeof end.tokensIn === 'number' ? end.tokensIn : sum('tokensIn')
    const tokensOut = typeof end.tokensOut === 'number' ? end.tokensOut : sum('tokensOut')

    if (tokensIn || tokensOut) {
      const parts = [`입력 ${tokensIn.toLocaleString()}`, `출력 ${tokensOut.toLocaleString()}`]
      if (typeof end.tokensCacheRead === 'number') parts.push(`캐시 읽기 ${end.tokensCacheRead.toLocaleString()}`)
      // 금액은 구독 실행에서 청구액이 아니라 정가 환산이다. 그대로 "비용"이라
      // 부르지 않도록 출처와 함께만 낸다.
      if (typeof end.costUsd === 'number') parts.push(`정가 환산 $${end.costUsd}`)
      out.push('', `**토큰** ${parts.join(' · ')}${end.usageSource ? ` (출처: ${end.usageSource})` : ''}`)
    } else if (end.usageSource === 'unavailable') {
      out.push('', '> **사용량을 재지 못했다.** 0이 아니라 관측되지 않았다는 뜻이다.')
    }
  }
  if (malformed) out.push('', `> 읽지 못한 줄 ${malformed}개.`)
  process.stdout.write(out.join('\n') + '\n')
  process.exit(0)
}

const phase = flag('phase')
if (!phase) die('--phase is required')

/**
 * 값을 받는 세 가지 길.
 *
 * `--data`만 있던 때, 실제 실행에서 두 번 연속 깨졌다. Windows 경로의
 * 백슬래시와 한글이 섞인 JSON을 PowerShell 명령줄로 넘기려다 이렇게 됐다:
 *
 *   --data must be JSON, got "{\"path\":\"C:\\\\\\\\Users\\\\\\\\bhmun\\\\..."
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

const { events } = readLines()
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
