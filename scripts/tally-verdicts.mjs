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

import { lastPhase, logPhase, readEvents, requireStartedTimeline } from './lib/run-record.mjs'
import { MAX_ATTEMPTS, attemptsOf, budgetOf, foldAttempts, haltOf, isTerminal, segmentOf, taskState } from './lib/task-ledger.mjs'
import { checkTaskVerdict, collectVerdicts, loadVerdictValidator } from './lib/verdicts.mjs'
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
  try {
    return loadVerdictValidator(rulesDir)
  } catch (error) {
    die(error.message)
  }
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
 *
 * **남은 일도 함께 낸다.** 판정 파일이 없는 작업(`pending`)과, bundle이 `needs-context`로
 * 돌렸는데 승격 판정이 아직 없는 후보(`promotionsDue`)다. `fix/anchor-vector-direction`
 * 실행(2026-09-30)은 검증자 하나가 context 압축 직전에 떠서 끝나지 않았고, 호스트는 띄운
 * 작업이 전부 끝나야 오케스트레이터를 깨웠다 — 웨이브마다 멈춰 17건에 37시간이 걸렸고,
 * 무엇이 남았는지는 오케스트레이터의 기억에만 있었다. 판정 파일 자리는 이미 정해져
 * 있으므로 남은 일은 파일에서 센다. `ready`는 넷이 모두 비었을 때만 참이고, 그때만 0으로 끝난다.
 *
 * **작업 대장(C-12)의 기록이 있으면 그것을 먼저 본다.** 판정 파일이 없다는 것만으로는 "아직 안
 * 띄웠다"와 "돌고 있다"와 "다 시도했지만 못 받았다"가 갈리지 않는다. 앞의 둘을 같은 `pending`으로
 * 내면 돌고 있는 작업을 다시 띄우고, 셋째를 `pending`으로 두면 `ready`가 영영 오지 않는다 — 시도를
 * 다 쓴 작업이 교정 차례로 계속 남던 것이 PR #87 리뷰의 P1이었다. 그래서 돌고 있는 작업은 `running`,
 * 시도를 다 썼거나 취소된 작업은 `exhausted`(집계를 막지 않는다 — 그 후보는 판정 없음이다),
 * 디스패치를 멈춰 띄우지 못한 작업은 `notRun`이다.
 */
