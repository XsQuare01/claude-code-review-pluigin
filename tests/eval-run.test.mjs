import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DISPATCH_REQUEST, buildClaudeArgs, classifyExit, parseEnvelope, summarizeOpFailures } from '../scripts/lib/eval-run.mjs'

// Windows에는 POSIX 시그널이 없어서, harness가 .kill('SIGKILL')로 죽인 프로세스도
// close 이벤트의 signal이 null로 온다. killedByTimeout 플래그가 아니라 signal로
// 분류하면 이 저장소가 실제로 돌아가는 플랫폼에서 타임아웃을 절대 못 잡는다 — 이
// 네 테스트는 그 버그를 재현하고 고정한다.

test('harness가 타임아웃으로 kill했으면 signal이 무엇이든 timeout으로 분류한다', () => {
  // Windows 재현: SIGKILL로 죽여도 close 이벤트는 signal: null, code: 1로 온다.
  assert.equal(classifyExit({ killedByTimeout: true, code: 1, signal: null }), 'timeout')
})

test('정상 종료(exit 0)는 true로 분류한다', () => {
  assert.equal(classifyExit({ killedByTimeout: false, code: 0, signal: null }), true)
})

test('타임아웃이 아닌 비정상 종료(exit != 0)는 failed로 분류한다', () => {
  assert.equal(classifyExit({ killedByTimeout: false, code: 1, signal: null }), 'failed')
})

test('harness가 kill하지 않았다면 SIGKILL 신호만으로는 timeout으로 보지 않는다', () => {
  // signal을 신뢰하지 않는다는 것을 반대 방향에서도 고정한다: 외부에서 온
  // SIGKILL은 killedByTimeout이 없으면 timeout이 아니라 failed다.
  assert.equal(classifyExit({ killedByTimeout: false, code: null, signal: 'SIGKILL' }), 'failed')
})

// claude -p --output-format json이 stdout에 남기는 결과 봉투를 파싱한다. 크래시나
// 부분 출력이면 stdout이 JSON이 아닐 수 있다 — 그 경우 예외를 던지는 대신 null로
// 접어야, grading 배치 전체가 파싱 실패 하나로 멈추지 않는다.

test('유효한 JSON 봉투는 그대로 파싱된다', () => {
  const raw = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '## 리뷰 기준\n...' })
  const envelope = parseEnvelope(raw)
  assert.equal(envelope.type, 'result')
  assert.equal(envelope.result, '## 리뷰 기준\n...')
})

test('JSON이 아닌 stdout은 던지지 않고 null로 접힌다', () => {
  assert.equal(parseEnvelope('claude: command not found\n(and a stack trace below)'), null)
})

test('result가 없는 JSON도 파싱은 되고 result만 undefined다', () => {
  const raw = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true })
  const envelope = parseEnvelope(raw)
  assert.equal(envelope.is_error, true)
  assert.equal(envelope.result, undefined)
})

// claude에 넘기는 인자 배열. A1에서 --permission-mode acceptEdits가 Bash를
// 거부해 두 팔 모두 scriptRan.ran이 구조적으로 false가 됐고, 그것을 잡은 것은
// 테스트가 아니라 실행 결과였다. 배열을 순수 함수로 꺼낸 이유가 이것이다.

test('buildClaudeArgs는 Bash를 거부하는 acceptEdits를 쓰지 않는다', () => {
  const args = buildClaudeArgs({
    command: '/x', pluginDir: 'p', fixtureRoot: 'f', permissionMode: 'bypassPermissions',
  })
  assert.ok(!args.includes('acceptEdits'))
  assert.ok(args.includes('bypassPermissions'))
})

test('buildClaudeArgs는 fixture와 pluginDir을 둘 다 허용 디렉터리로 넣는다', () => {
  // pluginDir이 빠지면 스킬이 자기 규칙 모듈을 읽지 못하고, 리뷰가 조용히
  // "규칙 미확인" 판단으로 줄어든다 — A1 첫 실행이 실제로 그랬다.
  const args = buildClaudeArgs({
    command: '/x', pluginDir: 'p', fixtureRoot: 'f', permissionMode: 'bypassPermissions',
  })
  const dirs = args.filter((value, at) => args[at - 1] === '--add-dir')
  assert.deepEqual(dirs.sort(), ['f', 'p'])
  assert.equal(args[args.indexOf('--plugin-dir') + 1], 'p')
})

