import * as nodeFs from 'node:fs'

import { writeTextAtomic } from './atomic-write.mjs'

import { codeSpan, dispositionOf, escapeProse } from '../render-findings.mjs'
import { COMPARISONS, METHODS, OUTCOMES } from './evidence.mjs'
import { moduleOutcomes } from './run-record.mjs'
import { HALT_REASONS, haltOf } from './task-ledger.mjs'

// 한 실행의 결과 스냅숏 — 무엇을 리뷰했고, 어디까지 끝냈고, 무엇을 찾았는가(#88 PR 0).
//
// 지금까지 그 답은 리포트 Markdown과 타임라인, 중간 파일 여럿에 흩어져 있었다. 다음
// 실행이 이전 실행과 비교하려면(증분 재리뷰) 그것을 다시 조립해야 하는데, 조립하는
// 쪽마다 "끝난 모듈"과 "검토하지 않은 범위"를 다르게 읽으면 같은 실행이 비교마다
// 다른 실행이 된다. 그래서 그 판단을 한 번, 스크립트가 하고 파일로 남긴다.
//
// 지키는 것:
// - **대상은 `run.start`가 정본이다.** preflight가 기록한 HEAD·작업 트리·규칙 digest를
//   옮긴다. 스냅숏을 쓸 때 다시 재서 다르면 `drift`로 남긴다 — 실행 도중 대상이 바뀌면
//   그 결과는 한 시점의 코드에 대한 것이 아니다
// - **원본을 대신하지 않는다.** 타임라인·routed·판정·producer 결과는 그대로 두고, 스냅숏은
//   그 파일들을 sha256으로 가리킨다. 지적의 본문·근거는 싣지 않는다 — C-6B audit sidecar가
//   "원본 전문과 evidence 자유 서술"을 영속 projection에서 빼는 것과 같은 이유다
// - **모르는 파일을 빈 리뷰로 읽지 않는다.** 잘렸거나, 버전이 다르거나, 필드가 빠졌으면
//   진단을 내고 값을 돌려주지 않는다. "지적 0건"과 "읽지 못했다"는 다르다
// - **`candidateId`는 실행 안에서만 안정적이다(C-6B).** 실행 간 식별자로 쓰지 않도록, 지적은
//   `<runId>/<candidateId>` 꼴의 `ref`로 가리킨다. 실행 간 동일성(lineage)은 이 스냅숏이 정하지 않는다

export const SNAPSHOT_SCHEMA_VERSION = 1
const KIND = 'review-snapshot'

const STATUSES = ['complete', 'partial', 'failed']
const MODULE_STATES = ['ok', 'failed', 'missing', 'skipped', 'unknown']
const MISSING_REASONS = ['no-record', 'status-outside-list', 'not-collected', 'halted']
const DISPOSITIONS = ['upheld', 'rejected', 'scope-open', 'not-eligible', 'verification-disabled', 'verification-unavailable']
const DRIFT_FIELDS = ['head', 'worktree', 'rulesDigest']
const INPUT_ROLES = ['timeline', 'routed', 'verdicts', 'result', 'evidence', 'execution']
const VERIFICATION_STATES = ['ran', 'disabled']

const SHA256 = /^sha256:[0-9a-f]{64}$/
const HEX_DIGEST = /^[0-9a-f]{64}$/
const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonEmpty = value => typeof value === 'string' && value.length > 0
const count = value => Number.isInteger(value) && value >= 0

/**
 * 이 워크플로우가 띄울 수 있는 모듈 — 번호 모듈 후보와 특수 패스.
 *
 * 이름은 결과 파일과 `module.done`이 쓰는 값이다(규칙 문서 파일명에서 `.md`를 뗀 것,
 * 특수 패스는 id). synthesis 전용 모듈과 공통 컨텍스트는 띄우지 않으므로 빠진다.
 */
export function plannedModules(catalog, workflow) {
  const modules = catalog?.modules ?? []
  const numbered = modules
    .filter(module => module.role === 'module' && (module.workflows ?? []).includes(workflow))
    .filter(module => module.phaseByWorkflow?.[workflow] !== 'post-verification-synthesis')
    .map(module => ({ name: String(module.path ?? '').replace(/\.md$/, ''), kind: 'module', id: module.id }))
    .sort((left, right) => (left.name < right.name ? -1 : 1))
  // `optIn`은 이 워크플로우에서 켰을 때만 도는 패스다(`--correctness on`). 켰는지는
  // preflight가 `run.start`에 남긴다.
  const passes = modules
    .filter(module => module.role === 'specialist' && (module.workflows ?? []).includes(workflow))
    .map(module => ({ name: module.id, kind: 'pass', id: module.id, optIn: (module.optIn ?? []).includes(workflow) }))
  return [...numbered, ...passes]
}

