#!/usr/bin/env node
// 리포트의 `상세 지적`과 `특수 패스`를 구조화 입력에서 결정적으로 만든다.
//
// 왜 있는가: 같은 명령이 실행마다 다른 모양의 지적을 냈다. 표 한 행에 밀어
// 넣거나, 영어 등급을 쓰거나, 위치 줄을 빼먹었다. 규칙은 이미 계약에 다
// 있었는데도 그랬다 — 문서가 모델에게 부탁하는 동안에는 지켜지지 않는다.
//
// 이 저장소는 같은 종류의 문제를 두 번 코드로 옮겼다. 후보 모듈 수는
// preflight가, 교차검증 판정 수는 tally가 센다. 표기도 같은 일이다.
//
// Usage:
//   node scripts/render-findings.mjs --input <prepare-verification 출력> \
//        [--verdicts <경로> …] --phase-high <active-deletion|rollout-shadow> \
//        --phase-low <active-deletion|rollout-shadow> \
//        [--deletion-approval <승인 파일> — active-deletion을 줄 때만, 그때는 필수] \
//        --verification-state <ran|disabled> --rules <RULES_DIR> --workflow <이름>
//   node scripts/render-findings.mjs --print-deletion-basis --rules <RULES_DIR>
//        — 승인 파일의 basis에 적을 지금의 기준(JSON)을 낸다

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { markedBlock, markedJson, CROSS_VERIFICATION_TOKEN_KEYS } from './lib/contract-blocks.mjs'
import { assessEvidence, loadEvidence } from './lib/evidence.mjs'
import { finalizeCurrent } from './lib/review-compare.mjs'
import { collectVerdicts } from './lib/verdicts.mjs'
import { instructionsWithManifest } from './lib/verifier-tasks.mjs'

const IMPACTS = new Set(['high', 'low'])
const CONFIDENCES = new Set(['high', 'low'])
const LOCATION_KINDS = new Set(['verified', 'deleted', 'unverified'])
// `prepare-verification.mjs`의 checkLocation이 내는 닫힌 목록이다. 이 값이
// 렌더러의 --input(routed.json)에 이미 들어 있는데 여태 쓰이지 않았다 —
// 2026-09-28 실행은 후보 5건 중 4건이 여기서 실패한 상태로 리포트까지 갔다.
const LOCATION_CHECKS = new Set(['location-ok', 'location-mismatch', 'location-unresolvable', 'not-applicable'])
const PHASES = new Set(['active-deletion', 'rollout-shadow'])
const VERIFICATION_STATES = new Set(['ran', 'disabled'])

