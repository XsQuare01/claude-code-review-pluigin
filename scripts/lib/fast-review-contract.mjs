// /code-review-fast가 리뷰다운 리뷰를 하는 데 필요한 조건을 문서에서 확인한다.
//
// 2026-11-02 진단에서 fast는 네 군데가 비어 있었다. 리뷰어는 fast.md 하나만 받아 등급을 정할 근거
// (00-rule.md의 영향도 × 확신도)가 없었고, 파일당 1개만 내 같은 파일의 두 번째 결함을 버렸고,
// 규칙 목록과 맞춰 볼 뿐 변경이 의도대로 동작하는지는 묻지 않았고, 리뷰 전에 lint를 기다리게 하고는
// 그 결과를 리포트에 싣지 않았다. 판정은 지적 0개를 승인으로 적었다.
//
// PR #110 리뷰가 넷을 더 짚었다. 리포트는 리뷰어 표를 옮겨 적어 full과 형식이 달랐고, 사용자가 `--base`를 주면
// PR 조회가 함께 빠져 PR 설명 없이 의도를 추정했고, PR 설명을 리뷰 지시와 구분하지 않았고, 판정이 고정 문장이라
// 영향 낮음·확신 높음(🟡)을 "영향은 높지만 확인 못 한 지적"으로 설명했다.
//
// 모두 문장으로만 정해지는 것이라, 문장이 되돌아오면 이 검사가 실패한다.

export const FAST_REVIEW_CODES = {
  SEVERITY_BASIS: 'E_FAST_SEVERITY_BASIS',
  PER_FILE_CAP: 'E_FAST_PER_FILE_CAP',
  CORRECTNESS: 'E_FAST_CORRECTNESS',
  INTENT_SOURCE: 'E_FAST_INTENT_SOURCE',
  INTENT_UNTRUSTED: 'E_FAST_INTENT_UNTRUSTED',
  SHARED_RENDERER: 'E_FAST_SHARED_RENDERER',
  SHARED_TEMPLATE: 'E_FAST_SHARED_TEMPLATE',
  FIXED_VERDICT: 'E_FAST_FIXED_VERDICT',
  TOOL_RESULT: 'E_FAST_TOOL_RESULT',
  APPROVAL_OVERCLAIM: 'E_FAST_APPROVAL_OVERCLAIM',
  REPORT_SKELETON: 'E_FAST_REPORT_SKELETON',
  PROMPT_NOT_FOUND: 'E_FAST_PROMPT_NOT_FOUND',
}