/** `modules.planned`의 항목이 가리키는 모듈. 번호 모듈은 두 자리(`21`)로도, 이름(`21-rsc`)으로도 적힌다. */
const matchPlanned = (entry, modules) => {
  const key = String(isObject(entry) ? entry.module : entry)
  return modules.find(module => module.name === key) ??
    (/^\d\d/.test(key) ? modules.find(module => module.kind === 'module' && module.id === key.slice(0, 2)) : undefined)
}

/**
 * 모듈마다 이 실행의 적용 대상인지 정한다 — 스냅숏과 작업 대장(C-12)이 같은 답을 쓴다.
 *
 * 마지막 `modules.planned`의 `skipped`·`unknown`과 `run.start`의 선택 패스 설정으로 정한다.
 * `scope`는 `applied`·`skipped`·`unknown`·`not-requested` 중 하나다. `planned`가 거짓이면
 * 계획 기록이 없어 후보 전부를 적용 대상으로 본 것이다.
 */
export function moduleScope({ modules, events, start, notes = [] }) {
  const lastPlanned = events.filter(event => event?.phase === 'modules.planned').at(-1)
  const skipped = new Map()
  const unknown = new Map()
  for (const [list, target] of [[lastPlanned?.skipped, skipped], [lastPlanned?.unknown, unknown]]) {
    for (const entry of Array.isArray(list) ? list : []) {
      const module = matchPlanned(entry, modules)
      if (!module) {
        notes.push(`modules.planned의 ${JSON.stringify(isObject(entry) ? entry.module : entry)}는 이 워크플로우의 모듈이 아니다`)
        continue
      }
      target.set(module.name, isObject(entry) ? entry : {})
    }
  }
  const scope = modules.map(module => {
    // 켜지 않은 선택 패스는 적용 대상이 아니다. "결과 없음"으로 세면 기본 설정으로 돈
    // 실행이 전부 부분 완료가 된다. 그래도 범위에서 빼지 않고 이유를 단 SKIPPED로 남긴다.
    if (module.optIn && start?.[module.id] !== 'on') return { module, scope: 'not-requested' }
    if (skipped.has(module.name)) return { module, scope: 'skipped', entry: skipped.get(module.name) }
    if (unknown.has(module.name)) return { module, scope: 'unknown', entry: unknown.get(module.name) }
    return { module, scope: 'applied' }
  })
  return { planned: Boolean(lastPlanned), scope }
}

/**
 * 모듈마다 상태를 정한다. 기록(`module.done`)과 수집(`collected.sources`)이 **둘 다** 성공을
 * 말해야 `ok`다.
 *
 * 기록만 보면, 성공으로 끝났는데 검증 준비가 모으지 않은 모듈이 "검토됨"으로 남는다 —
 * 그 모듈의 지적은 리포트에 없는데도. 그래서 그 경우는 `missing`(`not-collected`)이다.
 */
