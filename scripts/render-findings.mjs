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
 * 판정이 없는 검증 대상(`verdict === undefined`)은 입력 오류가 아니라
 * `검증 실패`다. verifier가 타임아웃 나서 실제로 있었던 일이고, 조용히
 * 사라지면 안 되는 사실이라 그대로 표기한다.
 *
 * `verdictByCandidateId`의 값은 disposition 문자열 하나가 아니라
 * `{ disposition, rebuttalKind }`다. `rebuttal.kind`를 같이 실어야 하는
 * 이유는 계약(C-6B)이 `rebuttal.kind = other`를 세 번 못박기 때문이다 —
 * "`other`는 어떤 phase에서도 finding의 상태를 바꾸지 않는다", "삭제를
 * 유발하지 않는다", "차단 우회로가 되어서는 안 된다". disposition만 보고
 * `rejected`면 무조건 active-deletion에서 지우면, `other`로 반박된
 * high-impact finding까지 계약이 금지한 그 우회로로 사라진다. `kind`가
 * `other`인 반박은 그래서 `rejected`의 일반 경로(active-deletion에서
 * null, rollout-shadow에서 `rejected-shadow`)를 타지 않고 모든 phase에서
 * `rejected-other`로 남는다.
 */
export function labelFor(candidate, verdictByCandidateId, phase, vocabulary) {
  const tokens = vocabulary.crossVerification
  if (candidate.eligibility !== 'VERIFY') return tokens['not-eligible']
  const verdict = verdictByCandidateId.get(candidate.candidateId)
  if (verdict === undefined) return tokens['verification-unavailable']
  const { disposition, rebuttalKind } = verdict
  if (disposition === 'needs-context') return tokens['scope-open']
  if (disposition === 'rejected') {
    if (rebuttalKind === 'other') return tokens['rejected-other']
    return phase === 'rollout-shadow' ? tokens['rejected-shadow'] : null
  }
  return tokens.upheld
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
    .map(module => ({ kind: 'module', id: module.id, title: module.title }))
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
export function loadSpecialistPasses(rulesDir) {
  let catalog
  try {
    catalog = JSON.parse(readFileSync(join(rulesDir, 'catalog.json'), 'utf8'))
  } catch (error) {
    return { error: `catalog.json을 읽지 못했다: ${error.message}` }
  }
  const byId = new Map((catalog.modules ?? []).map(module => [module.id, module]))
  const passes = []
  for (const [id, title] of [['props', 'Props'], ['math', '수학'], ['exception', '예외']]) {
    const prefixes = byId.get(id)?.rulePrefixes
    if (!Array.isArray(prefixes) || prefixes.length === 0) {
      return { error: `catalog.json의 "${id}" specialist 항목에 rulePrefixes가 없다 — 특수 패스 접두를 알 수 없다` }
    }
    passes.push({ kind: 'pass', id, title, prefixes })
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
 * 직접 읽지 않는다(rulesDir을 받지 않는다); 그 경로는 CLI 배선 한 곳에만
 * 있어야 같은 rulesDir 인자를 두 번 파싱하다 어긋나는 일이 없다.
 */
export function render(candidates, verdictByCandidateId, phase, vocabulary, sections, crossVerified) {
  const labelled = []
  for (const candidate of candidates) {
    // 교차검증 패스가 없었으면 축 자체가 없다(`undefined`). 돌았는데 판정이
    // 없는 것과 다른 사건이라 `labelFor`를 부르지 않는다.
    const label = crossVerified ? labelFor(candidate, verdictByCandidateId, phase, vocabulary) : undefined
    // `null`은 이 phase에서 리포트에 나타나지 않는다는 뜻이다 — 정렬·순번을
    // 매기기 전에 걸러야, 지워진 finding이 "(1/3)" 같은 분모를 차지하지 않는다.
    // (리뷰 fix round 1, Important 1 — 순번을 먼저 매기고 나중에 거르면
    // 분모가 걸러지기 전 건수로 굳어 남는다.)
    if (label === null) continue
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

  const lines = ['## 상세 지적', '']
  const titleById = new Map(moduleSections.map(section => [section.id, section.title]))
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
      lines.push('지적 없음.', '')
      continue
    }
    for (const candidate of inModule) {
      lines.push(renderFinding(candidate, { label: labelById.get(candidate.candidateId), vocabulary }), '')
    }
  }

  if (specials.length) {
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
    for (const [title, inPass] of grouped) {
      if (!inPass.length) continue
      lines.push(`### ${title}`, '')
      for (const candidate of inPass) {
        lines.push(renderFinding(candidate, { label: labelById.get(candidate.candidateId), vocabulary }), '')
      }
    }
  }

  return lines.join('\n')
}

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

  // 특수 패스(Props·수학·예외) 섹션도 같은 catalog.json에서 나온다. render는
  // rulesDir을 받지 않으므로 — 그 경로를 두 곳에서 따로 파싱하면 하나만
  // 바뀌었을 때 조용히 어긋난다 — 모듈 섹션과 합쳐 하나의 `sections`로
  // 넘긴다.
  const specialistPasses = loadSpecialistPasses(rulesDir)
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
    // rebuttal.kind가 'other'인지도 봐야 그 반박을 계약(C-6B)대로 모든
    // phase에서 살려둘 수 있다. 그래서 문자열 하나가 아니라
    // { disposition, rebuttalKind } 객체를 싣는다. rebuttal이 없는
    // disposition(upheld·needs-context)에서는 rebuttalKind가 그냥
    // undefined로 남고 labelFor는 그 값을 보지 않는다.
    for (const verdict of parsed.verdicts ?? []) {
      byCandidateId.set(verdict.candidateId, { disposition: verdict.disposition, rebuttalKind: verdict.rebuttal?.kind })
    }
  }
  // 하나도 주지 않으면 교차검증 패스가 없었다는 뜻이다. 준 뒤에 어떤 후보의
  // 판정이 없는 것과는 다른 사건이라, 전자는 축 자체를 렌더링하지 않는다.
  const crossVerified = flagAll('verdicts').length > 0

  process.stdout.write(render(
    payload.candidates, byCandidateId, phase, vocabulary.value,
    [...sections.value, ...specialistPasses.value], crossVerified))
}
