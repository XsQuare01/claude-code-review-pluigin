import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  WRITE_TOOLS,
  checkProducerWriteAccess,
  dispatchSignals,
  extractDispatchTargets,
  extractTaskCalls,
  parseAgentTools,
} from '../scripts/lib/producer-tools.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

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

// ── dispatch 자리: 기본값은 거부 (#69) ─────────────────────────────────────
//
// 처음 이 검사는 `subagent_type=` 표기 하나만 찾았고, 여섯 워크플로우가
// `task(category="unspecified-high", ...)`로 producer를 띄우는 동안 문제 0건을 냈다.
// 아래는 표기가 아니라 "dispatch가 있는데 제한된 에이전트를 지목했는가"를 고정한다.

const block = (...params) => `\`\`\`\ntask(\n${params.map(p => `  ${p},`).join('\n')}\n  prompt="리뷰하세요"\n)\n\`\`\``

test('category만 준 task( 호출은 실패한다', () => {
  const problems = check(block('category="unspecified-high"', 'load_skills=[]', 'run_in_background=false'))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /dispatches a producer without naming a restricted agent/)
  assert.match(problems[0], /category="unspecified-high"/)
  assert.match(problems[0], /default deny/)
  // 어느 호출인지 줄 번호로 짚는다 — 스킬 하나에 호출이 여럿일 수 있다.
  assert.match(problems[0], /skills\/x\/SKILL\.md:2:/)
})

test('제한된 에이전트를 지목한 task( 호출은 통과한다', () => {
  // 따옴표로 감싼 지목도 읽는다. 못 읽으면 고친 스킬이 고치기 전과 같은 이유로 실패한다.
  assert.deepEqual(check(block('subagent_type="react-code-review-plugin:rule-module-reviewer"', 'load_skills=[]')), [])
  assert.deepEqual(check(block("subagent_type='rule-module-reviewer'")), [])
  assert.deepEqual(check(block('subagent_type=`rule-module-reviewer`')), [])
})

test('task( 호출이 general을 지목하면 실패한다', () => {
  const problems = check(block('subagent_type="general"', 'run_in_background=true'))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /general agent/)
})

test('호출 블록 없이 run_in_background만 있고 지목이 없으면 실패한다', () => {
  // 산문으로 dispatch를 지시하면서 누구를 띄우는지 말하지 않는 형태다.
  const problems = check('모듈마다 `run_in_background=true`로 띄운다.')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /names no agent this check can read/)
  assert.match(problems[0], /run_in_background/)
})

test('dispatch 정황이 전혀 없으면 문제도 없다', () => {
  // 띄우지 않는 스킬(버전 확인 같은)까지 실패시키면 검사가 시끄러워져 곧 꺼진다.
  assert.deepEqual(dispatchSignals('git diff를 확인하고 리포트를 쓴다.'), [])
  assert.deepEqual(check('git diff를 확인하고 리포트를 쓴다.'), [])
})

test('두 task( 호출 중 지목이 없는 쪽만 짚는다', () => {
  const text = [
    block('subagent_type="react-code-review-plugin:rule-module-reviewer"'),
    '',
    '실패하면 아래로 다시 띄운다.',
    '',
    block('category="unspecified-high"'),
  ].join('\n')
  const problems = check(text)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /without naming a restricted agent/)
  // 지목한 첫 호출(2행)이 아니라 둘째 호출을 짚는다.
  assert.match(problems[0], /SKILL\.md:11:/)
})

test('prompt 본문 속 subagent_type은 그 호출의 지목으로 세지 않는다', () => {
  // prompt는 producer에게 주는 산문이다. 본문에 이름이 나온다고 그 에이전트로 띄우는 것이 아니다.
  const text = '```\ntask(\n  category="unspecified-high",\n  prompt="subagent_type=rule-module-reviewer 처럼 쓰지 마세요 (예시)"\n)\n```'
  const [call] = extractTaskCalls(text)
  assert.deepEqual(call.targets, [])
  assert.equal(call.category, 'unspecified-high')
  assert.match(check(text)[0], /without naming a restricted agent/)
})

test('지목 자리를 읽지 못하면 통과가 아니라 실패다', () => {
  // `subagent_type` 단어는 있는데 값이 템플릿 자리라 읽을 수 없는 경우.
  const problems = check(block('subagent_type={AGENT}'))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /cannot read/)
})

test('산문 속 지목은 여전히 target으로 센다', () => {
  // `/code-review-full`은 호출 블록 없이 이 문장으로 dispatch를 지시한다.
  const prose = '**아래 producer는 전부 `subagent_type=react-code-review-plugin:rule-module-reviewer`로 띄운다.**'
  assert.deepEqual(extractDispatchTargets(prose), ['rule-module-reviewer'])
  assert.deepEqual(check(`${prose}\n모듈마다 \`run_in_background=true\`로 실행한다.`), [])
})

// ── 저장소의 실제 스킬 ─────────────────────────────────────────────────────

test('dispatch하는 모든 SKILL.md가 제한된 에이전트를 지목하고 문제가 0건이다', () => {
  // validate-rules가 같은 판정을 돌리지만, 거기서는 "몇 개의 스킬이 실제로 검사됐는지"가
  // 보이지 않는다. 처음 검사가 바로 그 자리에서 0개를 검사하고 초록불을 켰다.
  const agentsDir = join(ROOT, 'agents')
  const agents = new Map(readdirSync(agentsDir).filter(file => file.endsWith('.md')).map(file => {
    const front = readFileSync(join(agentsDir, file), 'utf8').split('---')[1] ?? ''
    return [front.match(/^\s*name:\s*(\S+)/m)?.[1] ?? file.replace(/\.md$/, ''), parseAgentTools(front)]
  }))
  const skillsDir = join(ROOT, 'skills')
  const dispatching = []
  for (const dir of readdirSync(skillsDir)) {
    const path = join(skillsDir, dir, 'SKILL.md')
    if (!existsSync(path)) continue
    const text = readFileSync(path, 'utf8')
    if (!/\btask\s*\(|\bsubagent_type\b/.test(text)) continue
    dispatching.push(dir)
    const where = `skills/${dir}/SKILL.md`
    assert.ok(extractDispatchTargets(text).length > 0, `${where} dispatches but names no agent`)
    assert.deepEqual(checkProducerWriteAccess({ where, text, agents }), [], `${where} has producer problems`)
  }
  // 일곱 워크플로우가 모두 producer를 띄운다. 하나라도 빠지면 그 스킬은 검사받지 않은 것이다.
  for (const expected of ['code-review', 'code-review-commit', 'code-review-exception', 'code-review-fast', 'code-review-full', 'code-review-math', 'code-review-props']) {
    assert.ok(dispatching.includes(expected), `skills/${expected}/SKILL.md was not checked as a dispatching skill`)
  }
})