function moduleStates({ modules, events, collected, notes, start }) {
  const { planned, scope } = moduleScope({ modules, events, start, notes })
  if (!planned) {
    notes.push('modules.planned가 없어 후보 전부를 적용 대상으로 봤다 — 건너뛴 모듈이 있었다면 기록되지 않았다')
  }

  const outcomes = moduleOutcomes(events)
  // 작업 대장(C-12)이 디스패치를 멈춘 구간이면, 띄우지 못한 모듈은 "기록이 없다"가 아니라 "멈춰서
  // 띄우지 않았다"다. 둘 다 미검토 범위지만 고칠 곳이 다르다 — 앞의 것은 오케스트레이터가 빠뜨린
  // 것이고, 뒤의 것은 한도나 사용자가 정한 것이다.
  const halt = haltOf(events)
  const states = scope.map(({ module, scope: where, entry }) => {
    const base = { name: module.name, kind: module.kind }
    if (where === 'not-requested') {
      if (outcomes.has(module.name) || collected.has(module.name)) {
        notes.push(`켜지 않은 선택 패스 ${module.name}의 기록이나 결과가 있다 — 이 실행은 --${module.id} on 없이 시작했으므로 모은 것으로 세지 않는다`)
      }
      return { ...base, state: 'skipped', reasonCode: 'not-requested', reason: `선택 패스 — 이 실행은 --${module.id} on 없이 시작했다` }
    }
    if (where === 'skipped') {
      return {
        ...base,
        state: 'skipped',
        ...(entry.reasonCode !== undefined ? { reasonCode: String(entry.reasonCode) } : {}),
        ...((entry.reason ?? entry.evidence) !== undefined ? { reason: String(entry.reason ?? entry.evidence) } : {}),
      }
    }
    if (where === 'unknown') {
      return { ...base, state: 'unknown', ...((entry.reason ?? entry.evidence) !== undefined ? { reason: String(entry.reason ?? entry.evidence) } : {}) }
    }
    const outcome = outcomes.get(module.name)
    if (!outcome) {
      return halt
        ? { ...base, state: 'missing', reason: 'halted', haltReason: String(halt.reason) }
        : { ...base, state: 'missing', reason: 'no-record' }
    }
    if (outcome.status === 'failed') {
      return {
        ...base,
        state: 'failed',
        attempt: outcome.attempt,
        ...(outcome.failureClass !== undefined ? { failureClass: String(outcome.failureClass) } : {}),
        ...(outcome.cancelReason !== undefined ? { cancelReason: String(outcome.cancelReason) } : {}),
      }
    }
    if (outcome.status !== 'ok') return { ...base, state: 'missing', reason: 'status-outside-list' }
    if (!collected.has(module.name)) return { ...base, state: 'missing', reason: 'not-collected' }
    return { ...base, state: 'ok', attempt: outcome.attempt }
  })

  for (const source of collected) {
    if (!modules.some(module => module.name === source)) notes.push(`수집된 ${JSON.stringify(source)}는 이 워크플로우의 모듈이 아니다`)
    else if (states.find(state => state.name === source)?.reasonCode === 'not-requested') continue
    else if (states.find(state => state.name === source)?.state !== 'ok') {
      notes.push(`${source}는 수집됐지만 기록의 최종 상태가 성공이 아니다 — 기록을 정본으로 둔다`)
    }
  }
  return states
}

const countsOf = modules => {
  const by = state => modules.filter(module => module.state === state).length
  const ok = by('ok')
  const failed = by('failed')
  const missing = by('missing')
  return { applied: ok + failed + missing, ok, failed, missing, skipped: by('skipped'), unknown: by('unknown') }
}

/**
 * 적용 대상 전부를 모았으면 `complete`, 하나도 못 모았으면 `failed`, 그 사이는 `partial`이다.
 *
 * SKILL의 완료 판정("적용 대상 모듈 전부 수집 성공")과 같다. `SKIPPED`·`UNKNOWN`은 적용 대상이
 * 아니므로 상태를 낮추지 않지만, 범위에는 그대로 남는다(C-8).
 */
const statusOf = counts => (counts.ok === counts.applied ? 'complete' : counts.ok === 0 ? 'failed' : 'partial')

/**
 * 재현 근거(C-11)의 요약 — 어떻게 확인했고, 실행했으면 무엇이 나왔는가.
 *
 * 본문(조건·절차·기대·관찰)은 싣지 않는다. 근거 파일과 실행 기록이 원본이고, 스냅숏은 그
 * 파일들을 `inputs`의 해시로 가리킨다. 계약에 맞지 않는 항목은 `valid: false`이고 결과를 싣지
 * 않는다 — 실행 기록 없이 `executed`를 붙인 항목이 실행 근거로 남지 않게.
 */
function evidenceSummary(assessed) {
  const valid = !assessed.problems?.length
  const head = valid && assessed.method === 'executed' ? assessed.head : null
  return {
    method: assessed.method,
    valid,
    headOutcome: head?.outcome ?? null,
    headUsable: head ? head.usable : null,
    comparison: valid ? assessed.comparison ?? null : null,
  }
}

/**
 * 스냅숏을 만든다. 순수 함수다 — 파일을 읽고 쓰는 일은 호출자(`review-snapshot.mjs`)가 한다.
 *
 * 그릴 재료가 모자라면 던진다. 모자란 채로 만든 스냅숏은 "지적 0건"이나 "완료"처럼 읽힌다.
 */
