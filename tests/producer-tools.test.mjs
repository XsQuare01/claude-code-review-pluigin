import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  WRITE_TOOLS,
  checkProducerWriteAccess,
  extractDispatchTargets,
  parseAgentTools,
} from '../scripts/lib/producer-tools.mjs'

// producer가 파일을 쓸 수 있는지 판정하는 규칙을 고정한다.
//
// 왜 있는가: 리뷰를 만능 에이전트에 맡겼고, 프롬프트에 "읽기 전용, 수정 금지"를
// 명시했는데도 리뷰 에이전트가 사용자 코드를 고쳤다. 문서 어디에도 거짓말은
// 없었다 — **지시와 권한이 따로 놀았을 뿐이다.** C-6는 그래서 read-only를
// 프롬프트가 아니라 도구로 강제하라고 요구하고, 이 검사가 그 요구를 지킨다.

const READ_ONLY = new Map([['rule-module-reviewer', ['Read', 'Grep', 'Glob']]])

const check = (text, agents = READ_ONLY) =>
  checkProducerWriteAccess({ where: 'skills/x/SKILL.md', text, agents })

// ── dispatch 대상 추출 ─────────────────────────────────────────────────────

test('네임스페이스를 벗기고 에이전트 이름만 남긴다', () => {
  // 호스트마다 접두사가 다르다. 검사하려는 것은 접두사가 아니라 어느 에이전트인가다.
  assert.deepEqual(
    extractDispatchTargets('`subagent_type=react-code-review-plugin:rule-module-reviewer`로 실행한다'),
    ['rule-module-reviewer'],
  )
})

test('=와 : 표기를 둘 다 읽는다', () => {
  assert.deepEqual(extractDispatchTargets('subagent_type: general'), ['general'])
  assert.deepEqual(extractDispatchTargets('subagent_type=general'), ['general'])
})

test('dispatch 표기가 아닌 general 언급은 잡지 않는다', () => {
  // 스킬 본문에는 "단일 general review가 아니다"처럼 무해한 general이 있다.
  // 그것까지 잡으면 검사가 시끄러워져 곧 꺼진다.
  assert.deepEqual(extractDispatchTargets('일반 패스는 단일 general review가 아니다'), [])
  assert.deepEqual(check('`general`로 띄우지 않는다'), [])
})

// ── tools 선언 읽기 ────────────────────────────────────────────────────────

test('tools 선언이 없으면 빈 배열이 아니라 null이다', () => {
  // 도구를 선언하지 않은 에이전트는 아무것도 못 쓰는 게 아니라 **전부
  // 물려받는다.** 둘을 같은 값으로 접으면 가장 위험한 에이전트가 가장
  // 안전해 보인다.
  assert.equal(parseAgentTools('name: x\ndescription: y\n'), null)
  assert.deepEqual(parseAgentTools('tools: Read, Grep, Glob\n'), ['Read', 'Grep', 'Glob'])
})

// ── 판정 ───────────────────────────────────────────────────────────────────

test('읽기 전용 producer는 통과한다', () => {
  assert.deepEqual(check('subagent_type=rule-module-reviewer'), [])
})

test('general로 띄우면 잡는다', () => {
  // 이 저장소에서 실제로 사고가 난 상태다.
  const problems = check('subagent_type=general')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /general agent/)
})

test('셸을 가진 producer도 쓰기 가능으로 본다', () => {
  // Edit/Write만 빼는 것은 절반짜리다 — `sed -i`와 리다이렉션이 남는다.
  const problems = check('subagent_type=shelly', new Map([['shelly', ['Read', 'Bash']]]))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /Bash/)
})

test('Edit이나 Write를 가진 producer를 잡는다', () => {
  const problems = check('subagent_type=writer', new Map([['writer', ['Read', 'Edit', 'Write']]]))
  assert.match(problems[0], /Edit, Write/)
})

test('tools를 선언하지 않은 에이전트를 잡는다', () => {
  const problems = check('subagent_type=unbounded', new Map([['unbounded', null]]))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /inherits every tool/)
})

test('정의되지 않은 에이전트로 띄우면 조용히 넘어가지 않는다', () => {
  // 오타 하나로 검사가 통째로 비활성화되면 안 된다.
  const problems = check('subagent_type=rule-module-reviewr')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /not defined in agents/)
})

test('한 스킬에 여러 dispatch가 있으면 각각 판정한다', () => {
  const problems = check(
    'subagent_type=rule-module-reviewer 로 띄우고, 실패하면 subagent_type=general 로 재시도한다',
  )
  assert.equal(problems.length, 1)
  assert.match(problems[0], /general/)
})

test('셸은 쓰기 도구 목록에 있다', () => {
  for (const tool of ['Bash', 'PowerShell', 'Edit', 'Write']) {
    assert.ok(WRITE_TOOLS.has(tool), `${tool}이 쓰기 도구로 등록돼 있지 않다`)
  }
  for (const tool of ['Read', 'Grep', 'Glob']) {
    assert.ok(!WRITE_TOOLS.has(tool), `${tool}은 쓰기 도구가 아니다`)
  }
})
