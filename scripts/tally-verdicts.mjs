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

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { markedJson } from './lib/contract-blocks.mjs'
import { validateVerdictPayload } from './lib/contract-validate.mjs'
import { lastPhase, logPhase, requireStartedTimeline } from './lib/run-record.mjs'
import { checkTaskVerdict, collectVerdicts } from './lib/verdicts.mjs'
import { buildRetryPrompt } from './lib/verifier-tasks.mjs'

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

const noteText = parts => {
  const present = parts.filter(part => typeof part === 'string' && part.trim())
  return present.length ? present.join(' · ') : undefined
}

const flagAll = name => process.argv
  .map((arg, at) => (arg === `--${name}` ? process.argv[at + 1] : null))
  .filter(value => value !== null && value !== undefined)

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
const collectMode = process.argv.includes('--collect')
const validateMode = process.argv.includes('--validate')
const targetsPath = flag('targets')
if ((collectMode || validateMode) && inputs.length) die('--collect·--validate와 --input을 함께 줄 수 없다. 작업별 판정 파일을 모으거나 판정 파일을 직접 넘긴다')
if (collectMode && validateMode) die('--collect와 --validate는 따로 돌린다. --validate로 형식을 고친 뒤 --collect로 센다')
if ((collectMode || validateMode) && targetsPath === undefined) {
  die(`${collectMode ? '--collect' : '--validate'}에는 --targets <prepare-verification 출력>이 필요하다 — 어느 작업의 판정 파일을 어떤 순서로 읽을지가 거기 있다`)
}
if (!collectMode && !validateMode && !inputs.length) die('--input <경로>가 필요하다. 검증 작업이 낸 verdict payload를 파일로 넘긴다')

const readJson = (path, what) => {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    die(`${what}을 읽지 못했다: ${path} — ${error.message}`)
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    die(`${path} is not valid JSON: ${error.message}`)
  }
}

const routed = targetsPath === undefined ? undefined : readJson(targetsPath, '--targets')

// 계약 검사에 쓰는 manifest는 규칙 문서에서 읽는다. 기본은 이 스크립트와 같은
// 플러그인의 것이고, `--rules`를 주면 검증자가 받은 그 디렉터리를 쓴다.
const manifests = () => {
  const rulesDir = flag('rules') ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'review-rules')
  let contract
  try {
    contract = readFileSync(join(rulesDir, 'workflow-contract.md'), 'utf8')
  } catch (error) {
    die(`workflow-contract.md를 읽지 못했다: ${rulesDir} — ${error.message}`)
  }
  const verdict = markedJson(contract, 'REVIEW_VERDICT_CONTRACT_V1')
  const result = markedJson(contract, 'REVIEW_RESULT_CONTRACT_V1')
  if (verdict.error) die(`workflow-contract.md: ${verdict.error}`)
  if (result.error) die(`workflow-contract.md: ${result.error}`)
  return payload => validateVerdictPayload(payload, verdict.value, result.value)
}

// 작업 목록 — bundle, isolated, 그다음 승격 순서가 정본 순서다.
// 승격 작업은 `promotions[<candidateId>]`로 오므로 맡긴 후보는 그 키 하나다.
const tasksOf = plan => [
  ...(plan?.verifierTasks ?? []).map(task => ({ ...task, promotion: false })),
  ...Object.entries(plan?.promotions ?? {}).map(([candidateId, task]) => ({ ...task, candidateIds: [candidateId], promotion: true })),
]
const retryPathOf = task => task.prompt.replace(/\.md$/, '.retry.md')

/**
 * 작업별 판정 파일을 계약과 요청에 맞춰 본다.
 *
 * 형식을 어긴 작업마다 교정 프롬프트(`<taskId>.retry.md`)를 만든다 — 원래 지시에
 * 오류 목록과 직전 응답 원문을 붙인 것이다. 오케스트레이터는 그 파일 내용을 그대로
 * 새 검증자에게 넘기고, 돌아온 JSON으로 같은 판정 파일을 덮어쓴다. 기록에는 아무것도
 * 남기지 않는다 — 검사일 뿐이고, 교차검증의 끝은 `--collect`가 남긴다.
 */
const validateTasks = plan => {
  const validate = manifests()
  const malformed = []
  let checked = 0
  for (const task of tasksOf(plan)) {
    if (!existsSync(task.verdict)) continue
    checked += 1
    const raw = readFileSync(task.verdict, 'utf8')
    const ids = task.candidateIds
    const { problems } = checkTaskVerdict(raw, ids, validate)
    if (!problems) continue
    const original = existsSync(task.prompt) ? readFileSync(task.prompt, 'utf8') : ''
    const retryPrompt = retryPathOf(task)
    writeFileSync(retryPrompt, buildRetryPrompt(original, problems, raw), 'utf8')
    malformed.push({ taskId: task.taskId, problems, retryPrompt })
  }
  return { checked, malformed }
}

if (validateMode) {
  const report = validateTasks(routed)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exit(report.malformed.length ? 1 : 0)
}