export function buildSnapshot({ name, events, catalog, routed, verdicts, verificationState, openQuestionsBySource, inputs, current, now, evidence = new Map() }) {
  const start = events.find(event => event?.phase === 'run.start')
  if (!start) throw new Error('타임라인에 run.start가 없다 — 실행 식별 없이 스냅숏을 만들지 않는다')
  if (!nonEmpty(start.runId)) {
    throw new Error('run.start에 runId가 없다 — 2.16.0 이전 preflight로 시작한 실행이라 무엇을 리뷰했는지 기록에 없다')
  }
  if (!VERIFICATION_STATES.includes(verificationState)) {
    throw new Error(`verificationState는 ran 또는 disabled다 (받은 값: ${JSON.stringify(verificationState)})`)
  }
  if (!Array.isArray(routed?.candidates)) throw new Error('routed 출력에 candidates 배열이 없다')
  if (!Array.isArray(routed?.collected?.sources)) {
    throw new Error('routed 출력에 collected.sources가 없다 — `prepare-verification.mjs --collect`의 출력이어야 어느 모듈을 모았는지 안다')
  }

  const notes = []
  const modules = plannedModules(catalog, start.workflow)
  if (!modules.length) throw new Error(`catalog에 워크플로우 ${JSON.stringify(start.workflow)}의 모듈이 없다`)
  const collected = new Set(routed.collected.sources.map(String))
  const states = moduleStates({ modules, events, collected, notes, start })
  const counts = countsOf(states)

  const findings = routed.candidates.map(candidate => {
    const verdict = verdicts.get(candidate.candidateId)
    const disposition = dispositionOf(candidate, verdict, verificationState)
    const sources = candidate.sources ?? (candidate.source !== undefined ? [candidate.source] : [])
    return {
      ref: `${start.runId}/${candidate.candidateId}`,
      candidateId: candidate.candidateId,
      ruleId: candidate.ruleId,
      impact: candidate.impact,
      confidence: candidate.confidence,
      category: candidate.category,
      sources: sources.map(String),
      title: String(candidate.content?.title ?? ''),
      location: candidate.location,
      locationCheck: candidate.locationCheck,
      eligibility: candidate.eligibility,
      route: candidate.route,
      disposition,
      ...(disposition === 'rejected' && verdict?.rebuttalKind !== undefined ? { rebuttalKind: verdict.rebuttalKind } : {}),
      ...(evidence.has(candidate.candidateId) ? { evidence: evidenceSummary(evidence.get(candidate.candidateId)) } : {}),
    }
  })

  const openQuestions = []
  for (const source of routed.collected.sources) {
    // 출처는 결과 파일 이름에서 붙인다. producer 출력은 신뢰하지 않는 content라(C-6A),
    // 그 안에 `source`가 들어 있어도 이 값을 덮지 못하게 뒤에 둔다.
    for (const question of openQuestionsBySource.get(source) ?? []) openQuestions.push({ ...question, source: String(source) })
  }

  // 디스패치의 한도와 멈춤(C-12). 한도를 주지 않은 실행에도 시도 수는 남긴다 — 다음 실행이 같은
  // 대상을 다시 볼 때 이번에 몇 번 불렀는지가 비교의 재료다.
  const halt = haltOf(events)
  const dispatch = {
    attempts: events.filter(event => event?.phase === 'module.start' || event?.phase === 'verify.start').length,
    maxTasks: Number.isInteger(start.maxTasks) ? start.maxTasks : null,
    maxDurationSec: Number.isInteger(start.maxDurationSec) ? start.maxDurationSec : null,
    resumed: events.filter(event => event?.phase === 'run.resume').length,
    halted: halt ? { reason: halt.reason, at: halt.at } : null,
  }

  const recorded = { head: start.head, worktree: start.worktree, rulesDigest: start.rulesDigest }
  const drift = DRIFT_FIELDS
    .filter(field => current?.[field] !== undefined && current[field] !== recorded[field])
    .map(field => ({ field, recorded: recorded[field] ?? null, current: current[field] }))

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    kind: KIND,
    createdAt: now,
    // 값을 문자열로 바꾸지 않고 옮긴다. `String(undefined)`는 "undefined"라는 멀쩡한 문자열이
    // 되어 계약 검사를 통과한다 — 빠진 값은 빠진 채로 두어 `snapshotProblems`가 잡게 한다.
    run: {
      runId: start.runId,
      name,
      workflow: start.workflow,
      pluginVersion: start.version,
      rules: start.rules,
      rulesDigest: start.rulesDigest,
      host: start.host,
      startedAt: start.at,
      ...(nonEmpty(start.continues) ? { continues: start.continues } : {}),
    },
    target: {
      repo: start.repo ?? null,
      repoRoot: start.repoRoot ?? null,
      branch: start.branch,
      base: start.base,
      mergeBase: start.mergeBase,
      head: start.head,
      worktree: start.worktree,
      dirtyFiles: start.dirtyFiles,
    },
    drift,
    status: statusOf(counts),
    scope: { modules: states, counts },
    dispatch,
    verification: { state: verificationState },
    findings,
    openQuestions,
    inputs,
    notes,
  }
}

