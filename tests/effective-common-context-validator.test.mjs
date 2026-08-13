import test from 'node:test'
import assert from 'node:assert/strict'

import {
  validateEffectiveCommonContext,
  EFFECTIVE_COMMON_CONTEXT_CODES,
} from '../scripts/lib/effective-common-context-validator.mjs'

const VALID_BASELINE = [
  '## 00-6. 문서/리포트 표현 규칙 🟡',
  '',
  '- 리뷰 결과, 코멘트, 최종 리포트는 사용자가 다른 언어를 명시하지 않는 한 **한국어로 작성**한다',
  '',
  '<!-- EFFECTIVE_COMMON_CONTEXT_POLICY:BEGIN -->',
  '```json',
  '{',
  '  "representationOwner": "workflow-contract.md",',
  '  "structuredProducerUnverifiedLocation": "location.kind=unverified",',
  '  "structuredProducerReasonField": "reason",',
  '  "publicLiteralForbiddenInPolicyBearingCommonInstructionContext": "위치 미확인",',
  '  "publicLiteralAllowBlock": "PUBLIC_OUTPUT_LOCATION_LITERAL_ALLOW"',
  '}',
  '```',
  '<!-- EFFECTIVE_COMMON_CONTEXT_POLICY:END -->',
  '',
  '<!-- PUBLIC_OUTPUT_LOCATION_LITERAL_ALLOW:BEGIN -->',
  '| **번역하지 않는다** | 규칙 ID(`03-1`, `CR-2`), 파일 경로, 코드 인용, Severity 표기, 두 축 표기(`영향`·`확신`과 그 값 `높음`·`낮음`), 상태 토큰(`SKIPPED`, `UNKNOWN`, `위치 미확인`, `확인 필요`, `버전 미확인`) |',
  '<!-- PUBLIC_OUTPUT_LOCATION_LITERAL_ALLOW:END -->',
  '',
  '## 00-10. 위치 표기 🔴',
  '',
  '- 절대 경로/줄번호/인용을 추측하지 않는다',
  '- 표현 형식과 lifecycle 정본은 workflow-contract.md가 소유한다',
].join('\n')

test('passes when machine markers are present and the only public literal sits inside the explicit allow block', () => {
  const result = validateEffectiveCommonContext(VALID_BASELINE, 'review-rules/00-rule.md')
  assert.deepEqual(result, [])
})

test('fails with a stable code when a contradictory positive 위치 미확인 literal appears outside the allow block', () => {
  const result = validateEffectiveCommonContext(
    `${VALID_BASELINE}\n- structured producer도 위치 미확인 을 바로 출력한다`,
    'review-rules/00-rule.md',
  )

  assert.equal(result.length, 1)
  assert.equal(result[0].code, EFFECTIVE_COMMON_CONTEXT_CODES.PUBLIC_LITERAL_OUTSIDE_ALLOW_BLOCK)
})

test('fails when contradictory prose is hidden inside the public literal allow block', () => {
  const text = VALID_BASELINE.replace(
    '<!-- PUBLIC_OUTPUT_LOCATION_LITERAL_ALLOW:END -->',
    '- structured producer도 위치 미확인 을 바로 출력한다\n<!-- PUBLIC_OUTPUT_LOCATION_LITERAL_ALLOW:END -->',
  )
  const result = validateEffectiveCommonContext(text, 'review-rules/00-rule.md')

  assert.equal(result.length, 1)
  assert.equal(result[0].code, EFFECTIVE_COMMON_CONTEXT_CODES.ALLOW_BLOCK_SHAPE)
  assert.match(result[0].message, /expected:/)
  assert.match(result[0].message, /actual:/)
  assert.match(result[0].message, /structured producer도 위치 미확인 을 바로 출력한다/)
})

test('passes when human prose is paraphrased or reformatted but the machine markers stay intact', () => {
  const paraphrased = VALID_BASELINE
    .replace('리뷰 결과, 코멘트, 최종 리포트는 사용자가 다른 언어를 명시하지 않는 한 **한국어로 작성**한다', '사용자 요청이 없으면 결과 문서는 한국어를 기본으로 유지한다')
    .replace('절대 경로/줄번호/인용을 추측하지 않는다', '경로, 줄 번호, 인용은 확인된 사실만 적는다')

  const result = validateEffectiveCommonContext(paraphrased, 'review-rules/00-rule.md')
  assert.deepEqual(result, [])
})

test('fails when machine markers are missing, malformed, or duplicated', async t => {
  await t.test('missing policy block fails', () => {
    const text = VALID_BASELINE.replace(/<!-- EFFECTIVE_COMMON_CONTEXT_POLICY:BEGIN -->[\s\S]*<!-- EFFECTIVE_COMMON_CONTEXT_POLICY:END -->\n\n/, '')
    const result = validateEffectiveCommonContext(text, 'review-rules/00-rule.md')
    assert.equal(result[0].code, EFFECTIVE_COMMON_CONTEXT_CODES.POLICY_BLOCK_COUNT)
  })

  await t.test('malformed json policy fails', () => {
    const text = VALID_BASELINE.replace('"representationOwner": "workflow-contract.md",', '"representationOwner": ')
    const result = validateEffectiveCommonContext(text, 'review-rules/00-rule.md')
    assert.equal(result[0].code, EFFECTIVE_COMMON_CONTEXT_CODES.POLICY_JSON)
  })

  await t.test('duplicate allow block fails', () => {
    const duplicateBlock = String.raw`
<!-- PUBLIC_OUTPUT_LOCATION_LITERAL_ALLOW:BEGIN -->
위치 미확인
<!-- PUBLIC_OUTPUT_LOCATION_LITERAL_ALLOW:END -->`
    const result = validateEffectiveCommonContext(`${VALID_BASELINE}\n${duplicateBlock}`, 'review-rules/00-rule.md')
    assert.equal(result[0].code, EFFECTIVE_COMMON_CONTEXT_CODES.ALLOW_BLOCK_COUNT)
  })
})
