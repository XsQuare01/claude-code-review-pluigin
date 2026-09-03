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
  // 끝 표시가 없으면 그 사실을 적는다. 없는 것과 0은 다르다.
  if (!events.some(event => event.phase === 'run.end')) {
    out.push('', `> **\`run.end\`가 없다.** 마지막으로 남은 단계는 \`${events[events.length - 1].phase}\`이고, 실행은 거기서 끝나지 않았다.`)
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
    Object.assign(merged, parseObject(readFileSync(dataFile, 'utf8'), '--data-file'))
  }

  for (const pair of flagAll('set')) {
    const at = pair.indexOf('=')
    if (at < 1) die(`--set must be key=value, got ${JSON.stringify(pair)}`)
    const key = pair.slice(0, at)
    const value = pair.slice(at + 1)
    // 숫자로 읽히는 값은 숫자로 둔다. "694"와 694가 섞이면 나중에 세는 쪽이
    // 형을 맞추느라 또 한 번 틀린다. true/false/null도 같은 이유로 되돌린다.
    merged[key] = value === '' ? ''
      : value === 'true' ? true
      : value === 'false' ? false
      : value === 'null' ? null
      : Number.isFinite(Number(value)) ? Number(value)
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