/**
 * 스냅숏이 이 버전의 계약에 맞는지 본다. 맞으면 빈 배열이다.
 *
 * 모양만 보지 않고 **수치와 상태가 목록과 맞는지**도 본다. 손으로 고쳤거나 일부만 쓰인
 * 파일은 모양이 맞아도 수치가 어긋난다 — 그것을 정상 스냅숏으로 읽으면 다음 비교가
 * 틀린 범위에서 시작한다.
 */
export function snapshotProblems(snapshot) {
  const problems = []
  if (!isObject(snapshot)) return ['스냅숏이 JSON 객체가 아니다']
  if (snapshot.schemaVersion === undefined) problems.push('schemaVersion이 없다')
  else if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    return [`지원하지 않는 schemaVersion ${JSON.stringify(snapshot.schemaVersion)} — 이 스크립트는 ${SNAPSHOT_SCHEMA_VERSION}만 읽는다`]
  }
  if (snapshot.kind !== KIND) problems.push(`kind가 ${JSON.stringify(KIND)}가 아니다`)
  if (!nonEmpty(snapshot.createdAt)) problems.push('createdAt이 없다')

  const { run, target } = snapshot
  if (!isObject(run)) problems.push('run이 없다')
  else {
    for (const key of ['runId', 'name', 'workflow', 'pluginVersion', 'rules', 'host', 'startedAt']) {
      if (!nonEmpty(run[key])) problems.push(`run.${key}가 없다`)
    }
    if (!SHA256.test(String(run.rulesDigest))) problems.push('run.rulesDigest가 sha256:<hex>가 아니다')
  }
  if (!isObject(target)) problems.push('target이 없다')
  else {
    if (!OBJECT_ID.test(String(target.head))) problems.push('target.head가 commit id가 아니다')
    if (!OBJECT_ID.test(String(target.mergeBase))) problems.push('target.mergeBase가 commit id가 아니다')
    if (target.worktree !== 'clean' && !SHA256.test(String(target.worktree))) problems.push('target.worktree가 clean도 sha256:<hex>도 아니다')
    if (!count(target.dirtyFiles)) problems.push('target.dirtyFiles가 0 이상의 정수가 아니다')
    else if ((target.worktree === 'clean') !== (target.dirtyFiles === 0)) problems.push('target.worktree와 target.dirtyFiles가 서로 맞지 않는다')
    if (target.repoRoot !== null && !OBJECT_ID.test(String(target.repoRoot))) problems.push('target.repoRoot가 commit id도 null도 아니다')
    if (target.repo !== null && !nonEmpty(target.repo)) problems.push('target.repo가 문자열도 null도 아니다')
    for (const key of ['branch', 'base']) if (!nonEmpty(target[key])) problems.push(`target.${key}가 없다`)
  }

  if (!Array.isArray(snapshot.drift)) problems.push('drift가 배열이 아니다')
  else {
    for (const entry of snapshot.drift) {
      if (!isObject(entry) || !DRIFT_FIELDS.includes(entry.field)) problems.push(`drift 항목이 ${DRIFT_FIELDS.join('/')} 중 하나가 아니다`)
    }
  }

  const scope = snapshot.scope
  if (!isObject(scope) || !Array.isArray(scope.modules) || !isObject(scope.counts)) problems.push('scope.modules·scope.counts가 없다')
  else {
    const names = new Set()
    for (const module of scope.modules) {
      if (!isObject(module) || !nonEmpty(module.name)) { problems.push('scope.modules에 이름 없는 항목이 있다'); continue }
      if (names.has(module.name)) problems.push(`scope.modules에 ${module.name}이 두 번 있다`)
      names.add(module.name)
      if (!['module', 'pass'].includes(module.kind)) problems.push(`${module.name}의 kind가 module/pass가 아니다`)
      if (!MODULE_STATES.includes(module.state)) problems.push(`${module.name}의 state ${JSON.stringify(module.state)}는 ${MODULE_STATES.join('/')} 밖이다`)
      if (module.state === 'missing' && !MISSING_REASONS.includes(module.reason)) problems.push(`${module.name}의 missing reason이 ${MISSING_REASONS.join('/')} 밖이다`)
      if (['ok', 'failed'].includes(module.state) && !Number.isInteger(module.attempt)) problems.push(`${module.name}에 attempt가 없다`)
    }
    const recount = countsOf(scope.modules)
    for (const key of Object.keys(recount)) {
      if (scope.counts[key] !== recount[key]) problems.push(`scope.counts.${key} ${JSON.stringify(scope.counts[key])}가 scope.modules로 센 ${recount[key]}와 다르다`)
    }
    if (!STATUSES.includes(snapshot.status)) problems.push(`status ${JSON.stringify(snapshot.status)}는 ${STATUSES.join('/')} 밖이다`)
    else if (snapshot.status !== statusOf(recount)) problems.push(`status ${snapshot.status}가 scope.modules로 정한 ${statusOf(recount)}와 다르다`)
  }

  if (snapshot.dispatch !== undefined) {
    const dispatch = snapshot.dispatch
    if (!isObject(dispatch) || !count(dispatch.attempts) || !count(dispatch.resumed) ||
      !(dispatch.maxTasks === null || count(dispatch.maxTasks)) || !(dispatch.maxDurationSec === null || count(dispatch.maxDurationSec)) ||
      !(dispatch.halted === null || (isObject(dispatch.halted) && HALT_REASONS.includes(dispatch.halted.reason)))) {
      problems.push('dispatch가 계약 밖이다 — attempts·resumed·maxTasks·maxDurationSec·halted(reason)')
    }
  }
  if (isObject(scope) && Array.isArray(scope.modules)) {
    for (const module of scope.modules) {
      if (module?.reason === 'halted' && !HALT_REASONS.includes(module.haltReason)) problems.push(`${module.name}의 haltReason이 ${HALT_REASONS.join('/')} 밖이다`)
    }
  }

  const state = snapshot.verification?.state
  if (!VERIFICATION_STATES.includes(state)) problems.push('verification.state가 ran/disabled가 아니다')

  if (!Array.isArray(snapshot.findings)) problems.push('findings가 배열이 아니다')
  else {
    const refs = new Set()
    for (const finding of snapshot.findings) {
      if (!isObject(finding) || !nonEmpty(finding.candidateId)) { problems.push('findings에 candidateId 없는 항목이 있다'); continue }
      const id = finding.candidateId
      if (finding.ref !== `${run?.runId}/${id}`) problems.push(`${id}의 ref가 ${JSON.stringify(`${run?.runId}/${id}`)}가 아니다 — 다른 실행의 지적을 가리킨다`)
      if (refs.has(finding.ref)) problems.push(`ref ${finding.ref}가 두 번 있다`)
      refs.add(finding.ref)
      if (!nonEmpty(finding.ruleId)) problems.push(`${id}에 ruleId가 없다`)
      for (const key of ['impact', 'confidence']) if (!['high', 'low'].includes(finding[key])) problems.push(`${id}의 ${key}가 high/low가 아니다`)
      if (!DISPOSITIONS.includes(finding.disposition)) problems.push(`${id}의 disposition ${JSON.stringify(finding.disposition)}는 C-6B 목록 밖이다`)
      else if (state === 'disabled' && !['not-eligible', 'verification-disabled'].includes(finding.disposition)) {
        problems.push(`${id}의 disposition ${finding.disposition}는 검증을 끈 실행에서 나올 수 없다`)
      } else if (state === 'ran' && finding.disposition === 'verification-disabled') {
        problems.push(`${id}의 disposition verification-disabled는 검증을 돌린 실행에서 나올 수 없다`)
      }
      if (!Array.isArray(finding.sources)) problems.push(`${id}의 sources가 배열이 아니다`)
      if (finding.evidence !== undefined) {
        const ev = finding.evidence
        if (!isObject(ev) || !METHODS.includes(ev.method) || typeof ev.valid !== 'boolean' ||
          !(ev.headOutcome === null || OUTCOMES.includes(ev.headOutcome)) ||
          !(ev.headUsable === null || typeof ev.headUsable === 'boolean') ||
          !(ev.comparison === null || COMPARISONS.includes(ev.comparison))) {
          problems.push(`${id}의 evidence 요약이 계약 밖이다`)
        }
      }
      if (!isObject(finding.location)) problems.push(`${id}에 location이 없다`)
    }
  }

  if (!Array.isArray(snapshot.openQuestions)) problems.push('openQuestions가 배열이 아니다')
  else if (snapshot.openQuestions.some(question => !isObject(question) || !nonEmpty(question.source))) problems.push('openQuestions에 source 없는 항목이 있다')

  if (!Array.isArray(snapshot.inputs)) problems.push('inputs가 배열이 아니다')
  else {
    for (const input of snapshot.inputs) {
      if (!isObject(input) || !INPUT_ROLES.includes(input.role) || !nonEmpty(input.path) || !HEX_DIGEST.test(String(input.sha256))) {
        problems.push(`inputs 항목은 role(${INPUT_ROLES.join('/')})·path·sha256을 갖는다: ${JSON.stringify(input)}`)
      }
    }
  }
  if (!Array.isArray(snapshot.notes) || snapshot.notes.some(note => typeof note !== 'string')) problems.push('notes가 문자열 배열이 아니다')
  return problems
}

