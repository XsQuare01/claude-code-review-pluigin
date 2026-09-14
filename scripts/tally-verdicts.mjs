#!/usr/bin/env node
// 교차검증 결과를 세고, 그 수치를 직접 기록에 남긴다.
//
// 왜 있는가: 2026-09-11 실행이 `crossverify.end`를 `upheld:13, rejected:3`으로
// 적고 44초 뒤 `upheld:12, rejected:4`로 정정했다. 후보 수·검증 대상 수는 이미
// `prepare-verification.mjs`가 결정적으로 내는데, **검증 결과만 모델이 눈으로
// 세고 있었다.** 계약이 후보 수에 대해 한 논증이 여기에도 그대로 적용된다 —
// 숫자가 맞더라도 그것이 결정적으로 계산된 것인지 읽는 쪽은 알 수 없다.
//
// 세는 일이 어려운 이유는 합산이 아니라 **재판정**이다. bundle verifier가
// `needs-context`로 돌린 후보는 isolated verifier로 승격돼 다시 판정된다. 두 줄을
// 다 세면 total이 부풀고, 앞 줄을 세면 뒤집힌 판정을 놓친다.
//
// Usage:
//   node scripts/tally-verdicts.mjs --dir <리포트 디렉터리> --run <리포트 basename> \
//        --input verdicts.json [--input more.json …] [--malformed-tasks-corrected N]
//
// 입력은 `REVIEW_VERDICT_CONTRACT_V1` payload 하나, 그 배열, 또는 `{ "tasks": [ … ] }`다.
// 파일로 받는 이유는 `prepare-verification.mjs --input`과 같다 — 산문과 코드 인용이
// 든 payload를 셸 인용부호 하나에 넣는 구조는 깨지는 쪽이 정상이다.

import { readFileSync } from 'node:fs'

import { logPhase, requireStartedTimeline } from './lib/run-record.mjs'

// C-6B의 닫힌 목록이다. 목록 밖 값을 만나면 세지 않고 멈춘다 — 모르는 값을 0으로
// 흘려보내면 합계는 그럴듯하고 판정만 틀린다.
const DISPOSITIONS = new Map([
  ['upheld', 'upheld'],
  ['rejected', 'rejected'],
  ['needs-context', 'needsContext'],
])

const die = message => {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}

const flagAll = name => process.argv
  .map((arg, at) => (arg === `--${name}` ? process.argv[at + 1] : null))
  .filter(value => value !== null && value !== undefined)

/**
 * payload가 어떤 모양으로 오든 verdict 목록 하나로 편다.
 *
 * 검증 패스는 작업을 여러 개 띄우고 각자 payload를 낸다. 그 여러 벌을 합치는
 * 일이 곧 모델이 하던 일이고, 틀렸던 자리다.
 */
export function collectVerdicts(payloads) {
  const verdicts = []
  const walk = value => {
    if (Array.isArray(value)) { value.forEach(walk); return }
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value.verdicts)) { verdicts.push(...value.verdicts); return }
    if (Array.isArray(value.tasks)) { value.tasks.forEach(walk); return }
    die(`verdicts도 tasks도 없는 payload다: ${JSON.stringify(Object.keys(value))}`)
  }
  walk(payloads)
  return verdicts
}

/**
 * 후보별 마지막 판정만 센다.
 *
 * 순서가 곧 정본 순서다 — `--input`을 준 순서대로 읽으므로, 승격된 isolated
 * 판정이 bundle 판정보다 뒤에 온다. 뒤집힌 건수는 따로 낸다: 재판정이 몇 건
 * 있었는지는 라우팅이 제대로 돌았는지 보는 신호다.
 */
export function tally(verdicts) {
  const latest = new Map()
  let reverdicted = 0
  for (const verdict of verdicts) {
    const id = verdict?.candidateId
    if (typeof id !== 'string' || !id) {
      die(`candidateId 없는 verdict가 있다. 무엇을 센 값인지 말할 수 없으므로 세지 않는다: ${JSON.stringify(verdict)}`)
    }
    if (!DISPOSITIONS.has(verdict.disposition)) {
      die(`disposition ${JSON.stringify(verdict.disposition)}는 C-6B의 닫힌 목록에 없다. 쓸 수 있는 값: ${[...DISPOSITIONS.keys()].join(', ')}`)
    }
    if (latest.has(id)) reverdicted += 1
    latest.set(id, verdict.disposition)
  }

  const counts = { upheld: 0, rejected: 0, needsContext: 0 }
  for (const disposition of latest.values()) counts[DISPOSITIONS.get(disposition)] += 1
  return { ...counts, total: latest.size, reverdicted }
}

const dir = flag('dir')
const run = flag('run')
requireStartedTimeline(dir, run)

const inputs = flagAll('input')
if (!inputs.length) die('--input <경로>가 필요하다. 검증 작업이 낸 verdict payload를 파일로 넘긴다')

const payloads = inputs.map(path => {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    die(`--input을 읽지 못했다: ${path} — ${error.message}`)
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    die(`${path} is not valid JSON: ${error.message}`)
  }
})

const counts = tally(collectVerdicts(payloads))

// 교정 횟수는 verdict payload가 모르는 값이다 — 그것은 dispatch 쪽 사실이라
// 호출자가 넘긴다. 이름에 **세는 단위**를 담는다: verdict가 아니라 task 수다.
const corrected = flag('malformed-tasks-corrected')
const malformedTasksCorrected = corrected === undefined ? undefined : Number(corrected)
if (corrected !== undefined && !Number.isInteger(malformedTasksCorrected)) {
  die(`--malformed-tasks-corrected는 정수여야 한다: ${JSON.stringify(corrected)}`)
}

logPhase(dir, run, 'crossverify.end', {
  upheld: counts.upheld,
  rejected: counts.rejected,
  needsContext: counts.needsContext,
  ...(malformedTasksCorrected === undefined ? {} : { malformedTasksCorrected }),
  countsFrom: 'tally-verdicts.mjs',
})

process.stdout.write(`${JSON.stringify(counts, null, 2)}\n`)