const validateTasks = (plan, events) => {
  const validate = manifests()
  const fold = foldAttempts(events)
  const halted = haltOf(events)
  const staleAfterSec = budgetOf(events, Date.now())?.staleAfterSec
  const segmentStartedAt = segmentOf(events)?.startedAt
  const ledger = task => {
    const attempts = attemptsOf(fold, 'verify', task.taskId)
    return attempts.length ? taskState(attempts, { now: Date.now(), staleAfterSec, segmentStartedAt }) : null
  }
  const malformed = []
  const pending = []
  const awaiting = []
  const running = []
  const exhausted = []
  const notRun = []
  let checked = 0
  for (const task of tasksOf(plan)) {
    const state = ledger(task)
    if (state?.state === 'running') {
      running.push({ taskId: task.taskId, attempt: state.attempt })
      continue
    }
    if (!existsSync(task.verdict)) {
      if (task.promotion) continue
      if (state && isTerminal(state.state)) exhausted.push({ taskId: task.taskId, state: state.state, ...(state.failureClass !== undefined ? { failureClass: state.failureClass } : {}) })
      else if (halted) notRun.push(task.taskId)
      else {
        // 대장이 계약 위반으로 거절한 응답의 다음 시도는 교정이다. 그 프롬프트는 done이 만들어 두었다.
        const correction = state?.retryOf?.failureClass === 'malformed-output' && existsSync(retryPathOf(task))
        pending.push({
          taskId: task.taskId, route: task.route, prompt: correction ? retryPathOf(task) : task.prompt, verdict: task.verdict,
          ...(state ? { attempt: state.nextAttempt } : {}),
        })
      }
      continue
    }
    checked += 1
    const raw = readFileSync(task.verdict, 'utf8')
    const ids = task.candidateIds
    const { payload, problems } = checkTaskVerdict(raw, ids, validate)
    if (!problems) {
      if (!task.promotion && task.route === 'bundle') {
        for (const verdict of payload.verdicts) {
          if (verdict.disposition === 'needs-context') awaiting.push(verdict.candidateId)
        }
      }
      continue
    }
    // 교정까지 받은 작업이다. 다시 교정 차례로 내면 끝나지 않는다 — 두 번째 malformed-output은 확정 실패다(C-6A).
    if (state && state.spent >= MAX_ATTEMPTS) {
      exhausted.push({ taskId: task.taskId, state: 'failed', failureClass: 'malformed-output' })
      continue
    }
    const original = existsSync(task.prompt) ? readFileSync(task.prompt, 'utf8') : ''
    const retryPrompt = retryPathOf(task)
    writeFileSync(retryPrompt, buildRetryPrompt(original, problems, raw), 'utf8')
    malformed.push({ taskId: task.taskId, problems, retryPrompt })
  }
  const promotionsDue = []
  for (const candidateId of awaiting) {
    const task = plan?.promotions?.[candidateId]
    if (task === undefined || existsSync(task.verdict)) continue
    const state = ledger(task)
    if (state?.state === 'running') running.push({ taskId: task.taskId, attempt: state.attempt })
    else if (state && isTerminal(state.state)) exhausted.push({ taskId: task.taskId, state: state.state, ...(state.failureClass !== undefined ? { failureClass: state.failureClass } : {}) })
    else if (halted) notRun.push(task.taskId)
    else promotionsDue.push({ candidateId, taskId: task.taskId, prompt: task.prompt, verdict: task.verdict })
  }
  const ready = !malformed.length && !pending.length && !promotionsDue.length && !running.length
  return { checked, malformed, pending, promotionsDue, running, exhausted, notRun, ready }
}

if (validateMode) {
  const report = validateTasks(routed, readEvents(sidecar))
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exit(report.ready ? 0 : 1)
}

/**
 * `prepare-verification.mjs`가 정한 자리에서 판정 파일을 모은다.
 *
 * 순서가 곧 정본 순서다 — bundle 작업, isolated 작업, 그다음 승격 작업. 승격은
 * bundle이 `needs-context`로 돌린 후보를 다시 판정한 것이므로 반드시 bundle 뒤에
 * 와야 한다. 판정 파일이 없는 작업은 검증자가 결과를 내지 못한 것이다 — 실패로
 * 멈추지 않고(C-6B: verification-unavailable) 어느 작업인지 알린다.
 *
 * 승격 작업을 읽을지는 **bundle 판정이 정한다.** bundle이 `needs-context`로 돌린 후보만
 * 승격 판정을 받아야 한다(SKILL). 그 판정이 없거나 교정 뒤에도 계약을 어겼으면 bundle의
 * `needs-context`도 최종 판정으로 쓰지 않는다 — 그대로 세면 계약이 isolated에서도 닫히지
 * 않은 후보에만 주는 `미해결 / 후속 확인`으로 그려지고, 해야 할 검증을 건너뛴 사실은
 * 판정 없음 0건에 묻힌다. bundle이 이미 닫은 후보의 승격 판정은 세지 않는다 — 계약에
 * 없는 재검증으로 판정을 뒤집는 경로이기 때문이다.
 */