/**
 * 파일 내용을 스냅숏으로 읽는다. `{ value }` 또는 `{ error }`다 — 둘 다는 없다.
 *
 * 비었거나, 잘렸거나, 버전이 다르면 **값을 돌려주지 않는다.** 읽지 못한 스냅숏을 빈 리뷰로
 * 바꾸면 "이전 리뷰에 지적이 없었다"가 되고, 이전 지적이 전부 해결된 것처럼 보인다.
 */
export function parseSnapshot(text) {
  if (typeof text !== 'string' || !text.trim()) return { error: '스냅숏 파일이 비어 있다' }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { error: `스냅숏이 JSON이 아니다(잘렸을 수 있다): ${error.message}` }
  }
  const problems = snapshotProblems(parsed)
  if (problems.length) return { error: `스냅숏을 읽을 수 없다:\n  - ${problems.join('\n  - ')}` }
  return { value: parsed }
}

/**
 * 임시 파일에 쓰고, 다시 읽어 확인한 뒤, 이름을 바꿔 교체한다.
 *
 * 그 자리에 바로 쓰면 쓰다 멈춘 순간 앞의 정상 스냅숏이 사라지고 반쪽 파일이 남는다.
 * 쓰기 전에 계약을 보고, 쓴 뒤에 읽어서 같은지 본다 — 디스크가 차서 일부만 쓰인 경우는
 * 쓰기 호출이 성공해도 일어난다. 어느 단계든 실패하면 임시 파일을 지우고 던지며, 앞의
 * 파일은 그대로다.
 *
 * 다른 실행(`run.runId`가 다른)의 정상 스냅숏은 덮지 않는다. 깨진 파일은 덮는다 — 그것은
 * 보존할 값이 없다.
 */