const die = message => {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

/**
 * 그릴 수 없는 입력을 모아서 돌려준다.
 *
 * 하나 만나고 멈추지 않는 이유: 고치고 다시 돌리는 왕복을 줄인다. 렌더러는
 * 결정적이고 값싸므로 전부 보여주고 한 번에 고치게 하는 편이 낫다.
 *
 * 왜 그리지 않고 멈추는가: 모르는 값을 흘려보내면 결과는 그럴듯하고 등급만
 * 틀린다. 틀린 등급이 실린 리포트는 읽는 사람이 알 수 없다.
 */
export function validateCandidates(candidates) {
  const problems = []
  for (const candidate of candidates ?? []) {
    const id = candidate?.candidateId ?? '(candidateId 없음)'
    if (!IMPACTS.has(candidate?.impact)) {
      problems.push(`${id}: impact가 닫힌 목록 밖이다 (${JSON.stringify(candidate?.impact)}) — 등급을 만들 수 없다`)
    }
    if (!CONFIDENCES.has(candidate?.confidence)) {
      problems.push(`${id}: confidence가 닫힌 목록 밖이다 (${JSON.stringify(candidate?.confidence)}) — 등급을 만들 수 없다`)
    }
    if (!LOCATION_KINDS.has(candidate?.location?.kind)) {
      problems.push(`${id}: location.kind가 닫힌 목록 밖이다 (${JSON.stringify(candidate?.location?.kind)})`)
    }
    // `location.kind`는 producer가 **주장한** 위치의 종류고, `locationCheck`는
    // 그 주장을 실제 트리에 대고 맞춰 본 결과다. 둘은 다른 사실이며, 여기서
    // 후자가 없으면 렌더러는 확인되지 않은 주장을 확인된 위치처럼 그린다 —
    // 00-10이 🔴로 막는 바로 그것이다. 없으면 "확인하지 않았다"가 아니라
    // "확인했는지 알 수 없다"이므로 기본값으로 흘려보내지 않고 거부한다.
    if (!LOCATION_CHECKS.has(candidate?.locationCheck)) {
      problems.push(`${id}: locationCheck가 닫힌 목록 밖이다 (${JSON.stringify(candidate?.locationCheck)}) — 주장된 위치를 확인했는지 알 수 없다`)
    } else if (candidate.locationCheck === 'not-applicable'
      && (candidate?.location?.kind === 'verified' || candidate?.location?.kind === 'deleted')) {
      // `not-applicable`은 checkLocation이 `unverified`에만 주는 값이다.
      // 맞춰 볼 수 있는 위치를 맞춰 보지 않았다는 조합이라, 통과시키면
      // locationCheck를 요구한 의미가 그대로 사라진다.
      problems.push(`${id}: location.kind가 ${candidate.location.kind}인데 locationCheck가 not-applicable이다 — 확인할 수 있는 위치를 확인하지 않았다`)
    }
    // 계약(REVIEW_RESULT_CONTRACT_V1의 location.variants)은 endLine에
    // verified면 `positive-and-gte-line`, deleted면 `positive-and-gte-lineBefore`
    // 제약을 건다. endLine이 시작 줄보다 작으면 locationLine이 `10-5`처럼
    // 뒤집힌 범위를 그리는데, 이 계약 위반을 여태 아무도 잡지 않았다 —
    // 등급뿐 아니라 위치도 "만들 수 없는" 입력이면 여기서 걸러야 한다.
    if (candidate?.location?.kind === 'verified' || candidate?.location?.kind === 'deleted') {
      const start = candidate.location.kind === 'verified' ? candidate.location.line : candidate.location.lineBefore
      const { endLine } = candidate.location
      if (endLine !== undefined && typeof start === 'number' && (typeof endLine !== 'number' || endLine < start)) {
        const startField = candidate.location.kind === 'verified' ? 'line' : 'lineBefore'
        problems.push(`${id}: location.endLine(${JSON.stringify(endLine)})이 ${startField}(${start})보다 작다 — 범위가 뒤집힌다`)
      }
    }
    for (const key of ['title', 'body']) {
      if (typeof candidate?.content?.[key] !== 'string' || !candidate.content[key]) {
        problems.push(`${id}: content.${key}가 없다`)
      }
    }
    if (candidate?.severity !== undefined) {
      problems.push(`${id}: severity는 producer 금지 필드다 — 등급은 렌더러가 만든다`)
    }
  }
  return problems
}

/**
 * 어휘를 코드에 박지 않는다. 박는 순간 문서와 출력이 갈라질 수 있다.
 *
 * `categoryLabels`는 manifest의 최상위 `impact.categoryLabels`에만 있다
 * (`findingsItem`에는 `impact`라는 하위 필드가 없다 — `impact`는 값 자체의
 * 이름이다). 폴백 체인을 두면 실제로는 존재하지 않는 경로가 코드에 살아남아,
 * 다음 계약 개정에서 어느 경로가 진짜인지 다시 헷갈리게 만든다.
 */
export function loadVocabulary(rulesDir) {
  let contract
  try {
    contract = readFileSync(join(rulesDir, 'workflow-contract.md'), 'utf8')
  } catch (error) {
    return { error: `workflow-contract.md를 읽지 못했다: ${error.message}` }
  }
  const manifest = markedJson(contract, 'REVIEW_RESULT_CONTRACT_V1')
  if (manifest.error) return { error: manifest.error }
  const tokens = markedJson(contract, 'CROSS_VERIFICATION_RENDER_TOKENS')
  if (tokens.error) return { error: tokens.error }
  const categoryLabels = manifest.value?.impact?.categoryLabels
  // 맵이 없거나 객체가 아니면 조용히 undefined로 흘려보내지 않는다. 그러면
  // high-impact finding이 한국어 라벨 대신 원시 enum(`data-loss`)으로
  // 그려지고, 그 상태로도 렌더는 "성공"한다 — 멈추는 것보다 더 나쁘다.
  if (categoryLabels === null || typeof categoryLabels !== 'object') {
    return { error: 'REVIEW_RESULT_CONTRACT_V1의 impact.categoryLabels 맵을 찾지 못했다' }
  }
  // categoryLabels는 맵의 **존재**만 봐도 됐다 — 라벨이 빠지면 원시 enum이
  // 그려져 리포트에 흔적이 남는다. 교차검증 토큰은 그렇지 않다. 키 하나가
  // 빠지면 라벨이 undefined가 되고, 축 줄은 "이 워크플로우에 교차검증 축이
  // 없다"와 같은 방식으로 **통째로 빠진다.** 검증을 끈 실행이 검증 축 자체가
  // 없는 워크플로우처럼 보이는데, 리포트만 보고는 그 차이를 알 수 없다.
  // 그래서 존재가 아니라 키 하나하나를 본다.
  const crossVerification = tokens.value?.tokens
  if (crossVerification === null || typeof crossVerification !== 'object') {
    return { error: 'CROSS_VERIFICATION_RENDER_TOKENS의 tokens 맵을 찾지 못했다' }
  }
  const badTokens = CROSS_VERIFICATION_TOKEN_KEYS
    .filter(key => typeof crossVerification[key] !== 'string' || !crossVerification[key])
  if (badTokens.length) {
    return { error: `CROSS_VERIFICATION_RENDER_TOKENS에 비어 있지 않은 문자열이 아닌 키가 있다: ${badTokens.join(', ')}` }
  }
  const rebuttal = loadRebuttalTaxonomy(contract, crossVerification)
  if (rebuttal.error) return { error: rebuttal.error }
  return {
    value: {
      categoryLabels,
      crossVerification,
      ...rebuttal.value,
    },
  }
}

/**
 * 반박이 지적을 지울 수 있는지는 판정 manifest의 `rebuttal.deletionAllowingKinds`가 정한다.
 *
 * 한때 렌더러는 `other`만 코드에 박아 두고 나머지 반박은 전부 지웠다. 그래서 manifest의
 * 목록은 아무도 읽지 않는 선언이었고, 그 목록에 `location-wrong`("결함은 성립하나 위치가
 * 틀렸다")이 들어 있어도 아무것도 걸리지 않았다 — 검증자가 결함을 **인정한** 지적이 줄
 * 번호가 틀렸다는 이유로 active-deletion에서 사라질 수 있었다(#45). 목록을 여기서 읽고,
 * 읽지 못하면 멈춘다. 기본값으로 지우는 길을 두면 같은 일이 다시 조용히 일어난다.
 *
 * 삭제를 허용하지 않는 kind마다 `rejected-<kind>` 토큰이 있어야 한다. 그 반박은 어느
 * phase에서도 지적을 남기므로 제 이름의 표기가 필요한데, 토큰이 없으면 그리는 도중에야
 * 알게 된다.
 */
function loadRebuttalTaxonomy(contract, crossVerification) {
  const manifest = markedJson(contract, 'REVIEW_VERDICT_CONTRACT_V1')
  if (manifest.error) return { error: manifest.error }
  const kinds = manifest.value?.rebuttal?.kindEnum
  const deleting = manifest.value?.rebuttal?.deletionAllowingKinds
  const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string' && item)
  if (!strings(kinds) || !kinds.length) {
    return { error: 'REVIEW_VERDICT_CONTRACT_V1의 rebuttal.kindEnum을 찾지 못했다 — 반박 kind를 가를 수 없다' }
  }
  if (!strings(deleting)) {
    return { error: 'REVIEW_VERDICT_CONTRACT_V1의 rebuttal.deletionAllowingKinds를 찾지 못했다 — 어떤 반박이 지적을 지우는지 알 수 없어 멈춘다' }
  }
  const unknown = deleting.filter(kind => !kinds.includes(kind))
  if (unknown.length) {
    return { error: `rebuttal.deletionAllowingKinds에 kindEnum 밖의 값이 있다: ${unknown.join(', ')}` }
  }
  const unlabelled = kinds
    .filter(kind => !deleting.includes(kind))
    .filter(kind => typeof crossVerification[`rejected-${kind}`] !== 'string' || !crossVerification[`rejected-${kind}`])
  if (unlabelled.length) {
    return { error: `삭제를 허용하지 않는 반박 kind에 표기 토큰이 없다: ${unlabelled.map(kind => `rejected-${kind}`).join(', ')}` }
  }
  return { value: { rebuttalKinds: kinds, deletionAllowingKinds: deleting } }
}

// ------------------------------------------------------------ 삭제 승인 (C-6B, #47)
//
// 반박된 지적이 리포트에서 사라지는 것은 되돌릴 수 없고, 틀렸을 때 리포트가 더 깨끗해 보이는
// 쪽으로 실패한다. 그런데 그것을 막는 것은 `rollout-shadow`가 "기본"이라는 계약 문장 하나였고,
// `--phase-low active-deletion` 한 단어로 켜졌다 — SKILL의 명령 틀이 두 값을 나란히 보여주기까지
// 했다. 그래서 active-deletion은 사람이 잰 승인 파일이 있을 때만 켠다.
//
// 승인은 그때의 검증자를 잰 것이지 파이프라인 일반에 대한 것이 아니다. 렌더러가 확인할 수 있는
// 것(반박 kind 목록, 검증자 지시문)은 해시로 맞춰 보고, 달라졌으면 그 impact를 rollout-shadow로
// 되돌린다. 확인할 수 없는 것(검증자 모델)은 승인 파일에 사람이 읽을 기록으로만 남는다 —
// 렌더러가 그것을 검사한다고 말하지 않는다.

const ROUTES = ['isolated', 'bundle']
const BASIS_KEYS = ['rebuttalSha256', 'verifierPromptSha256']
const BASIS_NAMES = { rebuttalSha256: '반박 kind 목록', verifierPromptSha256: '검증자 지시문' }

const sha256 = text => createHash('sha256').update(text).digest('hex')

/** 키 순서와 공백에 흔들리지 않는 직렬화 — 같은 manifest는 같은 해시가 된다. 배열 순서는 그대로 둔다. */
const canonicalJson = value => JSON.stringify(value, (_key, inner) => (inner && typeof inner === 'object' && !Array.isArray(inner)
  ? Object.fromEntries(Object.keys(inner).sort().map(name => [name, inner[name]]))
  : inner))

/**
 * 승인이 잰 검증자를 가리키는 지금의 기준.
 *
 * - `rebuttalSha256`: 판정 manifest의 `rebuttal` 객체(kindEnum·kindLabels·deletionAllowingKinds…).
 *   어떤 반박이 무엇을 지우는지가 여기서 정해진다
 * - `verifierPromptSha256`: 검증자가 실제로 받는 지시문 — `verifier-prompt.md`의 `VERIFIER_PROMPT`
 *   블록에 판정 manifest를 끼운 것. `prepare-verification.mjs`가 작업마다 이것 뒤에 후보를 붙인다.
 *   후보·조항·의도처럼 작업마다 다른 부분은 들어가지 않는다
 *
 * 줄 끝은 LF로 맞춰 잰다. 같은 저장소도 체크아웃 설정에 따라 CRLF로 풀리는데, 그것 때문에 승인이
 * 무효가 되면 승인을 쓴 기계에서만 삭제가 켜진다.
 *
 * 검증자 모델과 라우팅 규칙(`prepare-verification.mjs`의 코드)은 여기 없다. 렌더러가 읽을 수 있는
 * 파일에 그 사실이 없기 때문이다.
 */
export function deletionBasis(rulesDir) {
  const readRule = name => {
    try {
      return { value: readFileSync(join(rulesDir, name), 'utf8') }
    } catch (error) {
      return { error: `${name}를 읽지 못했다: ${error.message}` }
    }
  }
  const contract = readRule('workflow-contract.md')
  if (contract.error) return contract
  const prompt = readRule('verifier-prompt.md')
  if (prompt.error) return prompt
  const manifest = markedJson(contract.value, 'REVIEW_VERDICT_CONTRACT_V1')
  if (manifest.error) return { error: manifest.error }
  const rebuttal = manifest.value?.rebuttal
  if (!rebuttal || typeof rebuttal !== 'object') return { error: 'REVIEW_VERDICT_CONTRACT_V1에 rebuttal이 없다 — 삭제 승인의 기준을 만들 수 없다' }
  const manifestBlock = markedBlock(contract.value, 'REVIEW_VERDICT_CONTRACT_V1')
  if (manifestBlock.error) return { error: manifestBlock.error }
  const template = markedBlock(prompt.value, 'VERIFIER_PROMPT')
  if (template.error) return { error: `verifier-prompt.md: ${template.error}` }
  const instructions = instructionsWithManifest(template.value, manifestBlock.value)
  if (instructions.error) return { error: instructions.error }
  return {
    value: {
      rebuttalSha256: sha256(canonicalJson(rebuttal)),
      verifierPromptSha256: sha256(instructions.value.replace(/\r\n/g, '\n')),
    },
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isRate = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
const isDate = value => {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.toISOString().slice(0, 10) === value
}

/**
 * 승인 파일을 계약(C-6B `삭제 rollout phase`)에 맞춰 본다. 문제가 없으면 빈 배열이다.
 *
 * 느슨하게 받지 않는다. 모르는 키를 넘기면 오타 난 `threshhold`가 조용히 무시되고 허용치 없는
 * 승인이 통과한다. 잰 값이 허용치를 넘는 승인도 거부한다 — 그 측정은 삭제를 허락하지 않았다.
 *
 * 경로(`isolated`·`bundle`)마다 따로 잰다. bundle 검증자는 컨텍스트가 모자란 줄 모르고 반박할
 * 수 있어, 둘을 합쳐 재면 bundle의 오판이 희석된다. 승인에 없는 경로의 반박은 지우지 않는다.
 */
export function validateDeletionApproval(approval) {
  const problems = []
  const exactKeys = (value, allowed, where) => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) problems.push(`${where}에 모르는 키 ${key}가 있다`)
    for (const key of allowed) if (!Object.hasOwn(value, key)) problems.push(`${where}에 ${key}가 없다`)
  }
  if (!isObject(approval)) return ['승인 파일이 JSON 객체가 아니다']
  exactKeys(approval, ['schemaVersion', 'approvals'], '최상위')
  if (approval.schemaVersion !== 1) problems.push(`schemaVersion은 1이다 (받은 값: ${JSON.stringify(approval.schemaVersion)})`)
  if (!isObject(approval.approvals) || !Object.keys(approval.approvals).length) {
    problems.push('approvals는 impact(high·low)별 승인을 담은 비어 있지 않은 객체다')
    return problems
  }
  for (const [impact, entry] of Object.entries(approval.approvals)) {
    const where = `approvals.${impact}`
    if (!IMPACTS.has(impact)) { problems.push(`${where}: impact는 high·low뿐이다`); continue }
    if (!isObject(entry)) { problems.push(`${where}가 객체가 아니다`); continue }
    exactKeys(entry, ['approvedBy', 'approvedAt', 'verifierModel', 'falseSuppression', 'basis'], where)
    for (const key of ['approvedBy', 'verifierModel']) {
      if (typeof entry[key] !== 'string' || !entry[key].trim()) problems.push(`${where}.${key}는 비어 있지 않은 문자열이다`)
    }
    if (!isDate(entry.approvedAt)) problems.push(`${where}.approvedAt은 YYYY-MM-DD 날짜다 (받은 값: ${JSON.stringify(entry.approvedAt)})`)
    if (!isObject(entry.falseSuppression) || !Object.keys(entry.falseSuppression).length) {
      problems.push(`${where}.falseSuppression은 경로(${ROUTES.join('·')})별 측정을 담은 비어 있지 않은 객체다`)
    } else {
      for (const [route, measurement] of Object.entries(entry.falseSuppression)) {
        const at = `${where}.falseSuppression.${route}`
        if (!ROUTES.includes(route)) { problems.push(`${at}: 경로는 ${ROUTES.join('·')}뿐이다`); continue }
        if (!isObject(measurement)) { problems.push(`${at}가 객체가 아니다`); continue }
        exactKeys(measurement, ['measured', 'threshold', 'samples'], at)
        if (!isRate(measurement.measured)) problems.push(`${at}.measured는 0 이상 1 이하의 수다`)
        if (!isRate(measurement.threshold)) problems.push(`${at}.threshold는 0 이상 1 이하의 수다`)
        if (!Number.isInteger(measurement.samples) || measurement.samples < 1) problems.push(`${at}.samples는 1 이상의 정수다`)
        if (isRate(measurement.measured) && isRate(measurement.threshold) && measurement.measured > measurement.threshold) {
          problems.push(`${at}: 잰 false-suppression ${measurement.measured}이 허용치 ${measurement.threshold}를 넘는다 — 이 측정은 삭제를 허락하지 않는다`)
        }
      }
    }
    if (!isObject(entry.basis)) {
      problems.push(`${where}.basis가 객체가 아니다 — --print-deletion-basis의 출력을 적는다`)
    } else {
      exactKeys(entry.basis, BASIS_KEYS, `${where}.basis`)
      for (const key of BASIS_KEYS) {
        if (typeof entry.basis[key] !== 'string' || !/^[0-9a-f]{64}$/.test(entry.basis[key])) problems.push(`${where}.basis.${key}는 소문자 16진수 64자(sha256)다`)
      }
    }
  }
  return problems
}

/**
 * 요청한 phase와 승인 파일로 이 실행의 실제 phase를 정한다.
 *
 * - active-deletion을 요청한 impact의 승인이 파일에 없으면 `{ error }` — high와 low는 따로 승인한다
 * - 승인의 기준이 지금과 다르면 그 impact는 rollout-shadow로 돈다(`invalidated`에 무엇이 바뀌었는지)
 * - 맞으면 active-deletion이고, 승인이 잰 경로(`routes`)의 반박만 지운다
 *
 * 승인은 이미 `validateDeletionApproval`을 통과한 것이어야 한다.
 */
export function gateDeletion(requested, approval, basis) {
  const impacts = {}
  const warnings = []
  for (const impact of ['high', 'low']) {
    if (requested[impact] !== 'active-deletion') {
      impacts[impact] = { phase: requested[impact] }
      continue
    }
    const entry = approval?.approvals?.[impact]
    if (!entry) {
      return { error: `--phase-${impact} active-deletion인데 승인 파일에 approvals.${impact}가 없다 — 영향 높음과 낮음은 따로 재고 따로 승인한다` }
    }
    const changed = BASIS_KEYS.filter(key => entry.basis[key] !== basis[key]).map(key => BASIS_NAMES[key])
    if (changed.length) {
      impacts[impact] = { phase: 'rollout-shadow', invalidated: changed, approval: entry }
      warnings.push(`경고: 영향 ${IMPACT_WORD[impact]}의 active-deletion 승인(${entry.approvedBy}, ${entry.approvedAt})이 무효다 — 승인 뒤에 ${changed.join('·')}이 바뀌었다. 이 실행은 영향 ${IMPACT_WORD[impact]}을 rollout-shadow로 돈다. 다시 재서 승인하려면 --print-deletion-basis로 지금의 기준을 본다`)
      continue
    }
    impacts[impact] = { phase: 'active-deletion', approval: entry, routes: ROUTES.filter(route => Object.hasOwn(entry.falseSuppression, route)) }
  }
  return { value: { phaseByImpact: { high: impacts.high.phase, low: impacts.low.phase }, impacts, warnings } }
}

/**
 * `## 상세 지적` 맨 위에 둘 삭제 단계 줄. 지울 수 있는 phase가 없고 무효가 된 승인도 없으면 null이다 —
 * 둘 다 rollout-shadow인 실행의 출력은 이 기능 전과 같다.
 *
 * 지운 지적의 흔적은 stderr로 나가 오케스트레이터가 `미해결 / 후속 확인`에 옮겨 적는다. 그 사실과
 * 별개로, 이 절을 읽는 사람이 "여기 없는 반박 지적이 있을 수 있다"를 이 절 안에서 알아야 한다.
 * 그렇지 않으면 삭제가 켜진 리포트와 켜지지 않은 리포트가 같은 모양이다. 승인 정보 없이 render를
 * 직접 부른 경우에도 줄을 낸다 — 승인 기록이 없다고 적는다.
 */
export function deletionPhaseLine(phaseByImpact, gate) {
  const impacts = ['high', 'low']
  const active = impacts.filter(impact => phaseByImpact[impact] === 'active-deletion')
  const invalidated = impacts.filter(impact => gate?.impacts?.[impact]?.invalidated?.length)
  if (!active.length && !invalidated.length) return null
  const part = impact => {
    const phase = phaseByImpact[impact]
    const info = gate?.impacts?.[impact]
    let detail = ''
    if (phase === 'active-deletion') {
      detail = info?.approval
        ? ` (승인 ${escapeProse(info.approval.approvedBy)} · ${info.approval.approvedAt} · ${info.routes.join('·')} 경로${info.routes.length < ROUTES.length ? '만' : ''})`
        : ' (승인 기록 없음)'
    } else if (info?.invalidated?.length) {
      detail = ` (active-deletion 승인 무효 — 승인 뒤에 ${info.invalidated.join('·')}이 바뀌었다)`
    }
    return `영향 ${IMPACT_WORD[impact]} \`${phase}\`${detail}`
  }
  const tail = active.length
    ? '반박돼 이 절에서 지운 지적의 흔적은 `미해결 / 후속 확인`에 있다'
    : '반박된 지적은 지우지 않고 모두 이 절에 있다'
  return `삭제 단계: ${impacts.map(part).join(' · ')} — ${tail}`
}

const flag = name => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}
const flagAll = name => process.argv
  .map((arg, at) => (arg === `--${name}` ? process.argv[at + 1] : null))
  .filter(value => value !== null && value !== undefined)

const IMPACT_WORD = { high: '높음', low: '낮음' }

const NOT_COLLECTED = '결과 없음 — 수집된 결과 파일이 없다. 실행이 실패했거나 결과가 빠졌다는 뜻이고, 지적 0건과 다르다.'