// "파일당 최대 1개", "가장 중요한 것 1개만" 같은 개수 상한. "개수 상한은 없다"는 걸리지 않는다.
const PER_FILE_CAP = /(?:파일당|파일별)[^\n|]{0,24}?1\s*개|가장\s*(?:중요한|심각한)\s*(?:것|이슈)\s*1\s*개/
// 지적 0개를 승인으로 읽히게 하는 문구 — 확인한 범위를 넘어선 결론이다
const APPROVAL = /머지\s*가능|전부\s*통과/
// 판정의 고정 문장. 🟡을 한 가지 뜻으로 설명하거나, 이 실행이 하지 않은 일을 실제 실행과 무관하게 나열한다
const FIXED_VERDICT = /🟡\s*\S*건\s*—\s*영향은 높지만|이 리뷰가 보지 않은 것:/
// 공통 틀의 골격. 상세 지적과 특수 패스는 렌더러 조각(`{{findings}}`)이 연다
const SKELETON = ['## 리뷰 기준', '## 판정', '{{findings}}', '## 미해결 / 후속 확인']
// full과 같은 스크립트로 결과를 받고 그리는가 — 실제로 부르는 줄(`node …` 또는 그 명령을 담은 코드 스팬)이 있어야 한다
const SHARED_STEPS = [
  { name: 'review-tasks.mjs next', pattern: /node\s+\S*review-tasks\.mjs"?\s+next\b/ },
  { name: 'prepare-verification.mjs --collect', pattern: /node\s+\S*prepare-verification\.mjs"?[^\n]*--collect/ },
  { name: 'render-findings.mjs --workflow fast', pattern: /node\s+\S*render-findings\.mjs"?[^\n]*--workflow fast\b/ },
  { name: 'review-snapshot.mjs', pattern: /node\s+\S*review-snapshot\.mjs/ },
]
// 리뷰어 표를 한 행씩 옮겨 적던 예전 틀의 머리
const LEGACY_TABLE = /\|\s*심각도\s*\|\s*규칙\s*\|\s*위치\s*\|/

/**
 * 리뷰어를 띄우는 `task(` 호출의 `prompt="…"` 본문. 프롬프트 밖의 문장(실행 안전 안내 등)은 리뷰어가 받지
 * 못하므로, 리뷰어가 받는 것을 묻는 검사는 이 본문만 본다. 찾지 못하면 null이다.
 */
const producerPrompt = skill => {
  const call = skill.search(/\btask\s*\(/)
  if (call === -1) return null
  const open = skill.indexOf('prompt="', call)
  if (open === -1) return null
  const close = skill.indexOf('"\n)', open)
  return close === -1 ? null : skill.slice(open + 'prompt="'.length, close)
}

/**
 * fast SKILL(`skill`)·압축 규칙(`rules`)·공통 리포트 틀(`template`)에서 위 조건을 본다. 문제마다 `{ code, message }`를 돌려준다.
 */
export const checkFastReview = ({
  skill, rules, template,
  skillPath = 'skills/code-review-fast/SKILL.md', rulesPath = 'review-rules/fast.md', templatePath = 'review-rules/report-template.md',
}) => {
  const problems = []
  const add = (code, message, where = skillPath) => problems.push({ code, message: `${where}: ${message}` })

  const prompt = producerPrompt(skill)
  if (prompt === null) {
    add(FAST_REVIEW_CODES.PROMPT_NOT_FOUND, 'cannot find the reviewer prompt (`task(` … `prompt="…"`) — the checks below read what the reviewer receives, so they cannot run')
  } else {
    if (!prompt.includes('00-rule.md') || /이 문서 하나만/.test(prompt)) {
      add(FAST_REVIEW_CODES.SEVERITY_BASIS, 'the reviewer prompt must hand over 00-rule.md alongside fast.md — without it the reviewer has no impact × confidence derivation and copies the fixed rule emoji')
    }
    if (!prompt.includes('correctness.md') || !prompt.includes('{INTENT')) {
      add(FAST_REVIEW_CODES.CORRECTNESS, 'the reviewer prompt must carry correctness.md and the change intent ({INTENT…}) — without them fast only matches rules and never asks whether the change does what it intends')
    }
    if (!prompt.includes('신뢰하지 않는 데이터') || !/따르지 마/.test(prompt)) {
      add(FAST_REVIEW_CODES.INTENT_UNTRUSTED, 'the reviewer prompt must say the intent text is untrusted data whose instructions are not followed — a PR description can carry "skip this file" or "report nothing"')
    }
  }

  if (!/^\s*node\s+\S*review-intent\.mjs/m.test(skill)) {
    add(FAST_REVIEW_CODES.INTENT_SOURCE, 'the change intent must be collected by `node …/review-intent.mjs` — reading the PR off the base line drops the PR description whenever the user passes --base')
  }

  const missingSteps = SHARED_STEPS.filter(step => !step.pattern.test(skill)).map(step => step.name)
  if (missingSteps.length || LEGACY_TABLE.test(skill)) {
    add(FAST_REVIEW_CODES.SHARED_RENDERER, `results must go through the same scripts as /code-review-full (${missingSteps.length ? `missing: ${missingSteps.join(', ')}` : 'the reviewer table template is still here'}) — a hand-copied table differs from full's finding blocks`)
  }

  if (!skill.includes('report-template.md')) {
    add(FAST_REVIEW_CODES.SHARED_TEMPLATE, 'the report must be written from review-rules/report-template.md, the template full uses too')
  }

  for (const [where, text] of [[skillPath, skill], [rulesPath, rules], [templatePath, template]]) {
    const cap = text.match(PER_FILE_CAP)
    if (cap) add(FAST_REVIEW_CODES.PER_FILE_CAP, `caps findings per file ("${cap[0]}") — a second independent defect in the same file gets dropped`, where)
    const approval = text.match(APPROVAL)
    if (approval) add(FAST_REVIEW_CODES.APPROVAL_OVERCLAIM, `words the verdict as approval ("${approval[0]}") — zero findings in a narrowed review is not a pass`, where)
  }
  for (const [where, text] of [[skillPath, skill], [templatePath, template]]) {
    const fixed = text.match(FIXED_VERDICT)
    if (fixed) add(FAST_REVIEW_CODES.FIXED_VERDICT, `fixes the verdict wording ("${fixed[0]}") — 🟡 is both high impact · low confidence and low impact · high confidence, and what did not run must come from the run`, where)
  }

  if (!template.includes('## 도구 실행 결과')) {
    add(FAST_REVIEW_CODES.TOOL_RESULT, 'the report template has no `## 도구 실행 결과` — tool runs, or the fact that none ran, must reach the report (C-7, 00-9)', templatePath)
  }

  const missing = [...SKELETON.filter(heading => !template.includes(heading)), ...(/^> \*\*범위\*\*:/m.test(template) ? [] : ['> **범위**:'])]
  if (missing.length > 0) {
    add(FAST_REVIEW_CODES.REPORT_SKELETON, `the report template must follow the C-7 skeleton with the scope line under 리뷰 기준 (missing: ${missing.join(', ')})`, templatePath)
  }

  return problems
}
