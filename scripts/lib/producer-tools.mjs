// producer가 파일을 쓸 수 있는지 판정하는 순수 함수들.
//
// fs도 spawn도 쓰지 않는다. 호출자가 읽어온 텍스트만 받아서 판정한다 — 그래야
// 이 규칙을 저장소 트리를 흉내 내지 않고 검증할 수 있다.
//
// 왜 있는가: C-6는 read-only를 **프롬프트가 아니라 도구로** 강제하라고 요구한다.
// 그 요구가 지켜지는지는 두 파일을 나란히 봐야만 알 수 있다 — 스킬이 어느
// 에이전트로 띄우는지, 그 에이전트가 어떤 도구를 갖는지. 실제로 이 저장소는
// 프롬프트에 "수정 금지"를 적어둔 채 만능 에이전트로 producer를 띄웠고, 리뷰
// 에이전트가 사용자 코드를 고쳤다. 그때도 문서 어디에도 거짓말은 없었다 —
// 지시와 권한이 따로 놀았을 뿐이다.
//
// **기본값은 거부다(#69).** 처음 이 검사는 `subagent_type=` 표기 하나만 찾았고,
// 여섯 워크플로우가 `task(category="unspecified-high", ...)`로 producer를 띄우는
// 동안 `{"targets":[],"problems":[]}`를 내며 초록불을 켰다. 못 잡는 것보다 나쁜 것은
// 잡았다고 말하는 것이다. 그래서 표기가 아니라 **dispatch가 있는가**에서 출발한다 —
// dispatch 정황이 있는데 제한된 에이전트를 지목한 자리를 읽지 못하면, "표기를 못
// 읽었다"가 아니라 "제한 선언이 없다"로 실패한다. 검사가 모르는 형식은 통과가 아니다.

// 셸은 쓰기 도구다. `sed -i`와 리다이렉션이 있으므로 Edit/Write만 빼는 것은
// 절반짜리이고, 그 절반이 정확히 사고가 통과한 틈이다.
export const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell'])

// 에이전트 지목. 따옴표·백틱으로 감싼 값도 읽는다 — `subagent_type="x"`를 못 읽어
// 지목이 없는 것으로 세면, 고친 스킬이 고치기 전과 같은 이유로 실패한다.
const TARGET = /subagent_type\s*[=:]\s*[`"']?([\w:-]+)/g

// sub-agent를 띄운다는 정황. 하나라도 있으면 그 스킬은 producer를 띄우는 스킬이다.
const DISPATCH_SIGNALS = [
  { name: 'task(', pattern: /\btask\s*\(/ },
  { name: 'run_in_background', pattern: /\brun_in_background\b/ },
  { name: 'subagent_type', pattern: /\bsubagent_type\b/ },
]

const stripNamespace = raw => (raw.includes(':') ? raw.slice(raw.lastIndexOf(':') + 1) : raw)

/**
 * 스킬 문서에서 sub-agent dispatch 대상을 뽑는다.
 *
 * 네임스페이스(`plugin:agent`)는 벗겨서 에이전트 이름만 남긴다. 호스트마다
 * 접두사가 다르고, 검사하려는 것은 접두사가 아니라 **어느 에이전트인가**다.
 *
 * 산문 속 지목(`subagent_type=…로 띄운다`)도 센다. `/code-review-full`은 호출
 * 블록 없이 산문으로 dispatch를 지시한다.
 */
export const extractDispatchTargets = text => [
  ...new Set([...String(text ?? '').matchAll(TARGET)].map(match => stripNamespace(match[1]))),
]

/** 텍스트에 보이는 dispatch 정황의 이름들. 없으면 빈 배열이다. */
export const dispatchSignals = text => {
  const source = String(text ?? '')
  return DISPATCH_SIGNALS.filter(signal => signal.pattern.test(source)).map(signal => signal.name)
}

// 여는 괄호 바로 뒤에서 시작해 짝이 맞는 닫는 괄호의 위치를 낸다. 못 찾으면 -1.
const closingParen = (source, from) => {
  let depth = 1
  for (let at = from; at < source.length; at += 1) {
    if (source[at] === '(') depth += 1
    else if (source[at] === ')') {
      depth -= 1
      if (depth === 0) return at
    }
  }
  return -1
}

/**
 * `task(` 호출마다 **인자 부분**을 잘라 낸다.
 *
 * 범위는 `task(`부터 그 호출의 `prompt=`(또는 `prompt:`)까지, prompt가 없으면 짝이 맞는
 * 닫는 괄호까지다. 다음 `task(`를 넘지 않는다. prompt 본문을 빼는 이유: 본문은
 * producer에게 주는 산문이라 그 안의 `subagent_type` 언급은 이 호출이 누구를 띄우는지가
 * 아니다. 그래서 지목은 prompt **앞에** 둬야 읽힌다 — 뒤에 두면 지목이 없는 것으로 센다.
 */
export const extractTaskCalls = text => {
  const source = String(text ?? '')
  const starts = [...source.matchAll(/\btask\s*\(/g)].map(match => ({ at: match.index, open: match.index + match[0].length }))
  return starts.map(({ at, open }, index) => {
    const limits = [source.length]
    const next = starts[index + 1]
    if (next) limits.push(next.at)
    const close = closingParen(source, open)
    if (close !== -1) limits.push(close)
    const prompt = /\bprompt\s*[=:]/g
    prompt.lastIndex = open
    const promptAt = prompt.exec(source)
    if (promptAt) limits.push(promptAt.index)
    const args = source.slice(open, Math.min(...limits))
    return {
      line: source.slice(0, at).split('\n').length,
      args,
      targets: extractDispatchTargets(args),
      category: args.match(/\bcategory\s*[=:]\s*[`"']?([\w:-]+)/)?.[1] ?? null,
    }
  })
}