const collectFromTasks = plan => {
  const validate = manifests()
  // 재확인 작업(C-13)의 판정은 이번 후보의 판정이 아니다. 교차검증 수치에 섞으면 대상 밖 판정으로
  // 세어지거나, 이전 지적의 판정이 이번 지적의 유지·반박이 된다 — 따로 모은다(`collectRechecks`).
  const tasks = tasksOf(plan).filter(task => task.route !== 'recheck' && task.route !== 'identity')
  const found = []
  const missing = []
  const malformed = []
  const unpromoted = []
  const unrequested = []
  const corrected = tasks.filter(task => existsSync(retryPathOf(task))).length

  const read = task => {
    if (!existsSync(task.verdict)) return { absent: true }
    const { payload, problems } = checkTaskVerdict(readFileSync(task.verdict, 'utf8'), task.candidateIds, validate)
    // 교정 뒤에도 계약을 어긴 판정은 세지 않는다(C-6A: 두 번째 malformed-output은
    // 확정 실패다). 그 후보는 판정 없음으로 남고, 차단은 C-6B대로 fail-open이다.
    if (problems) {
      malformed.push(task.taskId)
      return {}
    }
    return { payload }
  }

  const awaiting = []
  for (const task of tasks.filter(entry => !entry.promotion)) {
    const { payload, absent } = read(task)
    if (absent) missing.push(task.taskId)
    if (!payload) continue
    found.push(payload)
    if (task.route !== 'bundle') continue
    for (const verdict of payload.verdicts) {
      if (verdict.disposition === 'needs-context') awaiting.push(verdict.candidateId)
    }
  }

  const promotionOf = new Map(tasks.filter(entry => entry.promotion).map(task => [task.candidateIds[0], task]))
  for (const id of awaiting) {
    const task = promotionOf.get(id)
    const payload = task === undefined ? undefined : read(task).payload
    if (payload) found.push(payload)
    else unpromoted.push(id)
  }
  for (const [id, task] of promotionOf) {
    if (!awaiting.includes(id) && existsSync(task.verdict)) unrequested.push(task.taskId)
  }

  // 승격 판정을 받지 못한 후보는 bundle 판정에서도 지운다. 렌더러가 읽을 파일에 남기면
  // 여기서는 판정 없음으로 세고 렌더러는 `needs-context`로 그려, 둘이 다른 결론을 낸다.
  const unresolved = new Set(unpromoted)
  const payloads = unresolved.size
    ? found.map(payload => ({ ...payload, verdicts: payload.verdicts.filter(verdict => !unresolved.has(verdict.candidateId)) }))
    : found
  return { found: payloads, missing, malformed, unpromoted, unrequested, corrected }
}

/**
 * 재확인 작업(C-13)의 판정을 모은다. 이전 리뷰의 지적이 지금 코드에서 성립하는지에 대한 판정이다.
 *
 * 계약을 어긴 판정은 세지 않는다 — 그 이전 지적은 판정 없음으로 남고, 스냅숏이 재확인 필요로 그린다.
 * 판정을 받지 못한 것을 해결로 읽지 않는다.
 */
const collectRechecks = plan => {
  const validate = manifests()
  const payloads = []
  const missing = []
  const malformed = []
  // 같은 결함인지 묻는 작업(route identity)의 판정도 이전 지적에 대한 것이라 같은 파일에 모은다. 판정할 ID는
  // 둘 다 이전 지적의 ref이고, 한 이전 지적은 둘 중 하나만 받는다.
  const answered = []
  for (const task of tasksOf(plan).filter(entry => entry.route === 'recheck' || entry.route === 'identity')) {
    if (!existsSync(task.verdict)) {
      missing.push(task.taskId)
      continue
    }
    const { payload, problems } = checkTaskVerdict(readFileSync(task.verdict, 'utf8'), task.candidateIds, validate)
    if (problems) malformed.push(task.taskId)
    else {
      payloads.push(payload)
      answered.push({ route: task.route, disposition: payload.verdicts[0]?.disposition })
    }
  }
  const countsOf = route => {
    const requested = tasksOf(plan).filter(entry => entry.route === route).length
    const of = disposition => answered.filter(entry => entry.route === route && entry.disposition === disposition).length
    const got = answered.filter(entry => entry.route === route).length
    return route === 'recheck'
      ? { requested, upheld: of('upheld'), rejected: of('rejected'), needsContext: of('needs-context'), noVerdict: requested - got }
      : { requested, same: of('upheld'), different: of('rejected'), unknown: of('needs-context'), noVerdict: requested - got }
  }
  return { payloads, missing, malformed, counts: countsOf('recheck'), identities: countsOf('identity') }
}

