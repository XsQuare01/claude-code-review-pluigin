import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resultLanguageProblems } from '../scripts/lib/result-language.mjs'

// 지적은 한국어로 쓴다(00-rule). 문장으로만 지키게 두면 프롬프트에서 빠진 날 영어 지적이 리포트에 그대로 실린다 —
// 2026-10-06(02·04·18)과 2026-10-15(13-dx, 07·16)에 그랬다. 결과를 받는 자리에서 본다.
const finding = (title, body, extra = {}) => ({ ruleId: '13-4', title, body, impact: 'low', confidence: 'high', ...extra })

test('제목과 본문에 한글이 하나도 없는 지적·열린 질문을 짚는다', () => {
  const english = { schemaVersion: 1, findings: [finding('The block layout API hides a required flex-parent contract', 'layout="block" promises to center the notice.')], openQuestions: [{ title: 'Is the parent flex?', body: 'Not verified.' }] }
  const problems = resultLanguageProblems(english)
  assert.equal(problems.length, 2)
  assert.match(problems[0], /findings\[0\].*13-4.*한국어/)
  assert.match(problems[1], /openQuestions\[0\].*한국어/)
})

test('코드 식별자가 섞여도 한국어 문장이면 통과하고, 다른 언어를 요청한 실행은 묻지 않는다', () => {
  const korean = { schemaVersion: 1, findings: [finding('`RetryNotice`의 block 레이아웃이 flex 부모를 요구합니다', '`flex-1`은 부모가 flex일 때만 늘어납니다.')], openQuestions: [] }
  assert.deepEqual(resultLanguageProblems(korean), [])
  const english = { schemaVersion: 1, findings: [finding('Title', 'Body')], openQuestions: [] }
  assert.deepEqual(resultLanguageProblems(english, { language: 'en' }), [])
  assert.equal(resultLanguageProblems(english, { language: 'ko' }).length, 1)
  assert.deepEqual(resultLanguageProblems({ schemaVersion: 1, findings: [], openQuestions: [] }), [])
})