/** 등급은 규칙이 아니라 지적이 갖는다 — `00-rule.md`의 파생표 그대로다. */
export function severityOf(impact, confidence) {
  if (impact === 'high') return confidence === 'high' ? '🔴' : '🟡'
  return confidence === 'high' ? '🟡' : '🔵'
}

/**
 * producer 문자열이 오케스트레이터가 쓴 것처럼 보이는 구조를 만들지 못하게 한다.
 *
 * 계약은 이 escape를 요구하면서 "정적 validator는 실제 escaping을 증명하지
 * 않는다"고 스스로 적어 두었다. 여기가 그 규칙의 첫 실행 주체다.
 *
 * 개행을 포함한 공백 연속을 먼저 한 칸으로 접는다. `본문: ` 같은 라벨
 * 접두어는 producer 텍스트가 0번 컬럼에서 시작하는 것만 막을 뿐, 텍스트
 * 안에 박힌 개행이 그 뒤의 `<div>`나 `---`, `1. `을 다시 0번 컬럼으로
 * 되돌리는 것은 못 막는다 — 개행 자체가 escape 대상 문자 집합에 없으면
 * 슬롯 하나가 여러 물리 줄로 샌다("있는 것만, 각자 한 줄"이 깨진다). 접은
 * 뒤에도 문자 수를 보존해야 하므로 삭제 대신 공백 하나로 대체한다.
 *
 * `<`는 별도 escape 대상이다 — `>`를 escape해도 여는 태그(`<script>`)는
 * 열린 채로 남고, CommonMark는 여는 델리미터만으로 HTML 블록/인라인 HTML을
 * 인식한다.
 *
 * **escape가 수식 구분자를 만들면 안 된다.** 한때 `[`·`]`·`(`·`)`를 `\[`·`\]`·
 * `\(`·`\)`로 바꿨는데, KaTeX를 쓰는 Markdown 뷰어에서 `\[ … \]`는 수식 블록,
 * `\( … \)`는 인라인 수식이다. 2026-09-30 리포트에서 `[0, 0, 1]`이 "0 , 0 , 1
 * 0,0,1"로 쪼개지고 `-8`이 `−8`로 보였다. 링크를 막는 데 필요한 것은 대괄호뿐이다 —
 * `[텍스트]`가 없으면 `(url)`은 그냥 글자다. 그래서 대괄호는 역슬래시가 아니라
 * 문자 참조(`&#91;`·`&#93;`)로 바꾸고 괄호는 건드리지 않는다. `$`는 `$ … $` 수식을
 * 열므로 `\$`로 막는다.
 */
const PROSE_ESCAPES = { '[': '&#91;', ']': '&#93;' }