/**
 * 에이전트 frontmatter의 `tools:` 선언을 읽는다.
 *
 * 선언이 없으면 **null**을 낸다. 빈 배열이 아니다 — 도구를 선언하지 않은
 * 에이전트는 아무것도 못 쓰는 것이 아니라 **전부 물려받는다.** 이 둘을 같은
 * 값으로 접으면 가장 위험한 에이전트가 가장 안전해 보인다.
 */
export const parseAgentTools = frontmatter => {
  const line = String(frontmatter ?? '').match(/^\s*tools:\s*(.+)$/m)
  if (!line) return null
  return line[1].split(',').map(tool => tool.trim()).filter(Boolean)
}

// 호출 자리마다: 지목이 있는가, 읽을 수 있는가. 지목된 에이전트가 무엇을 가졌는지는
// 아래 대상별 판정이 본다.
const checkTaskCalls = (where, text) => {
  const problems = []
  for (const call of extractTaskCalls(text)) {
    if (call.targets.length > 0) continue
    const at = `${where}:${call.line}`
    if (/\bsubagent_type\b/.test(call.args)) {
      problems.push(`${at}: task( names its agent in a form this check cannot read — C-6, default deny: write subagent_type="<agent>" before prompt=`)
      continue
    }
    const via = call.category ? ` (it names only category="${call.category}")` : ''
    problems.push(`${at}: task( dispatches a producer without naming a restricted agent${via} — C-6, default deny: add subagent_type before prompt=`)
  }
  return problems
}

/**
 * 스킬이 띄우는 producer가 파일을 쓸 수 있는지 판정한다.
 *
 * `agents`는 이름 → 도구 목록(또는 선언 없음을 뜻하는 null) 맵이다.
 * 사유 문자열을 그대로 돌려준다 — 무엇이 걸렸는지만 알면 왜 걸렸는지는 모른다.
 *
 * 세 겹으로 본다.
 * 1. `task(` 호출마다 제한된 에이전트를 지목했는가. 지목이 없으면 실패다
 * 2. 호출 블록이 없어도 dispatch 정황(`run_in_background`, `subagent_type`)이 있는데
 *    읽을 수 있는 지목이 하나도 없으면 실패다 — 검사가 모르는 형식이라는 뜻이다
 * 3. 지목된 에이전트마다 쓰기 도구가 없는가
 */
export const checkProducerWriteAccess = ({ where, text, agents }) => {
  const problems = checkTaskCalls(where, text)
  const targets = extractDispatchTargets(text)
  const signals = dispatchSignals(text)
  // 1에서 이미 호출 자리를 짚었으면 같은 사실을 문서 단위로 한 번 더 말하지 않는다.
  if (signals.length > 0 && targets.length === 0 && problems.length === 0) {
    problems.push(`${where}: shows sub-agent dispatch (${signals.join(', ')}) but names no agent this check can read — C-6, default deny: a dispatch without a restricted agent is a dispatch to an unrestricted one`)
  }
  for (const name of targets) {
    if (name === 'general') {
      problems.push(`${where}: dispatches producers to the general agent — C-6 requires a reviewer that has no write tools`)
      continue
    }
    if (!agents.has(name)) {
      problems.push(`${where}: dispatches to "${name}", which is not defined in agents/`)
      continue
    }
    const tools = agents.get(name)
    if (tools === null) {
      problems.push(`${where}: dispatches to "${name}", which declares no tools and therefore inherits every tool — a producer must not (C-6)`)
      continue
    }
    const writable = tools.filter(tool => WRITE_TOOLS.has(tool))
    if (writable.length > 0) {
      problems.push(`${where}: producer "${name}" can write — remove ${writable.join(', ')} (C-6)`)
    }
  }
  return problems
}