export function writeSnapshotAtomic(path, snapshot, fs = nodeFs) {
  const problems = snapshotProblems(snapshot)
  if (problems.length) throw new Error(`계약에 맞지 않는 스냅숏은 쓰지 않는다:\n  - ${problems.join('\n  - ')}`)
  if (fs.existsSync(path)) {
    const existing = parseSnapshot(fs.readFileSync(path, 'utf8'))
    if (existing.value && existing.value.run.runId !== snapshot.run.runId) {
      throw new Error(`${path}는 다른 실행(${existing.value.run.runId})의 스냅숏이다 — 덮지 않는다`)
    }
  }
  writeTextAtomic(path, `${JSON.stringify(snapshot, null, 2)}\n`, { fs, verify: written => parseSnapshot(written).error })
}

const STATUS_TEXT = {
  complete: '완료',
  partial: '부분 완료 — `FAILED orchestration`, 완료된 리뷰로 요약하지 않는다',
  failed: '실패 — `FAILED orchestration`, 수집한 모듈 결과가 없다',
}
const MISSING_TEXT = {
  'no-record': '결과 없음 — `module.done`이 없다',
  'status-outside-list': '결과 없음 — `module.done`의 status가 ok도 failed도 아니다',
  'not-collected': '결과 없음 — 성공으로 기록됐지만 수집되지 않았다',
  halted: '결과 없음 — 디스패치를 멈춰 띄우지 않았다',
}
const HALT_TEXT = {
  'max-tasks': '호출 한도를 다 썼다',
  'max-duration': '시간 상한이 지났다',
  user: '사용자가 멈췄다',
}
const short = id => (typeof id === 'string' && OBJECT_ID.test(id) ? id.slice(0, 12) : String(id))

