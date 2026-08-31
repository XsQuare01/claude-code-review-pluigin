// claude 프로세스의 종료와 stdout을 다루는 순수 함수들.
//
// fs도 git도 spawn도 쓰지 않는다. 호출자가 관찰한 값만 받아서 셈한다 — 그래야
// 이 규칙들을 실제 프로세스 하나 띄우지 않고 검증할 수 있다.
//
// 신호가 아니라 harness가 직접 kill을 호출했는지로 판단한다. Windows에는 POSIX
// 시그널이 없어서, harness가 타임아웃으로 .kill('SIGKILL')한 프로세스도 close
// 이벤트의 signal이 null로 보고된다 — `signal === 'SIGKILL'`로 분류하면 이
// 저장소가 실제로 돌아가는 플랫폼에서 타임아웃을 절대 못 잡는다.
// killedByTimeout 플래그는 signal보다 항상 나은 정보다: 어느 플랫폼에서도
// harness 자신이 무엇을 했는지는 harness가 직접 안다. signal은 그래서 이
// 함수의 분류에는 쓰이지 않는다 — 호출부가 관찰한 그대로 넘겨도 되게 받아만
// 두는 자리다.
export const classifyExit = ({ killedByTimeout, code, signal }) => {
  if (killedByTimeout) return 'timeout'
  if (code === 0) return true
  return 'failed'
}

/**
 * `claude -p --output-format json`이 stdout에 남기는 결과 봉투를 해석한다.
 *
 * 크래시나 부분 출력이면 stdout이 JSON이 아닐 수 있다. 그 실패를 던지면
 * grading 배치 전체가 한 run의 깨진 stdout 때문에 멈춘다 — 그래서 파싱
 * 실패는 null로 접는다. 봉투는 있는데 `result`가 없는 경우(예: 리뷰가
 * max-turns로 끝난 경우)는 파싱 실패가 아니다 — 봉투 그대로 돌려주고
 * `result`가 undefined인 채로 호출부가 판단하게 둔다.
 */
export const parseEnvelope = stdout => {
  try {
    return JSON.parse(stdout)
  } catch {
    return null
  }
}

/**
 * claude에 넘길 인자 배열을 조립한다.
 *
 * runClaude 안에 인라인으로 두면 검사할 방법이 없다. A1에서 이 배열의
 * --permission-mode 값 하나 때문에 모든 실행에서 Bash가 거부됐고,
 * scriptRan.ran이 구조적으로 false가 됐다 — 그런데 그것을 잡아낸 것은
 * 테스트가 아니라 실행 결과의 permissionDenials였다. 배열을 밖으로 꺼내야
 * 그 종류의 실수를 리뷰 실행 없이 고정할 수 있다.
 *
 * pluginDir이 --add-dir에도 들어가는 이유는 runClaude 쪽 주석에 있다.
 * 스킬이 자기 규칙 모듈을 읽으려면 그 경로가 허용 작업 디렉터리여야 한다.
 */
export const buildClaudeArgs = ({
  command, pluginDir, fixtureRoot, permissionMode, appendSystemPrompt, model, effort,
  outputFormat = 'json',
}) => [
  '-p', command,
  '--plugin-dir', pluginDir,
  '--add-dir', fixtureRoot,
  '--add-dir', pluginDir,
  '--permission-mode', permissionMode,
  '--output-format', outputFormat,
  // stream-json은 -p와 함께 쓸 때 --verbose를 요구한다. 빠뜨리면 claude가
  // 바로 종료하는데, 그 실패는 몇 초 만에 나므로 40분을 태우지는 않는다 —
  // 그래도 붙여둔다. json 형식에는 붙이지 않는다: 이 플래그가 그쪽 stdout에
  // 무엇을 더 얹는지가 봉투 파싱의 전제와 얽히고, 그 전제를 실행 없이
  // 확인할 방법이 없다.
  ...(outputFormat === 'stream-json' ? ['--verbose'] : []),
  // 모델과 effort를 harness가 직접 정한다. A2의 첫 6회는 둘 다 지정하지 않아
  // 세션 기본값을 상속받았고(`opus[1m]`, `xhigh`), 그것은 사용자가 /config에서
  // 모델을 바꾸면 기준선이 조용히 다른 조건의 숫자가 된다는 뜻이다. 값은
  // provenance에 남는다.
  ...(model ? ['--model', model] : []),
  ...(effort ? ['--effort', effort] : []),
  // 빈 문자열이면 붙이지 않는다. 값 없는 플래그는 claude가 다음 인자를 값으로
  // 삼켜 조용히 다른 명령이 된다.
  ...(appendSystemPrompt ? ['--append-system-prompt', appendSystemPrompt] : []),
]