/**
 * `prepare-verification.mjs`가 정한 자리에서 판정 파일을 모은다.
 *
 * 순서가 곧 정본 순서다 — bundle 작업, isolated 작업, 그다음 승격 작업. 승격은
 * bundle이 `needs-context`로 돌린 후보를 다시 판정한 것이므로 반드시 bundle 뒤에
 * 와야 한다. 판정 파일이 없는 작업은 검증자가 결과를 내지 못한 것이다 — 실패로
 * 멈추지 않고(C-6B: verification-unavailable) 어느 작업인지 알린다. 승격 작업은
 * 필요할 때만 띄우므로 파일이 없는 것이 정상이다.
 */
const collectFromTasks = plan => {
  const validate = manifests()
  const found = []
  const missing = []
  const malformed = []
  let corrected = 0
  for (const task of tasksOf(plan)) {
    if (existsSync(retryPathOf(task))) corrected += 1
    if (!existsSync(task.verdict)) {
      if (!task.promotion) missing.push(task.taskId)
      continue
    }
    const ids = task.candidateIds
    const { payload, problems } = checkTaskVerdict(readFileSync(task.verdict, 'utf8'), ids, validate)
    // 교정 뒤에도 계약을 어긴 판정은 세지 않는다(C-6A: 두 번째 malformed-output은
    // 확정 실패다). 그 후보는 판정 없음으로 남고, 차단은 C-6B대로 fail-open이다.
    if (problems) malformed.push(task.taskId)
    else found.push(payload)
  }
  return { found, missing, malformed, corrected }
}

let payloads
let verdictsFile
let correctedByFiles
if (collectMode) {
  const { found, missing, malformed, corrected } = collectFromTasks(routed)
  if (missing.length) {
    process.stderr.write(`경고: 판정 파일이 없는 검증 작업 ${missing.length}개: ${missing.join(', ')} — 그 후보는 판정 없음(noVerdict)으로 센다\n`)
  }
  if (malformed.length) {
    process.stderr.write(`경고: 계약을 어긴 판정 파일 ${malformed.length}개를 세지 않았다: ${malformed.join(', ')} — --validate로 교정 프롬프트를 만들 수 있다. 교정 뒤에도 어겼다면 그 후보는 판정 없음(noVerdict)이다\n`)
  }
  correctedByFiles = corrected
  payloads = found
  // 렌더러는 판정 파일을 `--verdicts`로 받는다. 여러 파일을 순서대로 넘기게 하면
  // 순서를 다시 사람이 정하게 되므로, 모은 순서 그대로 한 파일에 남긴다.
  verdictsFile = join(dir, '.timing', `${run}.verdicts.json`)
  writeFileSync(verdictsFile, `${JSON.stringify({ tasks: payloads }, null, 2)}\n`, 'utf8')
} else {
  payloads = inputs.map(path => readJson(path, '--input'))
}

// 판정 파일을 읽는 규칙은 렌더러와 같은 함수 하나다(`lib/verdicts.mjs`). 여기서만
// 받아 주는 모양이 생기면, 여기서 센 판정을 렌더러가 못 읽는 일이 다시 생긴다.
let verdicts
try {
  verdicts = collectVerdicts(payloads)
} catch (error) {
  die(`${collectMode ? '작업별 판정 파일' : inputs.join(', ')}: ${error.message}`)
}
const counts = tally(verdicts)

// 교정 횟수는 verdict payload가 모르는 값이다 — 그것은 dispatch 쪽 사실이라
// 호출자가 넘긴다. 이름에 **세는 단위**를 담는다: verdict가 아니라 task 수다.
// `--collect`는 교정 프롬프트 파일(`<taskId>.retry.md`)이 있는 작업을 교정한 작업으로
// 센다. 손으로 넘긴 값이 있으면 그것을 쓴다.
const corrected = flag('malformed-tasks-corrected') ?? (correctedByFiles === undefined ? undefined : String(correctedByFiles))
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
let noVerdict
let weakNote

if (routed !== undefined) {
  // ID로 본다. 빠진 것과 대상 밖의 것이 함께 드러난다.
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

// `--note`는 다시 센 이유다. 교차검증의 끝이 두 번 남으면 `--check`는 `note`가
// 있는 두 번째 끝만 정정으로 받는다 — 없으면 판정을 다시 받은 것으로 읽는다.
const note = noteText([flag('note'), weakNote])

logPhase(dir, run, 'crossverify.end', {
  upheld: counts.upheld,
  rejected: counts.rejected,
  needsContext: counts.needsContext,
  ...(noVerdict === undefined ? {} : { noVerdict }),
  ...(malformedTasksCorrected === undefined ? {} : { malformedTasksCorrected }),
  countsFrom: 'tally-verdicts.mjs',
  ...(note === undefined ? {} : { note }),
})

// `judged`는 집합 차이를 내려고 들고 다닌 것이라 stdout에는 싣지 않는다.
// `JSON.stringify`가 Set을 `{}`로 내보내 호출자에게 빈 값처럼 보이기 때문이다.
const { judged: _judged, ...reported } = counts
process.stdout.write(`${JSON.stringify({
  ...reported,
  ...(noVerdict === undefined ? {} : { noVerdict }),
  ...(verdictsFile === undefined ? {} : { verdictsFile }),
}, null, 2)}\n`)
