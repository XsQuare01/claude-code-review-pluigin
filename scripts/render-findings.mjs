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

// Task 4가 실제 Markdown을 채운다. 지금은 거부 경로만 검증하므로 빈 문자열로
// 충분하다 — 이 자리를 비워두면(스텁을 두지 않으면) 통과하는 모든 입력에서
// ReferenceError로 죽어, 거부 테스트만 보고 "됐다"고 착각하게 된다.
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