/**
 * fan-out을 켜기 위한 최소 지시.
 *
 * 이 머신에서 뜨는 세션의 시스템 프롬프트에 "Do not call the AgentTool unless
 * the user requested it"이 들어 있어서, harness가 띄운 모든 run이 sub-agent
 * 없이 통합 pass로 돌았다 — /code-review가 모듈 fan-out으로 설계돼 있는데도.
 * 그 조건문의 "unless"를 참으로 만드는 것이 이 문장의 전부다.
 *
 * 커버리지·심각도·철저함을 건드리는 표현을 넣지 않는다. 넣는 순간 harness는
 * 워크플로우가 아니라 자기 프롬프트를 재게 되고, 그것이 fixture 과적합보다
 * 먼저 오는 더 조용한 실패다. 단위 테스트가 이 범위를 강제한다.
 */
export const DISPATCH_REQUEST =
  '이 세션은 code-review eval harness가 실행한 것이다. 사용자는 워크플로우가 정의한 대로 ' +
  'sub-agent dispatch를 수행할 것을 명시적으로 요청했다. 리뷰의 범위·판정 기준·출력 형식은 ' +
  '워크플로우 정의를 그대로 따른다.'

/**
 * 봉투의 subagent_stats를 운영 실패 요약으로 접는다.
 *
 * 왜 세는가: 2.6.0(통합 pass)은 타임아웃 3회로 죽었고, /code-review-full
 * (fan-out)은 타임아웃 4회를 겪고도 완주했다. completed만 보면 둘 다
 * 성공/실패의 이분법으로 뭉개져 그 차이가 사라진다. 워크플로우 형태를
 * 바꾸는 B의 판정에는 "완주했는가"만이 아니라 "몇 번 휘청였는가"가 필요하다.
 *
 * killed와 refused는 하위 키를 가진 객체다({parent,user,system} /
 * {depth_limit,concurrency_limit,budget}). 합산하지 않고 truthy만 보면
 * 실패 횟수가 아니라 "실패 종류가 있었나"를 세게 된다.
 *
 * stats가 없으면 0이 아니라 null을 낸다. "실패가 없었다"와 "측정되지
 * 않았다"는 다른 명제이고, 이 저장소는 그 둘을 섞어서 이미 여러 번 틀렸다.
 */
export const summarizeOpFailures = stats => {
  if (!stats) return null
  const sum = counts => Object.values(counts ?? {}).reduce((total, n) => total + n, 0)
  const killed = sum(stats.killed)
  const refused = sum(stats.refused)
  const failed = stats.failed ?? 0
  return {
    spawned: stats.spawned ?? 0,
    failed,
    killed,
    refused,
    total: failed + killed + refused,
  }
}

/**
 * 재채점이 읽을 리포트를 고른다.
 *
 * `keptReport`에 값이 있다는 것과 그 파일이 아직 있다는 것은 다른 명제다.
 * 값만 보고 건너뛰면 파일이 지워졌을 때 읽기가 던져 **재채점 배치 전체가**
 * 죽는다 — 리포트를 못 찾은 run만 건너뛴다는 의도와 정반대이고, 관례 경로에
 * 손으로 구조한 사본이 있어도 거기까지 가지 못한다.
 *
 * 존재 확인을 주입받는 이유는 이 판정을 파일시스템 없이 고정하기 위해서다.
 * 못 찾았을 때 시도한 경로를 함께 돌려준다 — 사유에 그것이 없으면 건너뛴
 * 줄을 보고도 어디를 봐야 할지 알 수 없다.
 */
export const resolveStoredReport = ({ keptReport, conventional, exists }) => {
  const tried = [keptReport, conventional].filter(Boolean)
  for (const candidate of tried) {
    if (exists(candidate)) return { relative: candidate, tried }
  }
  return { relative: null, tried }
}

