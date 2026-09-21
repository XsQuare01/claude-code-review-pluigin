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
//        [--verdicts <경로> …] --phase <active-deletion|rollout-shadow> --rules <RULES_DIR>

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { markedJson } from './lib/contract-blocks.mjs'

const IMPACTS = new Set(['high', 'low'])
const CONFIDENCES = new Set(['high', 'low'])
const LOCATION_KINDS = new Set(['verified', 'deleted', 'unverified'])
const PHASES = new Set(['active-deletion', 'rollout-shadow'])

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
  const contract = readFileSync(join(rulesDir, 'workflow-contract.md'), 'utf8')
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
  return {
    value: {
      categoryLabels,
      crossVerification: tokens.value?.tokens,
    },
  }
}

const flag = name => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}
const flagAll = name => process.argv
  .map((arg, at) => (arg === `--${name}` ? process.argv[at + 1] : null))
  .filter(value => value !== null && value !== undefined)

const IMPACT_WORD = { high: '높음', low: '낮음' }

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
 */
export function escapeProse(text) {
  const collapsed = String(text).replace(/\s+/g, ' ').trim()
  return collapsed.replace(/[\\`*_[\]()#>|<]/g, match => `\\${match}`)
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

const locationLine = location => {
  if (location.kind === 'unverified') return `위치 미확인 사유: ${escapeProse(location.reason)}`
  const line = location.kind === 'deleted' ? location.lineBefore : location.line
  return `${codeSpan(`${location.path}:${line}`)} — ${codeSpan(location.quote)}`
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
export function renderFinding(candidate, { label, vocabulary }) {
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

  return [
    `#### ${severity} \`${candidate.renderedRuleId ?? candidate.ruleId}\` ${escapeProse(candidate.content.title)}`,
    axes.join(' · '),
    locationLine(candidate.location),
    ...slots,
  ].join('\n')
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
 * 판정이 없는 검증 대상(`disposition === undefined`)은 입력 오류가 아니라
 * `검증 실패`다. verifier가 타임아웃 나서 실제로 있었던 일이고, 조용히
 * 사라지면 안 되는 사실이라 그대로 표기한다.
 */
export function labelFor(candidate, verdictByCandidateId, phase, vocabulary) {
  const tokens = vocabulary.crossVerification
  if (candidate.eligibility !== 'VERIFY') return tokens['not-eligible']
  const disposition = verdictByCandidateId.get(candidate.candidateId)
  if (disposition === undefined) return tokens['verification-unavailable']
  if (disposition === 'needs-context') return tokens['scope-open']
  if (disposition === 'rejected') {
    return phase === 'rollout-shadow' ? tokens['rejected-shadow'] : null
  }
  return tokens.upheld
}

// Task 6이 실제 정렬·묶음을 채운다. 지금은 거부 경로와 renderFinding 단위
// 테스트만 검증하므로 빈 문자열로 충분하다 — 이 자리를 비워두면(스텁을 두지
// 않으면) 통과하는 모든 입력에서 ReferenceError로 죽어, 거부 테스트만 보고
// "됐다"고 착각하게 된다.
export function render() { return '' }

// render와 같은 이유로 스텁을 둔다. CLI 본문이 항상 호출하므로, 스텁이 없으면
// 유효한 입력에서 ReferenceError가 나는데 이 태스크의 테스트는 거부 경로만
// 확인해서 그 결함을 못 잡는다. Task 6이 실제 모듈 섹션 목록으로 교체한다.
export function loadModuleSections() { return { value: [] } }

// 이 파일이 직접 실행될 때만 CLI로 동작한다. 테스트는 함수를 import한다.
if (process.argv[1] && process.argv[1].endsWith('render-findings.mjs')) {
  const inputPath = flag('input')
  const rulesDir = flag('rules')
  const phase = flag('phase')
  const workflow = flag('workflow')
  if (!inputPath) die('--input <경로>가 필요하다')
  if (!rulesDir) die('--rules <RULES_DIR>가 필요하다')
  if (!workflow) die('--workflow <이름>이 필요하다 — 어느 모듈이 섹션이 되는지가 여기서 갈린다')
  // 기본값을 두지 않는다. 반박된 finding의 처리가 갈리고 그 값이 차단 판정에
  // 걸리므로, 조용히 틀린 쪽으로 도는 것보다 멈추는 편이 낫다.
  if (!PHASES.has(phase)) die(`--phase는 ${[...PHASES].join(' 또는 ')} 중 하나여야 한다`)

  let payload
  try {
    payload = JSON.parse(readFileSync(inputPath, 'utf8'))
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

  const byCandidateId = new Map()
  for (const path of flagAll('verdicts')) {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      die(`--verdicts를 읽지 못했다: ${path} — ${error.message}`)
    }
    for (const verdict of parsed.verdicts ?? []) byCandidateId.set(verdict.candidateId, verdict.disposition)
  }
  // 하나도 주지 않으면 교차검증 패스가 없었다는 뜻이다. 준 뒤에 어떤 후보의
  // 판정이 없는 것과는 다른 사건이라, 전자는 축 자체를 렌더링하지 않는다.
  const crossVerified = flagAll('verdicts').length > 0

  process.stdout.write(render(
    payload.candidates, byCandidateId, phase, vocabulary.value, sections.value, crossVerified))
}