test('buildClaudeArgs는 -p 뒤에 명령을 그대로 넘긴다', () => {
  const args = buildClaudeArgs({
    command: '/react-code-review-plugin:code-review', pluginDir: 'p', fixtureRoot: 'f', permissionMode: 'auto',
  })
  assert.equal(args[args.indexOf('-p') + 1], '/react-code-review-plugin:code-review')
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'auto')
})

// 운영 실패 요약. 2.6.0은 타임아웃 3회로 죽었고 /code-review-full은 타임아웃
// 4회를 겪고도 완주했다 — completed만 세면 그 차이가 사라진다.

test('subagent_stats가 없으면 0이 아니라 null이다', () => {
  // "실패가 없었다"와 "측정되지 않았다"는 다른 명제다. 0으로 접으면 sub-agent가
  // 아예 뜨지 않은 run이 무사고 run으로 읽힌다.
  assert.equal(summarizeOpFailures(undefined), null)
  assert.equal(summarizeOpFailures(null), null)
})

test('전부 0인 봉투는 total 0을 낸다', () => {
  const summary = summarizeOpFailures({
    spawned: 4, completed: 4, failed: 0,
    killed: { parent: 0, user: 0, system: 0 },
    refused: { depth_limit: 0, concurrency_limit: 0, budget: 0 },
  })
  assert.deepEqual(summary, { spawned: 4, failed: 0, killed: 0, refused: 0, total: 0 })
})

test('killed와 refused는 하위 키를 합산한다', () => {
  // truthy 검사로 접으면 "몇 번 죽었나"가 아니라 "죽은 종류가 있나"를 세게 된다.
  const summary = summarizeOpFailures({
    spawned: 9, completed: 5, failed: 2,
    killed: { parent: 1, user: 0, system: 3 },
    refused: { depth_limit: 2, concurrency_limit: 1, budget: 0 },
  })
  assert.equal(summary.killed, 4)
  assert.equal(summary.refused, 3)
  assert.equal(summary.total, 9)
})

test('하위 키가 빠져 있어도 던지지 않는다', () => {
  const summary = summarizeOpFailures({ spawned: 1 })
  assert.deepEqual(summary, { spawned: 1, failed: 0, killed: 0, refused: 0, total: 0 })
})

// 실행 shape. /code-review는 모듈 fan-out으로 설계돼 있지만, 이 머신의 세션
// 시스템 프롬프트에 "Do not call the AgentTool unless the user requested it"이
// 있어서 harness가 띄우는 모든 run이 sub-agent 없이 통합 pass로 돈다.
// 그래서 무엇을 기준선으로 삼는지가 선택이 되고, 그 선택은 결과에 남아야 한다.

test('appendSystemPrompt를 주지 않으면 --append-system-prompt가 붙지 않는다', () => {
  const args = buildClaudeArgs({
    command: '/x', pluginDir: 'p', fixtureRoot: 'f', permissionMode: 'bypassPermissions',
  })
  assert.ok(!args.includes('--append-system-prompt'))
})

test('appendSystemPrompt를 주면 값과 함께 붙는다', () => {
  const args = buildClaudeArgs({
    command: '/x', pluginDir: 'p', fixtureRoot: 'f', permissionMode: 'bypassPermissions',
    appendSystemPrompt: 'dispatch를 요청한다',
  })
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], 'dispatch를 요청한다')
})

test('빈 문자열은 플래그를 붙이지 않는다', () => {
  // 빈 값을 넘기면 claude가 다음 인자를 값으로 삼켜 조용히 틀린 명령이 된다.
  const args = buildClaudeArgs({
    command: '/x', pluginDir: 'p', fixtureRoot: 'f', permissionMode: 'bypassPermissions',
    appendSystemPrompt: '',
  })
  assert.ok(!args.includes('--append-system-prompt'))
})

test('DISPATCH_REQUEST는 dispatch만 요청하고 리뷰 내용은 건드리지 않는다', () => {
  // 이 문장이 커버리지나 판정 기준을 건드리면 harness가 워크플로우가 아니라
  // 자기 프롬프트를 재게 된다. 지시 범위를 테스트로 못박는다.
  assert.match(DISPATCH_REQUEST, /sub-agent|dispatch/)
  for (const forbidden of ['철저', '자세', '모두 찾', '빠짐없이', '심각도', '더 많']) {
    assert.ok(!DISPATCH_REQUEST.includes(forbidden),
      `DISPATCH_REQUEST가 리뷰 품질을 유도하는 표현을 담고 있다: ${forbidden}`)
  }
})