/**
 * `실행 계획`에 붙일 블록. **스냅숏 객체만 읽는다** — 그래서 리포트의 블록과 JSON은 같은
 * 것을 말하고, 저장된 JSON에서 언제든 같은 블록을 다시 만들 수 있다.
 */
export function renderSnapshotMarkdown(snapshot) {
  const { counts, modules } = snapshot.scope
  const lines = [
    `**검토 상태: ${STATUS_TEXT[snapshot.status]}** — 적용 ${counts.applied}개 중 수집 ${counts.ok} · \`FAILED\` ${counts.failed} · 결과 없음 ${counts.missing} (띄우지 않음: \`SKIPPED\` ${counts.skipped} · \`UNKNOWN\` ${counts.unknown})`,
  ]
  const rows = modules.filter(module => module.state !== 'ok').map(module => {
    const reason = module.state === 'failed'
      ? `시도 ${module.attempt}${module.failureClass !== undefined ? ` · ${codeSpan(module.failureClass)}` : ''}${module.cancelReason !== undefined ? ` · ${HALT_TEXT[module.cancelReason] ?? codeSpan(module.cancelReason)}` : ''}`
      : module.state === 'missing'
        ? `${MISSING_TEXT[module.reason]}${module.reason === 'halted' ? ` (${HALT_TEXT[module.haltReason] ?? codeSpan(module.haltReason)})` : ''}`
        : module.reason !== undefined ? escapeProse(module.reason) : '사유가 기록되지 않았다'
    const state = { failed: '`FAILED`', missing: '결과 없음', skipped: '`SKIPPED`', unknown: '`UNKNOWN`' }[module.state]
    return `| ${codeSpan(module.name)} | ${state} | ${module.state === 'missing' ? reason.replace(/^결과 없음 — /, '') : reason} |`
  })
  if (rows.length) lines.push('', '| 모듈 | 상태 | 사유 |', '|------|------|------|', ...rows)

  const halted = snapshot.dispatch?.halted
  if (halted) {
    lines.push('', `**디스패치를 멈췄다** — ${HALT_TEXT[halted.reason] ?? codeSpan(halted.reason)}(${codeSpan(halted.at)}). 멈춘 뒤 띄우지 못한 모듈과 검증 작업은 이 실행이 검토하지 않은 범위다 — 판정을 받지 못한 지적은 \`검증 실패\`로 표시된다.`)
  }

  const { target, run } = snapshot
  const worktree = target.worktree === 'clean' ? 'clean' : `커밋하지 않은 변경 ${target.dirtyFiles}개 (${codeSpan(target.worktree.slice(0, 19))}…)`
  lines.push('', `검토 대상: HEAD ${codeSpan(short(target.head))} · 작업 트리 ${worktree} · base ${codeSpan(target.base)} (merge-base ${codeSpan(short(target.mergeBase))}) · 실행 ID ${codeSpan(run.runId)}`)
  if (snapshot.drift.length) {
    const changes = snapshot.drift.map(entry => `${entry.field} ${codeSpan(short(entry.recorded))} → ${codeSpan(short(entry.current))}`).join(' · ')
    lines.push('', `**검토 도중 대상이 바뀌었다** — ${changes}. 이 실행의 결과는 한 시점의 코드에 대한 것이 아니다.`)
  }
  lines.push('', `출처: \`review-snapshot.mjs\` · ${codeSpan(`.timing/${run.name}.snapshot.json`)}`)
  return lines.join('\n')
}
