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
// Usage:
//   node "$RULES_DIR/../scripts/review-timeline.mjs" \
//     --dir review-reports --run code-review-full-feat-x-2026-09-01 \
//     --phase render.start --data '{"findings":47}'
//
//   node "$RULES_DIR/../scripts/review-timeline.mjs" \
//     --dir review-reports --run <같은 이름> --summary
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

const data = (() => {
  const raw = flag('data')
  if (!raw) return {}
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    die(`--data must be JSON, got ${JSON.stringify(raw)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) die('--data must be a JSON object')
  return parsed
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
