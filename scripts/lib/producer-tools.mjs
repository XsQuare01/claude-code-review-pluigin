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

// 셸은 쓰기 도구다. `sed -i`와 리다이렉션이 있으므로 Edit/Write만 빼는 것은
// 절반짜리이고, 그 절반이 정확히 사고가 통과한 틈이다.
export const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell'])

/**
 * 스킬 문서에서 sub-agent dispatch 대상을 뽑는다.
 *
 * 네임스페이스(`plugin:agent`)는 벗겨서 에이전트 이름만 남긴다. 호스트마다
 * 접두사가 다르고, 검사하려는 것은 접두사가 아니라 **어느 에이전트인가**다.
 */
export const extractDispatchTargets = text => [
  ...new Set([...String(text ?? '').matchAll(/subagent_type\s*[=:]\s*`?([\w:-]+)`?/g)]
    .map(match => match[1])
    .map(raw => (raw.includes(':') ? raw.slice(raw.lastIndexOf(':') + 1) : raw))),
]

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

/**
 * 스킬이 띄우는 producer가 파일을 쓸 수 있는지 판정한다.
 *
 * `agents`는 이름 → 도구 목록(또는 선언 없음을 뜻하는 null) 맵이다.
 * 사유 문자열을 그대로 돌려준다 — 무엇이 걸렸는지만 알면 왜 걸렸는지는 모른다.
 */
export const checkProducerWriteAccess = ({ where, text, agents }) => {
  const problems = []
  for (const name of extractDispatchTargets(text)) {
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
