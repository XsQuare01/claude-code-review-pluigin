// /code-review-fast가 리뷰다운 리뷰를 하는 데 필요한 조건을 문서에서 확인한다.
//
// 2026-11-02 진단에서 fast는 네 군데가 비어 있었다. 리뷰어는 fast.md 하나만 받아 등급을 정할 근거
// (00-rule.md의 영향도 × 확신도)가 없었고, 파일당 1개만 내 같은 파일의 두 번째 결함을 버렸고,
// 규칙 목록과 맞춰 볼 뿐 변경이 의도대로 동작하는지는 묻지 않았고, 리뷰 전에 lint를 기다리게 하고는
// 그 결과를 리포트에 싣지 않았다. 판정은 지적 0개를 승인으로 적었다. 모두 문장으로만 정해지는
// 것이라, 문장이 되돌아오면 이 검사가 실패한다.

export const FAST_REVIEW_CODES = {
  SEVERITY_BASIS: 'E_FAST_SEVERITY_BASIS',
  PER_FILE_CAP: 'E_FAST_PER_FILE_CAP',
  CORRECTNESS: 'E_FAST_CORRECTNESS',
  TOOL_RESULT: 'E_FAST_TOOL_RESULT',
  APPROVAL_OVERCLAIM: 'E_FAST_APPROVAL_OVERCLAIM',
  REPORT_SKELETON: 'E_FAST_REPORT_SKELETON',
  PROMPT_NOT_FOUND: 'E_FAST_PROMPT_NOT_FOUND',
}

// "파일당 최대 1개", "가장 중요한 것 1개만" 같은 개수 상한. "개수 상한은 없다"는 걸리지 않는다.
const PER_FILE_CAP = /(?:파일당|파일별)[^\n|]{0,24}?1\s*개|가장\s*(?:중요한|심각한)\s*(?:것|이슈)\s*1\s*개/
// 지적 0개를 승인으로 읽히게 하는 문구 — 확인한 범위를 넘어선 결론이다
const APPROVAL = /머지\s*가능|전부\s*통과/
const SKELETON = ['## 리뷰 기준', '## 판정', '## 상세 지적', '## 미해결 / 후속 확인']

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
 * fast SKILL(`skill`)과 압축 규칙(`rules`)에서 위 조건을 본다. 문제마다 `{ code, message }`를 돌려준다.
 */
export const checkFastReview = ({ skill, rules, skillPath = 'skills/code-review-fast/SKILL.md', rulesPath = 'review-rules/fast.md' }) => {
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
      add(FAST_REVIEW_CODES.CORRECTNESS, 'the reviewer prompt must carry correctness.md and the change intent ({INTENT}) — without them fast only matches rules and never asks whether the change does what it intends')
    }
  }

  for (const [where, text] of [[skillPath, skill], [rulesPath, rules]]) {
    const cap = text.match(PER_FILE_CAP)
    if (cap) add(FAST_REVIEW_CODES.PER_FILE_CAP, `caps findings per file ("${cap[0]}") — a second independent defect in the same file gets dropped`, where)
    const approval = text.match(APPROVAL)
    if (approval) add(FAST_REVIEW_CODES.APPROVAL_OVERCLAIM, `words the verdict as approval ("${approval[0]}") — zero findings in a narrowed review is not a pass`, where)
  }

  if (!skill.includes('## 도구 실행 결과')) {
    add(FAST_REVIEW_CODES.TOOL_RESULT, 'the report template has no `## 도구 실행 결과` — tool runs, or the fact that none ran, must reach the report (C-7, 00-9)')
  }

  const missing = [...SKELETON.filter(heading => !skill.includes(heading)), ...(/^> \*\*범위\*\*:/m.test(skill) ? [] : ['> **범위**:'])]
  if (missing.length > 0) {
    add(FAST_REVIEW_CODES.REPORT_SKELETON, `the report template must follow the C-7 skeleton with the scope line under 리뷰 기준 (missing: ${missing.join(', ')})`)
  }

  return problems
}
