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
//        --input verdicts.json [--input more.json …] [--targets routed.json] \
//        [--malformed-tasks-corrected N]
//
// `--targets`는 `prepare-verification.mjs`의 출력이다. 판정을 받지 못한 후보를
// **개수가 아니라 ID로** 가려내므로, 대상 밖 후보의 판정이 빠진 대상을 가리지 못한다.
//
// 입력은 `REVIEW_VERDICT_CONTRACT_V1` payload 하나, 그 배열, 또는 `{ "tasks": [ … ] }`다.
// 파일로 받는 이유는 `prepare-verification.mjs --input`과 같다 — 산문과 코드 인용이
// 든 payload를 셸 인용부호 하나에 넣는 구조는 깨지는 쪽이 정상이다.

import { readFileSync } from 'node:fs'

import { lastPhase, logPhase, requireStartedTimeline } from './lib/run-record.mjs'

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
 * 검증 대상 후보 ID를 `prepare-verification.mjs` 출력에서 읽는다.
 *
 * 개수만 맞추면 **다른 후보가 누락을 가린다.** 대상이 A·B인데 verdict가 A·X로
 * 오면 대상 2 · 판정 2 · `noVerdict` 0이 되어 검사를 통과하고, 정작 B는 사라진다.
 * 집합으로 보면 B가 빠졌다는 것과 X가 대상 밖이라는 것이 동시에 드러난다.
 *
 * `route: 'none'`은 검증 대상이 아니다 — 띄우지 않은 것을 "판정을 못 받았다"로
 * 세면 정상 실행마다 값이 부풀고, 그 수치는 아무것도 가리키지 못한다.
 */
export function targetIds(routed) {
  const ids = new Set()
  for (const entry of routed?.candidates ?? []) {
    if (typeof entry?.candidateId !== 'string') continue
    if (entry.route === 'none') continue
    ids.add(entry.candidateId)
  }
  return ids
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
  return { ...counts, total: latest.size, reverdicted, judged: new Set(latest.keys()) }
}

const dir = flag('dir')
const run = flag('run')
const sidecar = requireStartedTimeline(dir, run)

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

/**
 * 판정을 받지 못한 후보 수도 센다.
 *
 * 2026-09-18 실행이 검증 대상 16건을 잡고 판정 13건을 남겼다. 나머지 3건은
 * verifier가 두 차례 타임아웃해 판정이 없었는데, **그 사실이 리포트 산문에만
 * 있고 기록에는 없었다.** 사이드카만 읽으면 3건이 증발한 것으로 보인다.
 *
 * 대상 수는 이미 `prepare-verification.mjs`가 결정적으로 내서 `script.done`에
 * 들어 있으므로, 여기서 뺄셈만 하면 된다 — 모델에게 다시 세게 하지 않는다.
 * 대상 수를 못 읽으면 필드를 만들지 않는다. **0과 미측정은 다르다.**
 */
const targetsPath = flag('targets')
let noVerdict
let weakNote

if (targetsPath !== undefined) {
  // ID로 본다. 빠진 것과 대상 밖의 것이 함께 드러난다.
  let routed
  try {
    routed = JSON.parse(readFileSync(targetsPath, 'utf8'))
  } catch (error) {
    die(`--targets를 읽지 못했다: ${targetsPath} — ${error.message}`)
  }
  const targets = targetIds(routed)
  if (!targets.size) die(`--targets에 검증 대상이 없다: ${targetsPath} — prepare-verification.mjs의 출력을 넘긴다`)

  const strays = [...counts.judged].filter(id => !targets.has(id))
  if (strays.length) {
    die(`검증 대상이 아닌 후보의 판정이 있다: ${strays.join(', ')}. 대상 밖 판정을 세면 빠진 대상이 그 수에 가려진다`)
  }
  noVerdict = [...targets].filter(id => !counts.judged.has(id)).length
} else {
  // 대상 수만 보고 뺄셈한다. **다른 ID가 누락을 가릴 수 있다** — 그 한계를
  // 기록에 남긴다. 숫자만 보면 두 방식의 결과가 같아 보이기 때문이다.
  const targeted = lastPhase(sidecar, 'script.done')?.counts?.verify
  if (Number.isInteger(targeted)) {
    noVerdict = Math.max(0, targeted - counts.total)
    weakNote = 'noVerdict는 대상 수와의 뺄셈이다. --targets 없이는 후보 ID 불일치를 잡지 못한다'
  }
}

logPhase(dir, run, 'crossverify.end', {
  upheld: counts.upheld,
  rejected: counts.rejected,
  needsContext: counts.needsContext,
  ...(noVerdict === undefined ? {} : { noVerdict }),
  ...(malformedTasksCorrected === undefined ? {} : { malformedTasksCorrected }),
  countsFrom: 'tally-verdicts.mjs',
  ...(weakNote === undefined ? {} : { note: weakNote }),
})

// `judged`는 집합 차이를 내려고 들고 다닌 것이라 stdout에는 싣지 않는다.
// `JSON.stringify`가 Set을 `{}`로 내보내 호출자에게 빈 값처럼 보이기 때문이다.
const { judged: _judged, ...reported } = counts
process.stdout.write(`${JSON.stringify({ ...reported, ...(noVerdict === undefined ? {} : { noVerdict }) }, null, 2)}\n`)