/**
 * 리포트를 결과 파일 옆에 보관한다.
 *
 * 경로가 아니라 **본문**을 받는다. 리포트는 파일에서 올 수도 있고(C-7 계약대로
 * 저장한 경우) stdout 봉투에서 건질 수도 있는데, 후자도 정상적으로 채점된다.
 * 경로를 기준으로 보관하면 stdout에서 건진 run은 보관되지 않아 **비용을 치른
 * 성공 run이 재채점 불가**가 된다.
 *
 * 본문을 받으면 보관본이 채점기가 실제로 읽은 것과 같다는 것도 함께 보장된다.
 *
 * 본문이 비었으면 쓰지 않는다. 빈 파일을 남기면 재채점이 그것을 읽어 findings
 * 0건짜리 정상 결과처럼 채점한다.
 */
export const storeReport = ({ text, name, write }) => {
  if (!text) return null
  write(name, text)
  return `reports/${name}`
}

// ---------------------------------------------------------------------------
// 죽은 프로세스에서 진행 상황을 읽는다.
//
// 왜 필요한가: 2026-08-31 render-throughput run은 타임아웃을 **재현하는 데는
// 성공**했지만(completed=timeout, 2400s, reportFound=false) 원인을 가르지
// 못했다. opFailures·numTurns·stopReason이 전부 비어 있었기 때문인데, 그
// 값들은 전부 `--output-format json`이 프로세스 **정상 종료 시에만** 뱉는
// 결과 봉투에서 나온다. harness가 kill한 프로세스는 그 봉투를 쓸 기회가 없다.
//
// 즉 **타임아웃을 재는 데 성공한 순간 진단 정보를 잃는 구조**였고, 그것은
// 돌려보고 알아낸 것이 아니라 이 파일의 parseEnvelope와 classifyExit를 나란히
// 읽었으면 실행 전에 알 수 있는 것이었다. 40분을 쓰고 채점 가능한 결과가 0건
// 나온 뒤에야 봤다.
//
// stream-json은 턴이 끝날 때마다 NDJSON 한 줄을 흘린다. 그 줄들을 파일로
// 받아두면 kill돼도 죽기 직전까지가 남고, case.json에 미리 등록해 둔 판별
// 규칙("producer가 전부 끝났는데 리포트가 없으면 렌더 병목")을 그제서야 실제
// 값으로 적용할 수 있다.
// ---------------------------------------------------------------------------

/**
 * stream-json stdout(NDJSON)을 이벤트 배열로 읽는다.
 *
 * kill된 프로세스의 마지막 줄은 거의 항상 **쓰다 만 JSON**이다. 그것을 파싱
 * 실패로 세면 "형식이 깨졌다"와 "중간에 죽었다"가 같은 숫자로 뭉개진다 —
 * 후자는 정상이고 전자는 파서가 틀렸다는 뜻이라 대응이 정반대다. 그래서
 * 마지막 줄의 실패만 truncated로 따로 센다.
 *
 * 던지지 않는다. 여기서 던지면 배치 전체가 한 run의 깨진 stdout 때문에 멈춘다.
 */
export const parseStreamEvents = text => {
  const lines = String(text ?? '').split('\n')
  const events = []
  let malformed = 0
  let truncated = false
  lines.forEach((line, at) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      if (at === lines.length - 1) truncated = true
      else malformed += 1
    }
  })
  return { events, malformed, truncated }
}

/**
 * 스트림에서 결과 봉투를 건진다.
 *
 * stream-json의 마지막 `type: "result"` 이벤트가 `--output-format json`의
 * 봉투와 같은 자리다. 이것이 있으면 numTurns·subagent_stats·total_cost_usd가
 * 종전과 똑같이 채워진다 — 즉 스트림으로 바꿔도 **완주한 run이 잃는 정보는
 * 없다.**
 *
 * 뒤에서부터 찾는다. 스트림 중간에 result가 또 나오는 경우(재시도 등)에
 * 앞엣것을 잡으면 이미 지난 상태를 최종 결과로 읽게 된다.
 */
export const envelopeFromStream = events => {
  for (let at = events.length - 1; at >= 0; at -= 1) {
    if (events[at]?.type === 'result') return events[at]
  }
  return null
}

// sub-agent를 띄우는 도구. 이 이름의 tool_use 하나가 producer 하나다.
const DISPATCH_TOOL = 'Task'
// 리포트를 실제로 디스크에 쓰는 도구들. 렌더 단계가 시작됐는지의 신호다.
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/**
 * 이벤트에서 진행 상황을 센다.
 *
 * 핵심은 **tool_use와 tool_result의 짝**이다. 짝이 맞지 않고 남은 tool_use가
 * 프로세스가 죽은 순간 기다리고 있던 일이고, 그것이 병목의 위치다.
 *
 * dispatched와 returned를 따로 센다. 합쳐서 "fan-out이 돌았다"로 접으면
 * producer가 다 끝났는지 아직인지가 사라지는데, 그 구분이 이 함수를 만든
 * 이유 전부다.
 */