let payloads
let verdictsFile
let correctedByFiles
let recheckReport
if (collectMode) {
  const { found, missing, malformed, unpromoted, unrequested, corrected } = collectFromTasks(routed)
  if (missing.length) {
    process.stderr.write(`경고: 판정 파일이 없는 검증 작업 ${missing.length}개: ${missing.join(', ')} — 그 후보는 판정 없음(noVerdict)으로 센다\n`)
  }
  if (malformed.length) {
    process.stderr.write(`경고: 계약을 어긴 판정 파일 ${malformed.length}개를 세지 않았다: ${malformed.join(', ')} — --validate로 교정 프롬프트를 만들 수 있다. 교정 뒤에도 어겼다면 그 후보는 판정 없음(noVerdict)이다\n`)
  }
  if (unpromoted.length) {
    process.stderr.write(`경고: bundle이 needs-context로 돌린 후보 ${unpromoted.length}개의 승격 판정이 없다: ${unpromoted.join(', ')} — bundle 판정을 최종 판정으로 쓰지 않고 판정 없음(noVerdict)으로 센다. promotions[<candidateId>].prompt로 isolated 검증자를 띄워 그 verdict 자리에 쓴다\n`)
  }
  if (unrequested.length) {
    process.stderr.write(`경고: bundle이 이미 닫은 후보의 승격 판정 ${unrequested.length}개를 세지 않았다: ${unrequested.join(', ')} — 승격은 bundle이 needs-context로 돌린 후보에만 한다\n`)
  }
  correctedByFiles = corrected
  payloads = found
  // 렌더러는 판정 파일을 `--verdicts`로 받는다. 여러 파일을 순서대로 넘기게 하면
  // 순서를 다시 사람이 정하게 되므로, 모은 순서 그대로 한 파일에 남긴다.
  verdictsFile = join(dir, '.timing', `${run}.verdicts.json`)
  writeFileSync(verdictsFile, `${JSON.stringify({ tasks: payloads }, null, 2)}\n`, 'utf8')

  const rechecked = collectRechecks(routed)
  if (rechecked.counts.requested || rechecked.identities.requested) {
    if (rechecked.missing.length) process.stderr.write(`경고: 판정 파일이 없는 재확인 작업 ${rechecked.missing.length}개: ${rechecked.missing.join(', ')} — 그 이전 지적은 재확인 필요로 남는다\n`)
    if (rechecked.malformed.length) process.stderr.write(`경고: 계약을 어긴 재확인 판정 ${rechecked.malformed.length}개를 세지 않았다: ${rechecked.malformed.join(', ')} — 그 이전 지적은 재확인 필요로 남는다\n`)
    const file = join(dir, '.timing', `${run}.rechecks.json`)
    writeFileSync(file, `${JSON.stringify({ tasks: rechecked.payloads }, null, 2)}\n`, 'utf8')
    recheckReport = { ...rechecked.counts, ...(rechecked.identities.requested ? { identities: rechecked.identities } : {}), file }
  }
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
  // 이번 후보에 검증 대상이 없어도 재확인 작업(C-13)은 있을 수 있다. 그때 교차검증의 끝은 0건으로 닫는다.
  if (!targets.size && !recheckReport) die(`--targets에 검증 대상이 없다: ${targetsPath} — prepare-verification.mjs의 출력을 넘긴다`)

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
  ...(recheckReport === undefined ? {} : { rechecks: recheckReport }),
}, null, 2)}\n`)
