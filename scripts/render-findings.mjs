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
 * escapeProse의 개행 결함과 같은 종류를 여기서도 먼저 막는다 — `path`·
 * `quote`는 producer가 채우는 신뢰하지 않는 값이라 개행이 그대로 들어올 수
 * 있다. 단순 개행은 위치 줄을 여러 물리 줄로 새게 할 뿐이지만, 빈 줄(개행
 * 두 번)은 그보다 나쁘다 — CommonMark의 code span은 빈 줄을 담지 못해 여는
 * backtick의 짝이 사라지고, 그 지점부터 리포트 구조 전체가 깨진다.
 *
 * 공백을 먼저 접고 그 결과로 delimiter 길이를 잰다(순서가 반대면 안 된다).
 * 다만 이 정규식 조합에서는 순서를 바꿔도 실제로 다른 값이 나오지 않는다 —
 * `\s+`는 항상 공백 한 칸으로 치환되지 0으로 치환되지 않으므로, 개행으로
 * 갈라져 있던 backtick 연속 두 개가 접힌다고 해서 하나로 합쳐지는 일은
 * 없다. 그래도 "접은 뒤의 값을 재는" 순서로 코드를 짜 둔다 — 다음에 이
 * 정규식이 바뀌어 그 전제가 깨지더라도, 코드 순서 자체가 이미 안전한 쪽을
 * 향해 있게 만든다.
 */
export function codeSpan(text) {
  const value = String(text).replace(/\s+/g, ' ').trim()
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