export const summarizeProgress = events => {
  const pending = new Map()
  let assistantTurns = 0
  let dispatched = 0
  let returned = 0
  let writesStarted = 0
  let writesFinished = 0
  let lastType = null

  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    lastType = event.type ?? lastType
    if (event.type === 'assistant') assistantTurns += 1
    const content = event.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'tool_use') {
        pending.set(block.id, {
          name: block.name,
          // 무엇을 하다 멈췄는지. 경로가 없는 도구(Task 등)는 description을
          // 대신 남긴다 — 둘 다 없으면 도구 이름만으로는 어느 모듈이었는지
          // 알 수 없다.
          target: block.input?.file_path ?? block.input?.description ?? null,
        })
        if (block.name === DISPATCH_TOOL) dispatched += 1
        if (WRITE_TOOLS.has(block.name)) writesStarted += 1
      }
      if (block?.type === 'tool_result') {
        const started = pending.get(block.tool_use_id)
        if (!started) continue
        pending.delete(block.tool_use_id)
        if (started.name === DISPATCH_TOOL) returned += 1
        if (WRITE_TOOLS.has(started.name)) writesFinished += 1
      }
    }
  }

  return {
    events: events.length,
    assistantTurns,
    dispatched,
    returned,
    // "producer가 전부 끝났다"는 dispatched > 0일 때만 참일 수 있다. 0/0을
    // 참으로 접으면 fan-out이 아예 없었던 run이 "producer 완료"로 보인다.
    producersDone: dispatched > 0 && returned === dispatched,
    writesStarted,
    writesFinished,
    // 죽는 순간 기다리고 있던 일들. 병목의 위치가 여기 그대로 있다.
    pending: [...pending.values()],
    lastType,
  }
}

/**
 * case.json에 미리 등록해 둔 판별 규칙을 값에 적용한다.
 *
 *   producer가 전부 끝났는데 리포트가 없으면 병목은 렌더 단계다.
 *   producer 쪽에서 멈췄으면 병목은 fan-out이고 렌더러 처방은 헛다리다.
 *
 * 사후 해석을 막으려고 실행 **전에** 적어둔 문장이고, 이 함수는 그것을 손으로
 * 읽지 않아도 되게 옮긴 것뿐이다. 규칙을 여기서 바꾸면 사전 등록의 의미가
 * 없어진다.
 *
 * 근거가 없으면 판정하지 않는다. dispatch가 한 번도 없었던 run은 두 가설 중
 * 어느 쪽도 지지하지 않는다 — 그것을 'render'로 접으면 fan-out이 재현되지
 * 않은 run을 렌더 병목의 증거로 쓰게 된다. 완주한 run에는 아예 적용하지
 * 않는다(호출부가 completed !== true일 때만 부른다).
 */
export const diagnoseStall = progress => {
  if (!progress || progress.events === 0) {
    return { verdict: 'unknown', why: '스트림이 비었다 — stream 캡처가 꺼져 있었거나 프로세스가 첫 턴 전에 죽었다' }
  }
  if (progress.dispatched === 0) {
    return { verdict: 'unknown', why: `Task dispatch가 0회다(assistant 턴 ${progress.assistantTurns}) — fan-out이 재현되지 않은 run이라 렌더/fan-out을 가를 근거가 없다` }
  }
  if (progress.returned < progress.dispatched) {
    return { verdict: 'fanout', why: `producer ${progress.dispatched}개 중 ${progress.returned}개만 돌아왔다 — 병목은 fan-out이고 렌더러 처방은 헛다리다` }
  }
  if (progress.writesFinished > 0) {
    return { verdict: 'unknown', why: `producer도 쓰기(${progress.writesFinished}건)도 끝났는데 리포트가 없다 — 렌더 지연이 아니라 저장 경로/계약 쪽 문제다` }
  }
  return {
    verdict: 'render',
    why: `producer ${progress.dispatched}개가 전부 돌아왔는데 리포트 쓰기가 ${progress.writesStarted > 0 ? '시작만 되고 끝나지 않았다' : '시작조차 되지 않았다'} — 병목은 렌더 단계다`,
  }
}
