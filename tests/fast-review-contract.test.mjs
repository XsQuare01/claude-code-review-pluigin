import { test } from 'node:test'
import assert from 'node:assert/strict'

import { FAST_REVIEW_CODES, checkFastReview } from '../scripts/lib/fast-review-contract.mjs'

// /code-review-fast가 "제대로 리뷰하지 않던" 네 원인이 문서로 되돌아오지 못하게 고정한다.
//
// 2026-11-02 진단: 리뷰어는 fast.md 하나만 받아 등급을 정할 근거(00-rule.md의 영향도 × 확신도)가 없었고,
// 파일당 1개만 내 같은 파일의 두 번째 결함을 버렸고, 규칙 목록과 맞춰 볼 뿐 변경이 의도대로 동작하는지는
// 묻지 않았고, 리뷰 전에 lint를 기다리게 하고는 그 결과를 리포트에 싣지 않았다. 판정은 지적 0개를
// "전부 통과"·"머지 가능"으로 적었다. 각 검사는 그중 하나가 다시 들어오면 실패한다.

const PROMPT = [
  '## 리뷰 대상',
  '- 변경 파일: {CHANGED_FILES}',
  '',
  '## 변경 의도',
  '{INTENT — Step 2에서 모은 의도와 출처}',
  '',
  '## 리뷰 규칙',
  '- `{RULES_DIR}/00-rule.md` — 등급과 근거',
  '- `{RULES_DIR}/fast.md` — 압축 규칙',
  '- `{RULES_DIR}/correctness.md` — 의도대로 동작하는가',
].join('\n')

const SKILL = [
  '# Fast Code Review',
  '',
  '이 워크플로우는 legacy producer workflow다. `00-rule.md` 00-9를 따른다.',
  '',
  '```',
  'task(',
  '  subagent_type="react-code-review-plugin:rule-module-reviewer",',
  '  load_skills=[],',
  `  prompt="${PROMPT}"`,
  ')',
  '```',
  '',
  '```markdown',
  '# `{대상}` 빠른 코드 리뷰 리포트',
  '',
  '## 리뷰 기준',
  '',
  '> **범위**: {`review-scope.mjs`의 `line` 그대로}',
  '',
  '## 판정',
  '',
  '## 상세 지적',
  '',
  '## 도구 실행 결과',
  '',
  '## 미해결 / 후속 확인',
  '```',
].join('\n')

const RULES = [
  '# Fast Code Review Rules',
  '',
  '## 선별 규칙',
  '',
  '- 영향 높음 지적은 개수 상한 없이 전부 낸다',
].join('\n')

const codes = (skill = SKILL, rules = RULES) =>
  checkFastReview({ skill, rules }).map(problem => problem.code)

test('네 결함이 모두 고쳐진 문서는 통과한다', () => {
  assert.deepEqual(codes(), [])
})

test('리뷰어 프롬프트가 00-rule.md를 넘기지 않으면 등급을 정할 근거가 없다', () => {
  // 00-rule.md가 프롬프트 밖(실행 안전 안내)에만 있으면 리뷰어는 받지 못한다 — 예전 SKILL이 그랬다
  const skill = SKILL.replace('- `{RULES_DIR}/00-rule.md` — 등급과 근거\n', '')
  assert.ok(skill.includes('`00-rule.md` 00-9'))
  assert.deepEqual(codes(skill), [FAST_REVIEW_CODES.SEVERITY_BASIS])
})

test('규칙 문서 하나만 쓰라는 지시는 00-rule.md를 함께 넘겨도 등급 근거를 지운다', () => {
  const skill = SKILL.replace('## 리뷰 규칙', '## 리뷰 규칙\n이 문서 하나만 사용합니다.')
  assert.deepEqual(codes(skill), [FAST_REVIEW_CODES.SEVERITY_BASIS])
})

test('파일당 1개 상한이 SKILL이나 fast.md 어디에 있어도 실패한다', () => {
  for (const phrase of ['파일당 최대 1개', '같은 파일에서 여러 이슈가 보여도 가장 중요한 것 1개만', '파일별 가장 중요한 이슈 1개만', '가장 심각한 것 1개만 출력', '파일당 이슈는 최대 1개']) {
    assert.deepEqual(codes(`${SKILL}\n- ${phrase}`), [FAST_REVIEW_CODES.PER_FILE_CAP], `SKILL: ${phrase}`)
    assert.deepEqual(codes(SKILL, `${RULES}\n- ${phrase}`), [FAST_REVIEW_CODES.PER_FILE_CAP], `fast.md: ${phrase}`)
  }
})

test('상한이 없다고 적은 문장은 상한으로 읽지 않는다', () => {
  assert.deepEqual(codes(`${SKILL}\n- 같은 파일에 독립적인 결함이 둘이면 둘 다 낸다. 개수 상한은 없다`), [])
})

test('리뷰어 프롬프트에 정확성 기준이나 변경 의도가 없으면 버그 관점이 빠진다', () => {
  assert.deepEqual(codes(SKILL.replace('- `{RULES_DIR}/correctness.md` — 의도대로 동작하는가', '')), [FAST_REVIEW_CODES.CORRECTNESS])
  assert.deepEqual(codes(SKILL.replace('{INTENT — Step 2에서 모은 의도와 출처}', '')), [FAST_REVIEW_CODES.CORRECTNESS])
})

test('리포트 골격에 도구 실행 결과가 없으면 돌린 도구의 결과가 사라진다', () => {
  assert.deepEqual(codes(SKILL.replace('## 도구 실행 결과\n\n', '')), [FAST_REVIEW_CODES.TOOL_RESULT])
})

test('지적 0개를 승인으로 읽히게 하는 문구는 실패한다', () => {
  for (const phrase of ['**머지 가능 여부**: 🔴 {N}개 → {가능/불가}', '- (이슈 없는 파일 리스트, 또는 \'전부 통과\' 요약)']) {
    assert.deepEqual(codes(`${SKILL}\n${phrase}`), [FAST_REVIEW_CODES.APPROVAL_OVERCLAIM], phrase)
  }
})

test('리뷰 기준에 범위 줄이 없거나 골격 섹션이 빠지면 실패한다', () => {
  // 범위 줄은 검토 안 함 파일이 지적 없음으로 읽히지 않게 하는 자리다(C-5) — 2.27.0의 fast 템플릿에는 없었다
  assert.deepEqual(codes(SKILL.replace('> **범위**: {`review-scope.mjs`의 `line` 그대로}\n', '')), [FAST_REVIEW_CODES.REPORT_SKELETON])
  for (const heading of ['## 리뷰 기준', '## 판정', '## 상세 지적', '## 미해결 / 후속 확인']) {
    assert.deepEqual(codes(SKILL.replace(`${heading}\n`, '')), [FAST_REVIEW_CODES.REPORT_SKELETON], heading)
  }
})

test('문제가 난 파일의 경로를 붙인다', () => {
  const [problem] = checkFastReview({ skill: SKILL, rules: `${RULES}\n- 파일당 최대 1개` })
  assert.match(problem.message, /^review-rules\/fast\.md: /)
})

test('리뷰어를 띄우는 task 호출을 찾지 못하면 프롬프트 검사를 건너뛰지 않고 실패한다', () => {
  const skill = SKILL.replace('task(', 'dispatch(')
  assert.ok(codes(skill).includes(FAST_REVIEW_CODES.PROMPT_NOT_FOUND))
})