export function escapeProse(text) {
  const collapsed = String(text).replace(/\s+/g, ' ').trim()
  return collapsed.replace(/[\\`*_[\]#>|<$]/g, match => PROSE_ESCAPES[match] ?? `\\${match}`)
}

/**
 * 인용 안의 backtick과 충돌하지 않는 가장 짧은 delimiter를 고른다.
 *
 * `path`·`quote`는 producer가 채우는 신뢰하지 않는 값이라 개행이 그대로
 * 들어올 수 있다. 단순 개행은 위치 줄을 여러 물리 줄로 새게 할 뿐이지만,
 * 빈 줄(개행 두 번)은 그보다 나쁘다 — CommonMark의 code span은 빈 줄을
 * 담지 못해 여는 backtick의 짝이 사라지고, 그 지점부터 리포트 구조 전체가
 * 깨진다. 그래서 개행(과 개행 연속인 빈 줄)만 한 칸으로 바꾼다.
 *
 * escapeProse처럼 공백 전체를 접거나 trim하지 않는 이유: quote는 실제
 * 소스 한 줄이고 들여쓰기는 그 줄이 코드에서 얼마나 깊이 있는지를 말해주는
 * 내용이다. escapeProse가 다루는 producer 산문은 공백의 양 자체가 의미를
 * 안 갖지만, quote는 다르다 — `    if (pending) return`을 ` if (pending)
 * return`으로 접으면 quote가 보여주려던 것의 일부(들여쓰기 깊이)가
 * 사라진다. 개행만 골라 바꾸면 리포트 구조를 깨는 문제(위치 줄이 여러
 * 물리 줄로 새는 것)는 그대로 막으면서 들여쓰기는 건드리지 않는다.
 *
 * delimiter 길이는 개행을 바꾼 뒤의 값으로 잰다 — 순서가 반대면 개행으로
 * 갈라져 있던 backtick 연속을 실제보다 짧게 셀 수 있다.
 */
export function codeSpan(text) {
  const value = String(text).replace(/[\r\n]+/g, ' ')
  const longest = (value.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0)
  const fence = '`'.repeat(longest + 1)
  const pad = longest > 0 ? ' ' : ''
  return `${fence}${pad}${value}${pad}${fence}`
}

/**
 * 위치 줄을 만든다. **확인된 위치와 확인에 실패한 위치를 같은 모양으로 그리지
 * 않는다.**
 *
 * 원래는 `location`만 받아 경로와 인용을 그대로 찍었다. 그런데 그 위치를 실제
 * 트리에 대고 맞춰 본 결과(`locationCheck`)는 `prepare-verification.mjs`가
 * 이미 계산해 렌더러의 입력에 실어 보내고 있었다. 그것을 보지 않으면 렌더러는
 * **파이프라인이 이미 틀렸다고 판정한 위치를 확인된 위치처럼 찍는다.**
 *
 * 2026-09-28 실행이 그 상태였다 — 후보 5건 중 3건은 주장된 경로가 HEAD에도
 * merge-base에도 없었고 1건은 인용이 실제 내용과 달랐다. 그 실행의 리포트는
 * 사람이 손으로 써서 위치를 못 찾았다는 사실을 적었지만, 렌더러가 그리면
 * 없는 파일의 줄 번호가 사실처럼 찍힌다. 00-10이 🔴로 막는 것이 정확히
 * 그것이다 — "틀린 위치를 가리키는 지적은 지적이 아니다".
 *
 * 인용(`quote`)은 확인 실패 시 다시 찍지 않는다. 그 인용이 그 자리에 없다는
 * 것이 지금 말하는 사실인데, 같은 줄에 한 번 더 찍으면 읽는 사람이 그것을
 * 코드로 읽는다. 대신 실제로 그 자리에 있던 것(`observed`)을 찍는다.
 */
const anchorText = location => {
  const start = location.kind === 'deleted' ? location.lineBefore : location.line
  // endLine은 계약(REVIEW_RESULT_CONTRACT_V1의 location.variants)이 verified·
  // deleted 모두에 허용하는 선택 필드다. start만 쓰면 여러 줄짜리 인용의
  // 끝이 사라진다(`42-45`가 `42`로 접힌다). start와 같으면(단일 줄을
  // endLine으로도 반복해 보낸 경우) 범위로 부풀리지 않는다 — `1-1`은
  // `1`이 이미 말하는 것을 더 말하지 않는다.
  const line = typeof location.endLine === 'number' && location.endLine !== start
    ? `${start}-${location.endLine}`
    : `${start}`
  return codeSpan(`${location.path}:${line}`)
}

const locationLine = candidate => {
  const location = candidate.location
  if (location.kind === 'unverified') return `위치 미확인 사유: ${escapeProse(location.reason)}`
  const anchor = anchorText(location)
  if (candidate.locationCheck === 'location-unresolvable') {
    return `위치 확인 실패: ${anchor} — 리뷰 대상 트리에서 그 경로를 읽지 못했습니다`
  }
  if (candidate.locationCheck === 'location-mismatch') {
    // observed가 없는 경우는 줄 범위가 파일 밖이라 읽을 내용 자체가 없었던
    // 때다. 그때는 "실제" 칸을 비워 두지 않고 줄에서 뺀다 — 빈 code span은
    // 무엇을 봤다는 뜻으로 읽힌다.
    const observed = typeof candidate.observed === 'string' && candidate.observed
      ? ` · 실제 ${codeSpan(candidate.observed)}`
      : ''
    return `위치 확인 실패: ${anchor} — 인용과 실제 내용이 다릅니다${observed}`
  }
  return `${anchor} — ${codeSpan(location.quote)}`
}

/**
 * `location-wrong` 반박이 짚은 자리를 그린다.
 *
 * 그 반박은 "결함은 성립하나 위치가 틀렸다"이고 `rebuttal.location`이 검증자가 본 결함의
 * 자리다. 지적은 남기고(어느 phase에서도 지우지 않는다) producer의 위치 줄도 그대로 둔다 —
 * 둘 중 어느 쪽이 맞는지는 이 렌더러가 정하지 않는다. 읽는 사람이 두 자리를 함께 봐야 한다.
 *
 * 이 위치는 `prepare-verification.mjs`의 위치 대조를 거치지 않은 검증자의 주장이다. 확인된
 * 위치와 같은 모양으로 찍으면 00-10이 막는 것 — 확인하지 않은 위치를 사실처럼 쓰는 것 —
 * 이 되므로, 줄 머리에 대조하지 않았다고 적는다. 판정에 위치가 없으면(계약 위반) 빈 칸 대신
 * 그 사실을 적는다.
 */
const verifierLocationLine = location => {
  if (!location || (location.kind !== 'verified' && location.kind !== 'deleted')) {
    return '검증자가 짚은 위치: 판정에 위치가 없다'
  }
  const quote = typeof location.quote === 'string' && location.quote ? ` — ${codeSpan(location.quote)}` : ''
  return `검증자가 짚은 위치(대조하지 않음): ${anchorText(location)}${quote}`
}

/**
 * `출처 패스` 줄을 만든다 — 병합된 finding이 기여한 모든 source/pass label을
 * 보존해야 한다는 계약(워크플로우 계약 203·244행)을 렌더링에서 지킨다.
 *
 * `sources`(exactDedup이 병합할 때만 채우는 배열)가 있으면 그걸 쓰고, 없으면
 * 단일 기여자인 `source` 하나만 쓴다. 둘 다 없으면 `null`을 돌려줘 이 줄
 * 자체를 뺀다 — producer가 출처 라벨을 안 붙인 경로(예: 아직 이 필드를
 * 채우지 않는 워크플로우)에서 빈 줄을 강제로 만들지 않는다.
 *
 * 여러 라벨은 쉼표로 나열한다 — 축 줄이 쓰는 " · "는 "서로 다른 종류의
 * 사실을 한 줄에 나열"하는 구분자이고, 여기는 "같은 종류(출처 패스)의
 * 값 여러 개"라 구분자를 다르게 써서 둘을 혼동하지 않게 한다.
 */
const sourceLine = candidate => {
  const sources = candidate.sources ?? (candidate.source !== undefined ? [candidate.source] : [])
  // 다른 모든 렌더 값(producer 산문은 escapeProse, path/quote는 codeSpan)과
  // 마찬가지로 이스케이프를 거친다. source는 producer가 아니라 오케스트레이터가
  // 붙이는 값이지만, 그 문자열 자체가 신뢰된 것이라는 보장은 없다 — escape를
  // 건너뛰면 `##`로 시작하는 source 하나가 이 브랜치가 세 라운드째 막아온
  // heading 주입 구멍을 그대로 재현한다.
  return sources.length ? `출처 패스: ${sources.map(escapeProse).join(', ')}` : null
}

const SLOTS = [
  ['body', '본문'],
  ['evidence', '근거'],
  ['recommendation', '개선 제안'],
  ['reason', '확신 낮음 사유'],
]

/**
 * finding 한 건을 헤딩·축 줄·위치 줄·슬롯 네 부분으로 그린다.
 *
 * 슬롯을 배열로 따로 두고 한 줄씩 join하는 이유: 원래 문제는 슬롯이 빠진 게
 * 아니라 본문·근거·개선 제안이 한 칸으로 뭉개져 나온 것이었다. 문자열을
 * 이어붙이는 방식이면 다음 사람이 실수로 다시 합칠 수 있지만, 배열 + `\n`
 * join은 슬롯을 합칠 방법 자체가 없다.
 */
export function renderFinding(candidate, { label, vocabulary, related = [], evidence = [], lineage = candidate.lineage, disposition, verifierLocation }) {
  const severity = severityOf(candidate.impact, candidate.confidence)
  // category는 계약상 impact가 high일 때만 존재한다(low는 category 자체를
  // 금지한다) — 그래도 candidate.category를 한 번 더 확인해 방어적으로 둔다.
  const categoryLabel = candidate.impact === 'high' && candidate.category
    ? ` (${vocabulary.categoryLabels[candidate.category] ?? candidate.category})`
    : ''
  const axes = [
    `영향: ${IMPACT_WORD[candidate.impact]}${categoryLabel}`,
    `확신: ${IMPACT_WORD[candidate.confidence]}`,
    // label이 undefined면 "이 워크플로우에 교차검증 축이 없다"는 뜻이라 줄
    // 자체를 뺀다 — null("렌더링하지 않음")은 Task 6의 render가 이 함수를
    // 부르기 전에 걸러내므로 여기까지 오지 않는다.
    ...(label ? [`교차검증: \`${label}\``] : []),
  ]
  const slots = SLOTS
    .filter(([key]) => typeof candidate.content[key] === 'string' && candidate.content[key])
    .map(([key, head]) => `${head}: ${escapeProse(candidate.content[key])}`)

  const source = sourceLine(candidate)
  const lineageText = lineageLine(lineage, disposition)

  return [
    `#### ${severity} \`${candidate.renderedRuleId ?? candidate.ruleId}\` ${escapeProse(candidate.content.title)}`,
    axes.join(' · '),
    ...(source ? [source] : []),
    // 이전 리뷰와의 관계(C-13). 이전 리뷰와 비교한 실행에만 있다.
    ...(lineageText ? [lineageText] : []),
    // 같은 자리에 걸린 다른 namespace의 지적. 합치지 않고 잇기만 한다 — 근거가 다른 두
    // 지적이 같은 결함인지는 이 렌더러가 정하지 않는다. 값은 호출자가 이미 code span으로 만든다.
    ...(related.length ? [`관련 지적: ${related.join(', ')}`] : []),
    locationLine(candidate),
    // `location-wrong` 반박이 짚은 자리. `undefined`면 그 반박이 아니라 줄이 없고, `null`이면
    // 그 반박인데 위치가 빠진 판정이다 — 그때는 없다는 사실을 적는다.
    ...(verifierLocation !== undefined ? [verifierLocationLine(verifierLocation)] : []),
    ...slots,
    // 이 지적을 어떻게 확인했는가(C-11). 슬롯 뒤에 둔다 — 슬롯은 producer의 주장이고, 이 줄은
    // 오케스트레이터가 남긴 확인 기록이다. 등급·축·교차검증은 바꾸지 않는다.
    ...evidence,
  ].join('\n')
}

const LINEAGE_REASON_TEXT = {
  ambiguous: '같은 규칙·같은 자리에 이전 지적이 있지만 어느 것과 이어지는지 모른다',
  'identity-unconfirmed': '같은 자리의 이전 지적과 같은 결함인지 확인하지 못했다',
  'location-unverified': '위치를 확인하지 못한 지적이라 이전 지적과 잇지 못했다',
  'previous-not-reviewed': '이전 리뷰가 이 모듈을 검토하지 않아 신규인지 말할 수 없다',
}

/**
 * `이전 리뷰:` 줄(C-13). 신규는 "이전 리뷰에 없던 지적"이다 — 그 자리의 코드가 이번에 바뀌지 않았으면
 * 이번 변경이 만든 결함이 아니라는 사실을 함께 적는다.
 */
export function lineageLine(lineage, disposition) {
  if (!lineage) return null
  if (lineage.status === 'linked') {
    // 이어졌다는 것은 같은 결함이라는 뜻이지, 그 결함이 남아 있다는 뜻은 아니다 — 이번 검증이 반박했거나
    // 확정하지 못했으면 이전 지적은 재확인 필요다(PR #94 리뷰).
    if (disposition === 'rejected') return `이전 리뷰: 이어짐 — 이전 지적 ${codeSpan(lineage.previousRef)}과 같은 결함인데 이번 교차검증이 반박했다. 이전 지적은 재확인 필요다`
    if (disposition === 'scope-open' || disposition === 'verification-unavailable') return `이전 리뷰: 이어짐 — 이전 지적 ${codeSpan(lineage.previousRef)}과 같은 결함인데 이번 검증이 확정되지 않았다. 이전 지적은 재확인 필요다`
    return `이전 리뷰: 이어짐 — 이전 지적 ${codeSpan(lineage.previousRef)}이 아직 남아 있다`
  }
  if (lineage.status === 'recheck') return `이전 리뷰: 재확인 필요 — ${LINEAGE_REASON_TEXT[lineage.reason] ?? codeSpan(lineage.reason)}`
  const notes = []
  if (lineage.fileChanged === false) notes.push('이번 변경이 이 파일을 바꾸지 않았다 — 이전 리뷰가 놓쳤거나 판단이 달라진 것이다')
  if (lineage.ruleChanged) notes.push('이 지적의 규칙 문서가 바뀌었다')
  if (lineage.differsFrom) notes.push(`같은 자리의 이전 지적 ${codeSpan(lineage.differsFrom)}과는 다른 결함이다`)
  return `이전 리뷰: 신규${notes.length ? ` — ${notes.join(' · ')}` : ''}`
}

const OUTCOME_TEXT = {
  reproduced: '재현됨',
  'not-reproduced': '재현 안 됨',
  inconclusive: '판단 불가',
  'env-failure': '환경 실패',
}
// 재현 결과는 결함의 반증이 아니다. 반증은 교차검증의 `rejected`다 — 둘을 같은 말로 쓰면,
// 재현 절차가 결함을 건드리지 못한 것이 "결함이 없다"로 읽힌다.
const OUTCOME_NOTE = {
  'not-reproduced': ' — 반증이 아니다. 지적의 존부는 교차검증이 정한다',
  'env-failure': ' — 결함 여부와 무관하다',
}
const COMPARISON_TEXT = {
  'pre-existing': '변경 전에도 재현 → 기존 결함',
  'new-regression': '변경 전에는 재현 안 됨 → 신규 회귀',
  'base-unmeasured': 'base 미측정 — 기존 결함인지 신규 회귀인지 가르지 않았다',
  incomparable: '변경 전 재현과 재현 계획이 달라 비교하지 않았다 — 기존 결함인지 신규 회귀인지 가르지 않았다',
}
const UNUSABLE_TEXT = {
  'other-run': '다른 실행의 기록이다',
  'other-target': '이 실행의 대상과 다른 코드에서 돌았다',
  'other-candidates': '지금의 후보 목록과 다른 후보 목록에서 돌았다 — 검증 준비를 다시 돌린 뒤라 같은 ID가 다른 지적일 수 있다',
  'tree-mutated': '재현 명령이 작업 트리를 바꿨다',
  'artifact-missing': '로그 파일이 없다',
  'artifact-changed': '기록한 뒤에 로그 파일이 바뀌었다',
}

/**
 * 지적 하나의 재현 근거 줄(C-11). 근거 항목이 없으면 빈 배열이다 — 근거가 없는 지적은 예전과
 * 똑같이 그린다.
 *
 * 짧게 쓴다: 확인 방법과 결과 한 줄, 조건·절차·기대·관찰 한 줄, 실행했으면 로그 경로 한 줄.
 * 긴 출력은 로그 파일에 있고 여기서는 가리키기만 한다. 값은 모두 escape를 거친다 — 오케스트레이터가
 * 적었어도 그 안의 글은 producer 산문을 옮긴 것일 수 있다.
 */
export function evidenceLines(assessed) {
  if (!assessed) return []
  if (assessed.problems?.length) return [`재현 근거: 기록이 계약에 맞지 않아 쓰지 않는다 — ${escapeProse(assessed.problems[0])}`]
  const detail = [['condition', '조건'], ['procedure', '절차'], ['expected', '기대'], ['observed', '관찰']]
    .filter(([key]) => typeof assessed[key] === 'string' && assessed[key].trim())
    .map(([key, label]) => `${label}: ${escapeProse(assessed[key])}`)
  const detailLine = detail.length ? [detail.join(' · ')] : []
  if (assessed.method === 'static-trace') return ['재현 근거: 코드 경로 분석 — 실행하지 않았다', ...detailLine]
  if (assessed.method === 'not-run') return [`재현 근거: 확인하지 않음 — ${escapeProse(assessed.reason ?? '사유가 기록되지 않았다')}`, ...detailLine]
  const head = assessed.head
  if (!head || !head.usable) {
    const why = head ? UNUSABLE_TEXT[head.reason] ?? head.reason : '이 지적의 HEAD 쪽 실행 기록이 없다'
    return [`재현 근거: 실행 기록을 근거로 쓰지 않는다 — ${why}`, ...detailLine]
  }
  const comparison = assessed.comparison ? ` · ${COMPARISON_TEXT[assessed.comparison]}` : ''
  const exit = head.exit === null || head.exit === undefined ? '없음' : head.exit
  const logs = [`실행 로그: ${codeSpan(`.timing/${head.artifact}`)}`]
  if (assessed.base?.artifact) logs.push(`base ${codeSpan(`.timing/${assessed.base.artifact}`)}`)
  return [
    `재현 근거: 실행 — ${OUTCOME_TEXT[head.outcome] ?? head.outcome} · 종료 코드 ${exit} · ${codeSpan(head.id)}${comparison}${OUTCOME_NOTE[head.outcome] ?? ''}`,
    ...detailLine,
    logs.join(' · '),
  ]
}

/** `04-10`이 `04-3`보다 앞에 오지 않게 한다 — 문자열 정렬은 여기서 틀린다. */
const idParts = ruleId => {
  const [head, tail] = String(ruleId).split('-')
  return { prefix: /^\d+$/.test(head) ? '' : head, module: Number(head) || 0, rule: Number(tail) || 0 }
}

/**
 * 규칙 ID를 문자열이 아니라 (모듈, 규칙) 정수 쌍으로 비교한다.
 *
 * 문자열 정렬이면 `04-10`이 `04-3`보다 앞에 온다("1" < "3"). 숫자 모듈
 * 사이의 순서만 이 저장소가 실제로 요구하지만, 전문 패스의 문자 접두
 * ID(`EX-`, `P-`, `A-`, `C-`)가 섞여 들어와도 죽지 않아야 한다 — 숫자로
 * 안 읽히는 head는 prefix로 보내고 module은 0으로 두어, 죽는 대신 숫자
 * 모듈 뒤로 결정적으로 정렬한다.
 */
export function compareCandidates(left, right) {
  const a = idParts(left.ruleId)
  const b = idParts(right.ruleId)
  if (a.prefix !== b.prefix) return a.prefix < b.prefix ? -1 : 1
  if (a.module !== b.module) return a.module - b.module
  if (a.rule !== b.rule) return a.rule - b.rule
  return String(left.candidateId) < String(right.candidateId) ? -1 : 1
}

/**
 * 같은 규칙 ID가 여럿이면 순번을 붙인다.
 *
 * `prepare-verification`이 producer가 붙여 온 `(1/3)` 접미사를 떼어내
 * `ruleIdRepairs`로만 남기므로, 렌더러가 여기서 다시 붙인다. 떼는 쪽과
 * 붙이는 쪽이 하나씩만 있게 된다. 분모는 렌더링 대상(이 배열에 들어온
 * candidate)만으로 세므로, active-deletion에서 걸러져 빠진 반박 finding은
 * 분모에 들어가지 않는다 — "몇 건 중 몇 번째"가 실제로 찍히는 건수와
 * 어긋나지 않는다.
 */
export function withInstanceNumbers(candidates) {
  const total = new Map()
  for (const candidate of candidates) {
    total.set(candidate.ruleId, (total.get(candidate.ruleId) ?? 0) + 1)
  }
  const seen = new Map()
  return candidates.map(candidate => {
    const count = total.get(candidate.ruleId)
    if (count < 2) return { ...candidate, renderedRuleId: candidate.ruleId }
    const index = (seen.get(candidate.ruleId) ?? 0) + 1
    seen.set(candidate.ruleId, index)
    return { ...candidate, renderedRuleId: `${candidate.ruleId} (${index}/${count})` }
  })
}

/**
 * 교차검증 축에 찍을 라벨을 고른다.
 *
 * `null`이면 이 finding을 렌더링하지 않는다 — 그 필터링은 여기서 하지 않고
 * Task 6의 `render`가 한다(`renderFinding`은 이미 걸러진 뒤에만 불린다).
 *
 * 판정이 없는 검증 대상(`verdict === undefined`)은 입력 오류가 아니라
 * `검증 실패`다. verifier가 타임아웃 나서 실제로 있었던 일이고, 조용히
 * 사라지면 안 되는 사실이라 그대로 표기한다.
 *
 * `verdictByCandidateId`의 값은 disposition 문자열 하나가 아니라
 * `{ disposition, rebuttalKind, … }`다. 반박이 지적을 지울 수 있는지는 `rebuttal.kind`가
 * 정하고, 그 목록은 판정 manifest의 `deletionAllowingKinds`다(`vocabulary`로 받는다).
 * 목록 밖의 kind는 `rejected`의 일반 경로(active-deletion에서 null, rollout-shadow에서
 * `rejected-shadow`)를 타지 않고 모든 phase에서 제 이름의 토큰(`rejected-<kind>`)으로
 * 남는다 — 원 severity와 차단 여부도 그대로다.
 *
 * - `other`: 위치를 대지 못한 반박이다. 계약(C-6B)은 "어떤 phase에서도 finding의 상태를
 *   바꾸지 않는다", "차단 우회로가 되어서는 안 된다"고 못박는다
 * - `location-wrong`: 검증자가 결함을 **인정**하고 위치만 틀렸다고 한 반박이다. 이것으로
 *   지우면 줄 번호가 틀렸다는 이유로 진짜 결함이 사라진다(#45)
 *
 * 한때 `other`만 여기 박아 두고 나머지 반박은 전부 지웠다. 그 동안 manifest의 목록은
 * 아무도 읽지 않았고, 목록과 코드가 갈라져도 걸리는 데가 없었다.
 *
 * kind가 없거나 닫힌 목록 밖이면 던진다. 판정 계약은 `rejected`에 `rebuttal.kind`를
 * 요구하고 `tally-verdicts.mjs`가 그것을 검사한다 — 여기까지 온 그런 판정은 지울지 말지
 * 정할 근거가 없는 입력이고, 어느 쪽으로든 흘려보내면 리포트가 사실과 다르게 그려진다.
 * phase도 같다: 두 값 밖이면 지우는 쪽으로 넘어가지 않고 던진다.
 *
 * `phaseByImpact`는 `{ high, low }` 객체다. phase는 전역이 아니라 `impact`별
 * 오케스트레이터 설정이다 — 문자열 하나였다면 "high는 아직 rollout-shadow인
 * 채로 두고 low만 active-deletion으로 옮긴다" 같은 독립 승인을 표현할 수
 * 없고, 둘을 하나로 묶어 active-deletion을 전역으로 주면 아직 관찰 중이어야
 * 할 high-impact 반박(차단 후보)까지 함께 사라진다.
 *
 * `deletionRoutes`는 `{ high?: [...], low?: [...] }` — 승인 파일이 false-suppression을 잰
 * 검증 경로다(C-6B "route별로 나눠서 잰다"). active-deletion이어도 그 밖의 경로에서 나온
 * 반박은 지우지 않고 `rejected-shadow`로 남긴다. 후보의 `route`는 처음 배정된 경로라 bundle에서
 * isolated로 승격돼 판정된 후보도 bundle로 센다 — 틀리면 지우지 않는 쪽으로 틀린다. 값이 없으면
 * (승인 정보 없이 render를 직접 부른 경우) 경로로 거르지 않는다.
 */
export function labelFor(candidate, verdictByCandidateId, phaseByImpact, vocabulary, deletionRoutes = {}) {
  const tokens = vocabulary.crossVerification
  const verdict = verdictByCandidateId.get(candidate.candidateId)
  const disposition = dispositionOf(candidate, verdict, 'ran')
  if (disposition === 'rejected') {
    if (!rebuttalDeletes(candidate, verdict, vocabulary)) {
      // loadVocabulary가 이 토큰의 존재를 이미 본다. 손으로 만든 어휘로 불려도 undefined 라벨로
      // 축 줄이 통째로 빠지지 않게 여기서도 멈춘다.
      const token = tokens[`rejected-${verdict.rebuttalKind}`]
      if (typeof token !== 'string' || !token) throw new Error(`labelFor: 삭제를 허용하지 않는 반박 kind ${verdict.rebuttalKind}의 표기 토큰(rejected-${verdict.rebuttalKind})이 없다`)
      return token
    }
    // 이 finding의 impact가 속한 phase만 본다 — high/low를 하나의 phase로
    // 합쳐 읽으면 한쪽의 독립 승인이 다른 쪽 값에 가려진다.
    const phase = phaseByImpact[candidate.impact]
    if (phase === 'rollout-shadow') return tokens['rejected-shadow']
    if (phase === 'active-deletion') {
      const routes = deletionRoutes[candidate.impact]
      return routes && !routes.includes(candidate.route) ? tokens['rejected-shadow'] : null
    }
    throw new Error(`labelFor: impact ${candidate.impact}의 phase가 ${[...PHASES].join('·')} 밖이다 (${JSON.stringify(phase)}) — 지울지 말지 정할 수 없다`)
  }
  return tokens[disposition]
}

/**
 * 이 반박이 phase에 따라 지적을 지울 수 있는 kind인가 — manifest의 `deletionAllowingKinds`.
 *
 * 목록을 받지 못했으면 던진다. 비어 있는 목록을 "아무것도 지우지 않는다"로 읽는 것과 목록이
 * 없는 것을 "전부 지운다"로 읽는 것은 둘 다 기본값이고, 이 결정은 기본값으로 정하지 않는다.
 */
export function rebuttalDeletes(candidate, verdict, vocabulary) {
  const { rebuttalKinds, deletionAllowingKinds } = vocabulary
  if (!Array.isArray(rebuttalKinds) || !Array.isArray(deletionAllowingKinds)) {
    throw new Error('삭제를 허용하는 반박 kind 목록(REVIEW_VERDICT_CONTRACT_V1의 rebuttal.deletionAllowingKinds)을 받지 못했다 — 반박된 지적을 지울지 정할 수 없다')
  }
  const kind = verdict?.rebuttalKind
  if (!rebuttalKinds.includes(kind)) {
    throw new Error(`${candidate.candidateId}: rejected 판정의 rebuttal.kind가 닫힌 목록 밖이다 (${JSON.stringify(kind)}) — 지울지 말지 정할 수 없다`)
  }
  return deletionAllowingKinds.includes(kind)
}

/**
 * candidate 하나의 C-6B disposition을 정한다 — verifier가 낸 값과 오케스트레이터가
 * 부여하는 값(`not-eligible`·`verification-disabled`·`verification-unavailable`·`scope-open`)을
 * 함께.
 *
 * 리포트 표기(`labelFor`)와 결과 스냅숏(`lib/review-snapshot.mjs`)이 이 함수 하나를 쓴다.
 * 둘이 각자 정하면 JSON과 리포트가 같은 후보를 다르게 말할 수 있고, 그것은 어느 쪽을
 * 읽어도 알 수 없다.
 *
 * - eligibility가 `VERIFY`가 아니면 검증을 껐든 켰든 `not-eligible`이다. eligibility는
 *   candidate 자체의 성질이다
 * - `disabled`는 판정을 보지 않는다. 이 실행 전체가 검증을 끈 것이다
 * - 판정이 없는 검증 대상은 입력 오류가 아니라 `verification-unavailable`이다
 * - 최종 판정의 `needs-context`는 isolated에서도 닫히지 않은 것이라 `scope-open`이다
 *   (bundle의 `needs-context`에 승격 판정이 없으면 `tally-verdicts.mjs`가 판정에서 뺀다)
 *
 * 닫힌 목록은 `upheld`·`rejected`·`needs-context` 셋뿐이다(C-6B). 그 밖의 값을 조용히
 * `upheld`로 흘려보내면 반박됐거나 판정이 불확실한 finding에 "교차검증: `유지`"라는 거짓
 * 표기가 찍히고, 독자는 리포트만 보고는 그 사실을 알 방법이 없다. `tally-verdicts.mjs`가
 * 같은 상황에서 죽는 것과 같은 이유로 여기서도 던진다.
 */
export function dispositionOf(candidate, verdict, verificationState) {
  if (!VERIFICATION_STATES.has(verificationState)) {
    throw new Error(`dispositionOf: verificationState는 ran 또는 disabled다 (받은 값: ${JSON.stringify(verificationState)})`)
  }
  if (candidate.eligibility !== 'VERIFY') return 'not-eligible'
  if (verificationState === 'disabled') return 'verification-disabled'
  if (verdict === undefined) return 'verification-unavailable'
  if (verdict.disposition === 'needs-context') return 'scope-open'
  if (verdict.disposition === 'upheld' || verdict.disposition === 'rejected') return verdict.disposition
  throw new Error(`dispositionOf: disposition이 C-6B의 닫힌 목록 밖이다 (${JSON.stringify(verdict.disposition)}) — candidateId: ${candidate.candidateId}`)
}

/**
 * 섹션이 될 모듈을 catalog에서 뽑는다.
 *
 * 손으로 넘기지 않는 이유는 이 저장소가 후보 수에 대해 이미 내린 결론과 같다 —
 * 목록을 사람이 적으면 적다가 틀린다. 건너뛴 모듈은 실행 계획에 기록되므로
 * 그 파일에서 뺀다.
 */
export function loadModuleSections(rulesDir, workflow, plannedPath) {
  let catalog
  try {
    catalog = JSON.parse(readFileSync(join(rulesDir, 'catalog.json'), 'utf8'))
  } catch (error) {
    return { error: `catalog.json을 읽지 못했다: ${error.message}` }
  }
  const skipped = new Set()
  if (plannedPath) {
    let planned
    try {
      planned = JSON.parse(readFileSync(plannedPath, 'utf8'))
    } catch (error) {
      return { error: `--planned를 읽지 못했다: ${plannedPath} — ${error.message}` }
    }
    for (const entry of [...(planned.skipped ?? []), ...(planned.unknown ?? [])]) {
      skipped.add(String(entry.module ?? entry).slice(0, 2))
    }
  }
  const sections = (catalog.modules ?? [])
    .filter(module => module.role === 'module')
    .filter(module => (module.workflows ?? []).includes(workflow))
    .filter(module => module.phaseByWorkflow?.[workflow] !== 'post-verification-synthesis')
    .filter(module => !skipped.has(module.id))
    // `kind`는 render가 이 배열과 loadSpecialistPasses의 배열을 CLI가 합친
    // 뒤에도 둘을 구분할 수 있게 하는 판별자다(리뷰 판정 Ruling 2 후속,
    // Important 5) — id 모양으로 추측하면(두 자리 숫자인지 등) 그 추측과
    // 어긋나는 항목이 양쪽 분기 모두에서 조용히 빠질 수 있다.
    // `source`는 결과 파일과 `collected.sources`가 쓰는 이름(규칙 문서 파일명에서
    // `.md`를 뗀 값)이다. 수집 기록과 대조할 때 쓴다.
    .map(module => ({ kind: 'module', id: module.id, title: module.title, source: String(module.path ?? '').replace(/\.md$/, '') }))
    .sort((left, right) => (left.id < right.id ? -1 : 1))
  return { value: sections }
}

/**
 * 특수 패스(Props·수학·예외) 섹션 메타데이터를 만든다.
 *
 * 표시명과 순서는 catalog에서 읽지 않는다 — 계약 C-7 문서 골격 표가
 * "Props·수학·예외" 세 이름과 그 순서를 그대로 고정해 두었고, catalog의
 * title은 "Props 전달 구조"·"선형대수 / 행렬"·"예외 처리"처럼 사람이 읽을
 * 설명이라 리포트 헤딩과는 다른 문자열이다(리뷰 판정 Ruling 2). 그래서 이름과
 * 순서는 여기서 직접 적는다.
 *
 * `prefixes`만 catalog.json의 `rulePrefixes`에서 읽는다 — math.md가
 * A-/C- 표기를 바꾸거나 새 specialist 문서가 생기면 이 값도 같이 바뀌어야
 * 하는데, 여기서 손으로 다시 옮기면 review-rules 쪽만 바뀌고 이 파일은
 * 조용히 낡은 채로 남는다(파일 맨 위 주석이 경고하는 "같은 사실을 두 번
 * 코드로 옮기는" 실패).
 *
 * rulePrefixes가 없거나 빈 배열이면 `{ error }`를 낸다(리뷰 fix round 1,
 * Important 4) — `byId.get(id)?.rulePrefixes ?? []`로 조용히 "접두 없음"을
 * 흘려보내면, catalog의 오타나 항목 삭제가 EX-* 지적을 "### EX"라는 원시
 * 접두 헤딩 아래로 새게 하고, 그 상태로도 이 함수는 "성공"한다. 같은 파일의
 * `loadVocabulary`가 categoryLabels 누락을 거부하는 것과 같은 이유로 같은
 * 방식(`{value}`/`{error}`)을 쓴다 — catalog를 그 사실의 단일 소스로 만든
 * 것(Ruling 1)은, 그 소스가 조용히 사라질 수 있으면 단일 소스가 아니다.
 */
export function loadSpecialistPasses(rulesDir, plannedPath) {
  let catalog
  try {
    catalog = JSON.parse(readFileSync(join(rulesDir, 'catalog.json'), 'utf8'))
  } catch (error) {
    return { error: `catalog.json을 읽지 못했다: ${error.message}` }
  }
  // 적용 범위가 없어 띄우지 않은 특수 패스는 실행 계획(`--planned`)의 `skipped`에
  // 그 패스 이름(`props`·`math`·`exception`)으로 적힌다. 렌더러는 그 사유를
  // 그 패스 자리에 옮긴다 — 번호 모듈의 SKIPPED가 `실행 계획`에 적히는 것과 달리,
  // 특수 패스는 `특수 패스` 절이 제 상태를 말하는 유일한 자리다.
  const skipped = new Map()
  if (plannedPath) {
    let planned
    try {
      planned = JSON.parse(readFileSync(plannedPath, 'utf8'))
    } catch (error) {
      return { error: `--planned를 읽지 못했다: ${plannedPath} — ${error.message}` }
    }
    for (const entry of planned.skipped ?? []) {
      if (entry && typeof entry === 'object') skipped.set(String(entry.module), { reason: entry.reason ?? entry.evidence ?? entry.reasonCode })
    }
  }
  const byId = new Map((catalog.modules ?? []).map(module => [module.id, module]))
  const passes = []
  for (const [id, title] of [['props', 'Props'], ['math', '수학'], ['exception', '예외']]) {
    const prefixes = byId.get(id)?.rulePrefixes
    if (!Array.isArray(prefixes) || prefixes.length === 0) {
      return { error: `catalog.json의 "${id}" specialist 항목에 rulePrefixes가 없다 — 특수 패스 접두를 알 수 없다` }
    }
    passes.push({ kind: 'pass', id, title, prefixes, source: id, ...(skipped.has(id) ? { skipped: skipped.get(id) } : {}) })
  }
  // 선택 패스(#88 PR 1). 켰을 때만 도는 패스라 catalog에 없어도 거부하지 않는다 — 이 패스가
  // 생기기 전의 규칙 디렉터리(C-1의 홈 사본 등)를 읽는 실행이 있다. 있는데 접두가 없으면
  // 위 셋과 같은 이유로 거부한다.
  const correctness = byId.get('correctness')
  if (correctness) {
    if (!Array.isArray(correctness.rulePrefixes) || correctness.rulePrefixes.length === 0) {
      return { error: 'catalog.json의 "correctness" specialist 항목에 rulePrefixes가 없다 — 특수 패스 접두를 알 수 없다' }
    }
    passes.push({
      kind: 'pass', id: 'correctness', title: '정확성', prefixes: correctness.rulePrefixes, source: 'correctness',
      ...((correctness.optIn ?? []).length ? { optIn: true } : {}),
      ...(skipped.has('correctness') ? { skipped: skipped.get('correctness') } : {}),
    })
  }
  return { value: passes }
}

/**
 * 리포트의 `상세 지적`과 `특수 패스` 두 섹션을 조립한다.
 *
 * `sections`는 숫자 모듈 섹션(`loadModuleSections`)과 특수 패스 섹션
 * (`loadSpecialistPasses`)을 CLI가 합쳐 넘긴다. 두 loader가 붙인 `kind`
 * (`'module'` | `'pass'`)로 구분한다 — id 모양(두 자리 숫자인지, `prefixes`
 * 배열이 있는지)으로 추측하던 이전 버전은 그 추측과 항목이 어긋나면(예:
 * 둘 다 아니거나 둘 다인 항목) 양쪽 분기 모두에서 조용히 빠지거나 두 번
 * 그려질 수 있었다(리뷰 fix round 1, Important 5). render는 catalog 파일을
 * 직접 읽지 않는다(rulesDir을 받지 않는다) — sections를 순수 데이터로만
 * 받아야 파일시스템 없이 이 함수만 따로 단위 테스트할 수 있다. (catalog.json
 * 자체는 이미 loadModuleSections와 loadSpecialistPasses 두 곳에서 각각
 * 파싱된다 — render가 rulesDir을 받지 않는 것은 그 중복을 막으려는 것이
 * 아니라, render를 그 두 loader의 파일 I/O에서 분리해 두려는 것이다.)
 *
 * 반환값은 문자열이 아니라 `{ markdown, movedToOpenQuestions, activeDeletionRemovals }`다.
 * C-6B 상태표는 `scope-open`(verifier의 `needs-context`)을 "openQuestion으로
 * 이동"이라고 적는다 — 상세 지적에 라벨을 단 채로 남기는 것이 아니다. 그런데
 * `미해결 / 후속 확인` 섹션은 이 renderer가 만들지 않는다(모델이 쓴다).
 * 그래서 render는 그 finding들을 상세 지적에서 빼는 것까지만 하고, 무엇을
 * 뺐는지(id·ruleId·title)를 `movedToOpenQuestions`로 돌려준다 — 호출자가
 * 그 목록을 보고 실제로 옮겨 적지 않으면 finding이 조용히 사라진다.
 *
 * `activeDeletionRemovals`도 같은 이유로 존재한다 — C-6B "오판 가시성"은
 * `active-deletion`에서 지워지는 `rejected` finding의 흔적을 audit이 아니라
 * **리포트**(`미해결 / 후속 확인`)에 남기라고 명시적으로 요구한다: 검증자의
 * 오판이 진짜 결함의 소멸이 될 수 있고, audit는 아무도 읽지 않기 때문이다.
 * `needs-context`를 위해 만든 "조용히 사라지지 않는다" 장치(movedToOpenQuestions)를
 * active-deletion에서 지워지는 finding에는 두지 않았던 것이 그 자체로 회귀였다.
 *
 * `phaseByImpact`는 이 실행이 **실제로** 도는 phase다. CLI는 승인 파일로 그것을 정해
 * (`gateDeletion`) 넘기고, 그 결과 전체를 `options.deletionGate`로 함께 넘긴다 — 승인이 잰
 * 검증 경로(그 밖의 반박은 지우지 않는다)와, `## 상세 지적` 맨 위의 삭제 단계 줄에 적을 승인자·
 * 날짜·무효가 된 승인이 거기 있다. 지울 수 있는 phase가 없고 무효가 된 승인도 없으면 그 줄은
 * 없다 — 둘 다 rollout-shadow인 실행의 출력은 이 장치가 생기기 전과 같다.
 *
 * `verificationState`는 불리언이 아니라 세 값을 갖는다.
 *   - `'ran'`: 교차검증이 실제로 돌았다. candidate별로 `labelFor`가 판정을
 *     읽어 라벨을 매기고, `needs-context`는 위에서 이동시킨다.
 *   - `'disabled'`: 이 실행에서 교차검증을 **껐다**(사용자의 선택). 판정
 *     데이터가 있든 없든 보지 않는다 — 하지만 그것이 eligibility까지
 *     무시한다는 뜻은 아니다. disposition 표(C-6B)는 `verification-disabled`를
 *     "검증을 끈 실행의 **검증 대상**"에만 준다. `SKIP-VERIFY` 후보는 이
 *     실행이 검증을 껐든 켰든 애초에 대상이 아니었으므로 `not-eligible`
 *     (`대상 아님`)을 그대로 유지한다 — eligibility는 candidate 자체의
 *     성질이지 그 pass가 실제로 돌았는지에 좌우되지 않는다. 계약은 이
 *     교집합(disabled × SKIP-VERIFY)을 명시하지 않으므로, 판단 근거를
 *     golden assertion 안에 조용히 묻지 않고 여기 주석으로 남긴다.
 *   - 그 밖의 값(`false`/`undefined` 등): 이 워크플로우는 애초에 교차검증을
 *     하지 않는다. 축 줄 자체를 내지 않는다 — `disabled`와 다른 사실이다.
 *     `disabled`는 "검증 대상인데 껐다"이고, 이 값은 "검증 대상 개념 자체가
 *     없다"이다. 오늘은 `render-findings.mjs`를 code-review-full만 부르므로
 *     CLI에는 이 값으로 가는 경로가 없지만(그 워크플로우는 항상 C-6B
 *     안이다), 함수 자체는 다른 워크플로우가 이 값으로 부를 수 있게 열어
 *     둔다.
 */
export function render(candidates, verdictByCandidateId, phaseByImpact, vocabulary, sections, verificationState, options = {}) {
  const labelled = []
  const movedToOpenQuestions = []
  // C-6B "오판 가시성" — active-deletion이 지운 rejected finding의 흔적을
  // 리포트 본문에 남긴다. impact=high는 건별(규칙 ID·anchor path·rebuttal.kind),
  // impact=low는 건수만 — 계약이 그렇게 가른 이유는 high 쪽이 차단 후보라
  // 무엇이 지워졌는지가 더 크게 걸리기 때문이다.
  const activeDeletionRemovals = { high: [], lowCount: 0 }
  // 승인이 잰 검증 경로(C-6B). CLI가 승인 파일로 정해 넘긴다.
  const deletionRoutes = {
    high: options.deletionGate?.impacts?.high?.routes,
    low: options.deletionGate?.impacts?.low?.routes,
  }
  for (const candidate of candidates) {
    // needs-context 이동은 실제로 판정이 있었던 'ran'에서만 의미가 있다.
    // 'disabled'에는 애초에 판정 데이터가 없고, 있어도 무시한다 — 이동은
    // 검증이 실제로 돈 결과에만 따른다.
    if (verificationState === 'ran' && verdictByCandidateId.get(candidate.candidateId)?.disposition === 'needs-context') {
      // 이 채널이 그 finding의 **유일한 출구**다. 상세 지적에서 빠진 뒤 이
      // 목록에 없는 것은 리포트 어디에도 없다. 그런데 id·ruleId·title만
      // 실어 보내면 받는 쪽이 왜 범위가 닫히지 않았는지도, 원래 무슨
      // 주장이었는지도 모른 채 `미해결 / 후속 확인`을 써야 한다 — 결국
      // producer JSON을 다시 찾아 손으로 조립하게 되고, 그것이 이 렌더러가
      // 없애려는 경로 그 자체다. 그릴 재료를 전부 함께 보낸다.
      //
      // `reason`은 계약이 `needs-context`에 **필수**로 요구하는 필드다
      // (disposition.requires). 그 값이 "무엇을 더 봐야 하는가"이므로,
      // 빠지면 후속 확인 항목이 후속 확인을 안내하지 못한다.
      const verdict = verdictByCandidateId.get(candidate.candidateId)
      movedToOpenQuestions.push({
        id: candidate.candidateId,
        ruleId: candidate.ruleId,
        title: candidate.content.title,
        reason: verdict?.reason ?? null,
        content: candidate.content,
        location: candidate.location,
        locationCheck: candidate.locationCheck,
        sources: candidate.sources ?? (candidate.source !== undefined ? [candidate.source] : []),
      })
      continue
    }
    const label = verificationState === 'ran'
      ? labelFor(candidate, verdictByCandidateId, phaseByImpact, vocabulary, deletionRoutes)
      // disabled는 판정 데이터(누가 반박했는지)는 보지 않는다 — 이 실행
      // 전체가 검증을 끈 것이지, 판정 유무로 후보별로 갈릴 사정이 아니다.
      // 하지만 eligibility는 판정 데이터가 아니라 candidate 자체의 성질이다.
      // disposition 표(C-6B)가 `verification-disabled`를 "검증 대상"에만
      // 주듯이, SKIP-VERIFY 후보는 검증을 껐든 켰든 `not-eligible`
      // (`대상 아님`)로 남는다 — 그 사실은 이 실행이 검증을 돌렸는지와
      // 무관하다.
      : verificationState === 'disabled'
        ? vocabulary.crossVerification[dispositionOf(candidate, undefined, 'disabled')]
        // 그 밖의 값은 "이 워크플로우에 교차검증 축이 없다"는 뜻이라 축 자체를 뺀다.
        : undefined
    // `null`은 이 phase에서 리포트에 나타나지 않는다는 뜻이다 — 정렬·순번을
    // 매기기 전에 걸러야, 지워진 finding이 "(1/3)" 같은 분모를 차지하지 않는다.
    // (리뷰 fix round 1, Important 1 — 순번을 먼저 매기고 나중에 거르면
    // 분모가 걸러지기 전 건수로 굳어 남는다.)
    if (label === null) {
      // labelFor가 null을 내는 유일한 경로는 active-deletion phase에서 삭제를
      // 허용하는 kind(manifest의 deletionAllowingKinds)로 반박돼 지워지는 경우다
      // (labelFor 참고). 그 삭제를 조용히 흘려보내지 않고 두 번째 채널로 담아
      // 돌려준다 — movedToOpenQuestions와 같은 이유다.
      const verdict = verdictByCandidateId.get(candidate.candidateId)
      if (candidate.impact === 'high') {
        activeDeletionRemovals.high.push({
          ruleId: candidate.ruleId,
          path: candidate.location?.path ?? null,
          rebuttalKind: verdict?.rebuttalKind ?? null,
        })
      } else {
        activeDeletionRemovals.lowCount += 1
      }
      continue
    }
    labelled.push({ candidate, label })
  }

  const numbered = withInstanceNumbers(
    labelled.map(entry => entry.candidate).sort(compareCandidates))
  const labelById = new Map(labelled.map(entry => [entry.candidate.candidateId, entry.label]))

  // 숫자 모듈(`04-3`)과 전문 패스(`EX-6`·`P-1`·`A-1`·`C-1`)를 가른다. 전문
  // 패스 규칙 ID의 접두는 두 자리 숫자가 아니라 문자다.
  const numberedModules = numbered.filter(candidate => /^\d\d-/.test(candidate.ruleId))
  const specials = numbered.filter(candidate => !/^\d\d-/.test(candidate.ruleId))

  // sections를 kind로 총함수(total function)처럼 나눈다 — module도 pass도
  // 아닌 항목을 조용히 두 분기 모두에서 버리면, 그 섹션의 지적이 리포트에서
  // 통째로 사라지고 원인이 CLI 배선이라 다시 돌려도 똑같이 사라진다. 던져서
  // 바로 드러낸다(리뷰 fix round 1, Important 5).
  const moduleSections = []
  const specialistSections = []
  for (const section of sections) {
    if (section.kind === 'module') { moduleSections.push(section); continue }
    if (section.kind === 'pass') { specialistSections.push(section); continue }
    throw new Error(`render: sections[].kind는 'module' 또는 'pass'여야 한다 — 받은 값: ${JSON.stringify(section)}`)
  }

  // 결과를 수집한 모듈 이름(`prepare-verification.mjs --collect`의 `collected.sources`).
  // 이 목록이 있으면, 지적이 없는 섹션이 "0건"인지 "결과가 없다"인지 가를 수 있다 —
  // 실행이 실패한 모듈을 "지적 없음."으로 찍으면 0건과 구분되지 않는다. 목록이 없는
  // 입력(`--input`으로 모은 예전 경로)에서는 가를 근거가 없으므로 예전처럼 적는다.
  const collected = options.collected
  // 특수 패스는 id가 곧 결과 파일 이름이다(`props`·`math`·`exception`).
  const sourceOf = section => section?.source ?? (section?.kind === 'pass' ? section.id : undefined)
  const emptyText = section => (collected && sourceOf(section) && !collected.has(sourceOf(section))
    ? NOT_COLLECTED
    : '지적 없음.')

  // 같은 자리에 걸린 다른 namespace의 지적(`relatedCandidateIds`, prepare-verification이
  // 붙인다)을 리포트에서 부르는 이름. 이 리포트에 그려진 지적은 순번까지 붙은 이름으로,
  // 그려지지 않은 지적(범위 미확정으로 옮겨졌거나 삭제된 것)은 candidate ID와 그 사실로
  // 적는다 — 이름만 적으면 독자가 상세 지적에서 찾다 실패한다.
  const renderedName = new Map(numbered.map(candidate => [candidate.candidateId, candidate.renderedRuleId ?? candidate.ruleId]))
  const relatedOf = candidate => (candidate.relatedCandidateIds ?? []).map(id => (renderedName.has(id)
    ? codeSpan(renderedName.get(id))
    : `${codeSpan(id)} (상세 지적에 없음)`))
  // 실제로 그린 지적 수. 아래 cardinality 검사가 "라벨을 받았다"가 아니라 "상세 지적이나
  // 특수 패스에 실제로 찍혔다"를 센다 — 라벨을 받고도 어느 절에도 실리지 않는 길이 생기면
  // 그것이 #45가 말하는 조용한 소멸이다.
  let drawn = 0
  const findingLines = candidate => {
    drawn += 1
    const verdict = verdictByCandidateId.get(candidate.candidateId)
    const disposition = verificationState === 'ran' || verificationState === 'disabled'
      ? dispositionOf(candidate, verdict, verificationState)
      : undefined
    return renderFinding(candidate, {
      label: labelById.get(candidate.candidateId), vocabulary, related: relatedOf(candidate),
      evidence: evidenceLines(options.evidence?.get(candidate.candidateId)),
      // 이전 리뷰와의 관계(C-13)는 같은 결함인지 물은 판정과 이 지적의 최종 판정을 함께 본다.
      lineage: candidate.lineage ? finalizeCurrent(candidate.lineage, options.rechecks?.get(candidate.lineage.previousRef)) : undefined,
      disposition,
      // 결함은 인정하고 위치만 틀렸다는 반박 — 검증자가 본 자리를 함께 그린다. 축 줄의 라벨과
      // 같은 disposition에서 정한다(검증 대상이 아니었던 후보의 판정은 보지 않는다).
      verifierLocation: disposition === 'rejected' && verdict.rebuttalKind === 'location-wrong'
        ? verdict.rebuttalLocation ?? null
        : undefined,
    })
  }

  const lines = ['## 상세 지적', '']
  // 지울 수 있는 phase가 켜졌거나 승인이 무효가 됐으면 이 절 맨 위에 한 줄로 적는다(C-6B).
  // 교차검증 축이 없는 워크플로우(세 번째 상태)에는 phase가 의미가 없으므로 내지 않는다.
  const phaseLine = verificationState === 'ran' || verificationState === 'disabled'
    ? deletionPhaseLine(phaseByImpact, options.deletionGate)
    : null
  if (phaseLine) lines.push(phaseLine, '')
  const titleById = new Map(moduleSections.map(section => [section.id, section.title]))
  const sectionById = new Map(moduleSections.map(section => [section.id, section]))
  // 섹션에 없는 모듈에서 지적이 오면 그 모듈도 낸다. 조용히 버리면 지적이
  // 사라지는데, 섹션 목록이 틀린 것보다 지적이 없어지는 쪽이 나쁘다.
  const moduleKeys = [...new Set([
    ...moduleSections.map(section => section.id),
    ...numberedModules.map(candidate => candidate.ruleId.slice(0, 2)),
  ])].sort()

  for (const key of moduleKeys) {
    lines.push(`### ${key} ${titleById.get(key) ?? ''}`.trimEnd(), '')
    const inModule = numberedModules.filter(candidate => candidate.ruleId.startsWith(`${key}-`))
    if (!inModule.length) {
      lines.push(emptyText(sectionById.get(key)), '')
      continue
    }
    for (const candidate of inModule) {
      lines.push(findingLines(candidate), '')
    }
  }

  // 특수 패스 섹션이 넘어왔으면 절을 **항상** 낸다. 지적이 없는 패스를 헤딩째
  // 빼던 때에는 2026-09-30 리포트에서 Props(실행·0건)와 수학(SKIPPED)이 흔적도
  // 없이 사라졌다 — 번호 모듈은 0건이어도 "지적 없음."을 찍으므로, 읽는 쪽은 빠진
  // 패스를 "안 돌았다"로도 "0건이다"로도 읽을 수 없었다.
  if (specials.length || specialistSections.length) {
    lines.push('## 특수 패스', '')
    // 규칙 ID 접두(`EX`, `P`, `A`, `C`, …)로 특수 패스 표시명을 찾는다. 못
    // 찾으면(카탈로그와 CLI 배선이 어긋난 경우) 접두 자체를 헤딩으로 써서
    // 낸다 — 숫자 모듈에서 이미 쓰는 것과 같은 안전장치로, 조용히 버리지
    // 않는다.
    const titleFor = candidate => {
      const prefix = candidate.ruleId.split('-')[0]
      return specialistSections.find(pass => pass.prefixes.includes(prefix))?.title ?? prefix
    }
    // Map은 삽입 순서를 지킨다 — specialistSections 순서(계약 C-7이 고정한
    // Props·수학·예외, Important 3으로 골든 테스트가 이 순서를 직접 고정한다)가
    // 먼저 채워지고, 못 알아본 접두는 등장 순으로 뒤에 붙는다.
    const grouped = new Map(specialistSections.map(pass => [pass.title, []]))
    for (const candidate of specials) {
      const title = titleFor(candidate)
      grouped.set(title, [...(grouped.get(title) ?? []), candidate])
    }
    const passByTitle = new Map(specialistSections.map(pass => [pass.title, pass]))
    for (const [title, inPass] of grouped) {
      const pass = passByTitle.get(title)
      // 카탈로그에 없는 접두로 모인 묶음은 지적이 있을 때만 생긴다 — 빈 것을 낼 이유가 없다.
      if (!pass && !inPass.length) continue
      // 선택 패스(`optIn`)는 켰는지에 따라 다르다. 켰는지는 prepare-verification이 run.start에서
      // 읽어 `collected.optIn`으로 넘긴다.
      // - 켜지 않았으면 `SKIPPED`와 그 이유. "지적 없음."은 돌았는데 0건이라는 뜻이라 틀리고,
      //   섹션을 빼면 그런 패스가 있다는 사실이 리포트에서 사라진다
      // - 켰는지 모르는 입력(`--input` 경로)이면 지적이 있을 때만 낸다
      const state = pass?.optIn ? options.optIn?.[pass.id] : undefined
      if (pass?.optIn && state === undefined && !inPass.length) continue
      lines.push(`### ${title}`, '')
      if (pass?.optIn && state === 'off') {
        const leftover = options.excludedNotRequested?.has(pass.source)
          ? ' 기록이나 결과 파일이 있었지만 이 실행의 결과로 모으지 않았다.'
          : ''
        lines.push(`\`SKIPPED\` — 선택 패스, 이 실행에서 켜지 않았다(\`--${pass.id} on\` 없음) · 비차단${leftover}`, '')
        continue
      }
      if (!inPass.length) {
        // SKIPPED는 실행 계획(`--planned`)이 준 사유를 그대로 옮긴다. 사유가 없으면
        // 지어내지 않고 없다고 적는다.
        lines.push(pass.skipped
          ? `\`SKIPPED\` — ${pass.skipped.reason ? escapeProse(pass.skipped.reason) : '사유가 기록되지 않았다'} · 비차단`
          : emptyText(pass), '')
        continue
      }
      for (const candidate of inPass) {
        lines.push(findingLines(candidate), '')
      }
    }
  }

  checkCardinality(candidates.length, {
    drawn,
    moved: movedToOpenQuestions.length,
    removedHigh: activeDeletionRemovals.high.length,
    removedLow: activeDeletionRemovals.lowCount,
  })
  return { markdown: lines.join('\n'), movedToOpenQuestions, activeDeletionRemovals }
}

/**
 * 들어온 후보는 모두 정확히 한 곳으로 간다 — 그린 지적, `미해결 / 후속 확인`으로 옮길 목록,
 * active-deletion이 지운 목록(high는 건별, low는 건수).
 *
 * 2.5.7 실사용 리포트가 `후보 27 = 유지 12 + 반박됨 4 + 분류 밖 1 + 범위 미확정 4 + 대상 아님 6`을
 * 맞췄지만, 그 등식은 모델이 손으로 재구성한 사본 위에서 맞은 것이었다(#45). 성실한 실행과
 * 성실하지 않은 실행이 같은 출력을 내면 등식이 근거가 되지 못한다. 그래서 등식을 산문이
 * 아니라 렌더러가 센다. 맞지 않으면 그리지 않고 던진다(CLI는 exit 2로 끝낸다) — 어느 절에도
 * 없는 지적이 생긴 리포트는 깨끗해 보이는 쪽으로 틀린다.
 */
export function checkCardinality(total, { drawn, moved, removedHigh, removedLow }) {
  const accounted = drawn + moved + removedHigh + removedLow
  if (accounted !== total) {
    throw new Error(`render: 후보 ${total}건 중 ${accounted}건만 행선지가 있다 — 그린 지적 ${drawn} + 범위 미확정 이동 ${moved} + active-deletion 삭제 high ${removedHigh}·low ${removedLow}. 어느 절에도 없이 사라진 지적이 있다`)
  }
}

// 이 파일이 직접 실행될 때만 CLI로 동작한다. 테스트는 함수를 import한다.
if (process.argv[1] && process.argv[1].endsWith('render-findings.mjs')) {
  const inputPath = flag('input')
  const rulesDir = flag('rules')
  const phaseHigh = flag('phase-high')
  const phaseLow = flag('phase-low')
  const workflow = flag('workflow')
  // 승인 파일을 쓰는 사람이 basis에 적을 값을 손으로 계산하지 않게 한다. 렌더링과 섞지 않는다 —
  // 이 모드는 리포트를 그리지 않는다.
  if (process.argv.includes('--print-deletion-basis')) {
    if (!rulesDir) die('--print-deletion-basis에는 --rules <RULES_DIR>가 필요하다 — 기준은 그 디렉터리의 계약과 검증자 지시문에서 나온다')
    const basis = deletionBasis(rulesDir)
    if (basis.error) die(basis.error)
    process.stdout.write(`${JSON.stringify({ basis: basis.value }, null, 2)}\n`)
    process.exit(0)
  }
  if (!inputPath) die('--input <경로>가 필요하다')
  if (!rulesDir) die('--rules <RULES_DIR>가 필요하다')
  if (!workflow) die('--workflow <이름>이 필요하다 — 어느 모듈이 섹션이 되는지가 여기서 갈린다')
  // 기본값을 두지 않는다. 반박된 finding의 처리가 갈리고 그 값이 차단 판정에
  // 걸리므로, 조용히 틀린 쪽으로 도는 것보다 멈추는 편이 낫다. high와 low를
  // 하나로 묶지 않는 이유도 같다 — phase는 전역이 아니라 impact별 설정이라
  // (workflow-contract.md), 하나만 받으면 "high는 아직 관찰 중, low는
  // 삭제로 전환" 같은 독립 승인을 표현할 수 없다.
  if (!PHASES.has(phaseHigh)) die(`--phase-high는 ${[...PHASES].join(' 또는 ')} 중 하나여야 한다`)
  if (!PHASES.has(phaseLow)) die(`--phase-low는 ${[...PHASES].join(' 또는 ')} 중 하나여야 한다`)
  const requestedPhases = { high: phaseHigh, low: phaseLow }

  const verificationState = flag('verification-state')
  // 이 CLI는 code-review-full 전용이고, 그 워크플로우는 항상 C-6B 안에
  // 있다 — "검증 대상 개념 자체가 없다"(render()의 세 번째 상태)로 가는
  // 경로가 이 CLI에는 없다. 그래서 여기서는 ran/disabled 둘만 받는다.
  // 기본값을 두지 않는 이유는 --phase-*와 같다 — "검증을 껐다"와 "검증이
  // 실제로 돌았다"를 조용히 아무 쪽으로나 흘려보내면, 리포트가 검증
  // 여부를 실제와 다르게 보여준다.
  if (!VERIFICATION_STATES.has(verificationState)) {
    die(`--verification-state는 ${[...VERIFICATION_STATES].join(' 또는 ')} 중 하나여야 한다`)
  }
  // `disabled`는 "이 실행에는 검증 판정이 없다"는 선언이다. 그런데도
  // `--verdicts`를 같이 주면 두 신호가 모순된다 — 조용히 무시하면 호출자는
  // 자기가 준 판정 파일이 실제로는 쓰이지 않았다는 사실을 알 방법이 없다
  // (disabled 경로는 판정 데이터를 아예 보지 않는다, 아래 render() 참고).
  // 모순을 흡수하는 대신 여기서 거부한다.
  if (verificationState === 'disabled' && flagAll('verdicts').length > 0) {
    die('--verification-state disabled와 --verdicts를 함께 줄 수 없다 — disabled는 판정이 없다는 선언이라 --verdicts가 모순된다')
  }

  // active-deletion은 플래그 한 단어로 켜지지 않는다(C-6B 삭제 rollout phase, #47). 사람이 잰
  // false-suppression 승인 파일이 있어야 하고, 플러그인은 그 승인을 싣고 오지 않는다. 승인을
  // 줬는데 지울 phase가 없으면 두 신호가 모순된다 — `disabled`와 `--verdicts`처럼 거부한다.
  const wantsDeletion = Object.values(requestedPhases).includes('active-deletion')
  const approvalPath = flag('deletion-approval')
  const approvalGiven = process.argv.includes('--deletion-approval')
  if (wantsDeletion && !approvalPath) {
    die('--phase-high/--phase-low에 active-deletion을 주려면 --deletion-approval <승인 파일>이 필요하다 — ' +
      '반박된 지적을 지우는 것은 사람이 잰 false-suppression 승인(workflow-contract.md C-6B 삭제 rollout phase)이 있을 때만이고, ' +
      '플러그인에는 그런 승인이 들어 있지 않다. 승인 없이 돌리려면 둘 다 rollout-shadow로 준다')
  }
  if (!wantsDeletion && approvalGiven) {
    die('--deletion-approval을 줬는데 active-deletion인 phase가 없다 — 승인 파일은 지울 phase가 있을 때만 준다')
  }
  let deletionGate
  if (wantsDeletion) {
    let approval
    try {
      approval = JSON.parse(readFileSync(approvalPath, 'utf8'))
    } catch (error) {
      die(`--deletion-approval을 읽지 못했다: ${approvalPath} — ${error.message}`)
    }
    const approvalProblems = validateDeletionApproval(approval)
    if (approvalProblems.length) {
      die(`--deletion-approval이 계약(C-6B)에 맞지 않는다: ${approvalPath}\n  - ${approvalProblems.join('\n  - ')}`)
    }
    const basis = deletionBasis(rulesDir)
    if (basis.error) die(basis.error)
    const gate = gateDeletion(requestedPhases, approval, basis.value)
    if (gate.error) die(gate.error)
    deletionGate = gate.value
    for (const warning of deletionGate.warnings) process.stderr.write(`${warning}\n`)
  }
  const phaseByImpact = deletionGate?.phaseByImpact ?? requestedPhases

  let payload
  let inputText
  try {
    inputText = readFileSync(inputPath, 'utf8')
    payload = JSON.parse(inputText)
  } catch (error) {
    die(`--input을 읽지 못했다: ${inputPath} — ${error.message}`)
  }

  const problems = validateCandidates(payload.candidates)
  if (problems.length) {
    die(`그릴 수 없는 후보가 ${problems.length}건이다:\n  - ${problems.join('\n  - ')}`)
  }

  const vocabulary = loadVocabulary(rulesDir)
  if (vocabulary.error) die(vocabulary.error)

  const sections = loadModuleSections(rulesDir, workflow, flag('planned'))
  if (sections.error) die(sections.error)

  // 특수 패스(Props·수학·예외) 섹션도 같은 catalog.json에서 나온다. render는
  // rulesDir을 받지 않고 파일 I/O를 하지 않는다 — 접두 표(prefix table)를
  // 하드코딩해 두지도 않는다 — 그래야 catalog.json이 그 사실들의 유일한
  // 선언처로 남고, render는 파일시스템 없이 순수 데이터만으로 단위
  // 테스트할 수 있다. (loadModuleSections와 loadSpecialistPasses는 실제로는
  // 이미 각자 catalog.json을 따로 읽고 파싱한다 — 그 중복은 존재하고,
  // 아직 남아 있는 별도 정리 항목이다. 여기서 두 loader의 결과를 합쳐
  // 하나의 `sections`로 넘기는 것은 그 중복을 막기 위해서가 아니라, render
  // 자체를 두 loader의 파일 I/O에서 떼어 놓기 위해서다.)
  const specialistPasses = loadSpecialistPasses(rulesDir, flag('planned'))
  if (specialistPasses.error) die(specialistPasses.error)

  const byCandidateId = new Map()
  for (const path of flagAll('verdicts')) {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      die(`--verdicts를 읽지 못했다: ${path} — ${error.message}`)
    }
    // labelFor는 disposition만으로 rejected를 판단하지 않는다 —
    // rebuttal.kind가 삭제를 허용하는 kind인지도 봐야 `other`·`location-wrong`
    // 같은 반박을 계약(C-6B)대로 모든 phase에서 살려둘 수 있다. 그래서 문자열
    // 하나가 아니라 { disposition, rebuttalKind, … } 객체를 싣는다. rebuttal이 없는
    // disposition(upheld·needs-context)에서는 rebuttalKind가 그냥
    // undefined로 남고 labelFor는 그 값을 보지 않는다.
    //
    // `rebuttalLocation`은 `location-wrong` 반박이 짚은 결함의 자리다. 지적은 남고
    // 렌더러가 그 자리를 함께 그린다 — 여기서 버리면 "위치가 틀렸다"는 말만 남고
    // 어디가 맞는지는 리포트에서 사라진다.
    //
    // `reason`도 함께 싣는다. labelFor는 이 값을 쓰지 않지만, 계약이
    // `needs-context`에 필수로 요구하는 필드이고(disposition.requires)
    // 그 finding이 `미해결 / 후속 확인`으로 옮겨질 때 "무엇을 더 봐야
    // 하는가"를 말하는 유일한 값이다. 여기서 버리면 뒤에서 되찾을 방법이
    // 없다 — 이 loader가 판정 파일을 읽는 유일한 자리다.
    //
    // 파일의 모양은 `tally-verdicts.mjs`와 같은 함수로 푼다. 한때 여기서
    // `parsed.verdicts`만 봤는데, tally가 받는 `{ tasks: [...] }` 파일을
    // 넘기면 판정이 0건이 되어 검증 대상 전부가 `검증 실패`로 찍혔다 —
    // 두 스크립트가 같은 파일을 서로 다르게 읽었고, 오류는 나지 않았다.
    let verdicts
    try {
      verdicts = collectVerdicts(parsed)
    } catch (error) {
      die(`--verdicts에서 판정 목록을 찾지 못했다: ${path} — ${error.message}`)
    }
    for (const verdict of verdicts) {
      byCandidateId.set(verdict.candidateId, {
        disposition: verdict.disposition,
        rebuttalKind: verdict.rebuttal?.kind,
        rebuttalLocation: verdict.rebuttal?.location,
        reason: verdict.reason,
      })
    }
  }
  // 재현 근거(C-11). 근거 파일은 실행 하나의 것이므로, 이 routed 출력과 같은 실행인지 먼저 본다.
  // routed에 실행 ID가 없으면(`--collect`가 아닌 입력) 대조할 수 없으므로 받지 않는다.
  let evidence
  const evidencePath = flag('evidence')
  if (evidencePath !== undefined) {
    const runId = payload.collected?.runId
    if (!runId) die('--evidence는 prepare-verification.mjs --collect의 출력과 함께 쓴다 — routed 출력에 collected.runId가 없어 근거 파일이 같은 실행의 것인지 확인할 수 없다')
    const loaded = loadEvidence(evidencePath, { routedSha256: createHash('sha256').update(inputText).digest('hex') })
    if (loaded.error) die(loaded.error)
    if (loaded.doc.run.runId !== runId) die(`--evidence는 다른 실행(${loaded.doc.run.runId})의 근거 파일이다 — 이 routed 출력은 ${runId}다`)
    for (const problem of loaded.problems) process.stderr.write(`경고: 근거 실행 기록 ${problem}\n`)
    evidence = assessEvidence(loaded.doc, loaded.executions, new Set(payload.candidates.map(candidate => candidate.candidateId)))
  }

  // 재확인·같은 결함 판정(C-13). 이전 리뷰와 비교한 실행에서 tally-verdicts.mjs --collect가 남긴 파일이다.
  let rechecks
  const rechecksPath = flag('rechecks')
  if (rechecksPath !== undefined) {
    if (!payload.previous) die('--rechecks는 이전 리뷰와 비교한 실행(routed 출력에 previous가 있다)에서만 준다')
    let list
    try {
      list = collectVerdicts(JSON.parse(readFileSync(rechecksPath, 'utf8')))
    } catch (error) {
      die(`--rechecks를 읽지 못했다: ${rechecksPath} — ${error.message}`)
    }
    rechecks = new Map(list.map(verdict => [verdict.candidateId, verdict]))
  }

  // render는 그릴 수 없는 입력(닫힌 목록 밖 disposition, kind가 module도
  // pass도 아닌 section)을 만나면 던진다. 여기서 잡지 않으면 CLI가 raw
  // stack trace와 기본 종료 코드(1)로 죽는다 — 이 파일의 다른 모든
  // 거부(die)가 exit 2와 짧은 사유 메시지로 끝나는 것과 어긋난다.
  let output
  try {
    output = render(
      payload.candidates, byCandidateId, phaseByImpact, vocabulary.value,
      [...sections.value, ...specialistPasses.value], verificationState,
      {
        collected: Array.isArray(payload.collected?.sources) ? new Set(payload.collected.sources) : undefined,
        // 선택 패스를 켰는지(`prepare-verification.mjs --collect`가 run.start에서 읽는다)와,
        // 켜지 않았는데 결과가 있어 모으지 않은 패스.
        optIn: payload.collected?.optIn,
        excludedNotRequested: new Set(payload.collected?.excludedNotRequested ?? []),
        evidence,
        rechecks,
        deletionGate,
      })
  } catch (error) {
    die(error.message)
  }
  // stdout은 Markdown 전용이다 — 두 섹션 자리에 그대로 붙일 값이라, 다른
  // 텍스트가 섞이면 그 자리에 잡음이 낀다. 이동된 finding 알림은 stderr로
  // 낸다: 이 렌더러는 `미해결 / 후속 확인`을 쓰지 않으므로, 여기서 빠졌다는
  // 사실을 알리지 않으면 operator가 stdout만 보고 finding이 그냥 사라졌다고
  // 오인한다.
  if (output.movedToOpenQuestions.length > 0) {
    // 항목마다 옮겨 적을 재료를 전부 편다. ruleId와 title만 내던 때에는
    // 받는 쪽이 producer JSON을 다시 열어 사유와 본문을 찾아야 했고, 그
    // 왕복이 바로 이 렌더러가 없애려는 수작업이다.
    const notice = output.movedToOpenQuestions
      .map(entry => [
        `  - ${entry.ruleId} (${entry.id}): ${entry.title}`,
        // 여기 실린 값은 그대로 리포트에 붙는다. 상세 지적과 같은 이유로
        // 같은 escape를 거친다 — 개행 하나가 슬롯을 여러 줄로 쪼개고
        // `<div>`가 0열에 나앉는 구멍은 이 경로에도 똑같이 있다.
        `    추가 확인 이유: ${entry.reason ? escapeProse(entry.reason) : '(verifier가 reason을 내지 않았다 — 계약상 needs-context에는 필수다)'}`,
        ...(entry.sources.length ? [`    출처 패스: ${entry.sources.map(escapeProse).join(', ')}`] : []),
        `    ${locationLine(entry)}`,
        `    본문: ${escapeProse(entry.content.body)}`,
        ...(entry.content.evidence ? [`    근거: ${escapeProse(entry.content.evidence)}`] : []),
      ].join('\n'))
      .join('\n')
    process.stderr.write(
      `needs-context로 판정된 finding ${output.movedToOpenQuestions.length}건을 상세 지적에서 뺐다 — ` +
      `이 렌더러는 \`미해결 / 후속 확인\`을 쓰지 않으므로 아래 내용을 직접 그 섹션에 옮겨 적어야 한다:\n${notice}\n`)
  }
  // active-deletion이 지운 rejected finding도 같은 이유로 stderr에 낸다 —
  // C-6B "오판 가시성"이 요구하는 흔적이고, 이 렌더러는 `미해결 / 후속 확인`을
  // 쓰지 않으므로 operator가 직접 그 섹션에 옮겨 적어야 한다.
  const { high, lowCount } = output.activeDeletionRemovals
  if (high.length > 0 || lowCount > 0) {
    const highLines = high.map(entry => `  - ${entry.ruleId} (${entry.path ?? '경로 미상'}): ${entry.rebuttalKind ?? '사유 미상'}`)
    process.stderr.write(
      `active-deletion phase에서 반박되어 상세 지적에서 지워진 finding이 있다 — ` +
      `이 렌더러는 \`미해결 / 후속 확인\`을 쓰지 않으므로 아래를 직접 그 섹션에 옮겨 적어야 한다:\n` +
      [...highLines, lowCount > 0 ? `  - impact 낮음: ${lowCount}건 (건별 내역 없음)` : null].filter(Boolean).join('\n') + '\n')
  }
  process.stdout.write(output.markdown)
}
