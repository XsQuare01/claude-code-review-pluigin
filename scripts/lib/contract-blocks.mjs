// `workflow-contract.md`의 기계 판독 블록을 꺼낸다.
//
// 왜 공용인가: validator와 렌더러가 같은 블록을 읽는다. 자르는 코드를 두 벌
// 두면 한쪽만 고쳐질 수 있고, 그러면 같은 계약 파일을 두 도구가 다르게 읽는다.
//
// 왜 예외가 아니라 값으로 돌려주는가: validator는 실패를 모아 한 번에 보고하고
// 렌더러는 즉시 멈춘다. 호출부가 자기 방식으로 처리할 수 있어야 한다.

/**
 * `CROSS_VERIFICATION_RENDER_TOKENS` 블록이 반드시 선언해야 하는 키.
 *
 * 왜 블록 밖에 두는가: 검사하려는 것이 "블록에 이 키들이 다 있는가"라서, 목록을
 * 블록 안에서 읽으면 무엇을 검사하든 항상 통과한다. 자기 자신을 기준으로 삼은
 * 검사는 검사가 아니다.
 *
 * 왜 여기인가: validator(CI에서 계약 파일을 본다)와 렌더러(실행 시점에 읽는다)가
 * 둘 다 이 목록을 쓴다. 두 벌 두면 한쪽만 고쳐질 수 있고, 그러면 CI가 통과한
 * 계약으로 렌더러가 멈추거나 그 반대가 된다.
 *
 * 왜 필요한가: 키 하나가 빠져도 렌더는 **성공**한다. 예를 들어
 * `verification-disabled`만 사라지면 라벨이 undefined가 되고, 교차검증 축은
 * "이 워크플로우에 축이 없다"와 구분되지 않아 줄 자체가 빠진다. 검증을 끈
 * 실행이 검증 축이 없는 워크플로우처럼 보이는데, 리포트만 보고는 알 수 없다.
 */
export const CROSS_VERIFICATION_TOKEN_KEYS = [
  'upheld',
  'rejected-shadow',
  'rejected-other',
  'scope-open',
  'verification-unavailable',
  'not-eligible',
  'verification-disabled',
]

export function markedBlock(text, label) {
  const begin = `<!-- ${label}:BEGIN -->`
  const end = `<!-- ${label}:END -->`
  const beginCount = text.split(begin).length - 1
  const endCount = text.split(end).length - 1
  if (beginCount !== 1 || endCount !== 1) {
    return { error: `${label} 블록은 정확히 한 번 나와야 한다 (BEGIN=${beginCount}, END=${endCount})` }
  }
  const start = text.indexOf(begin)
  const finish = text.indexOf(end)
  if (finish <= start) return { error: `${label} 블록의 끝이 시작보다 앞에 있다` }
  return { value: text.slice(start + begin.length, finish).trim() }
}

export function markedJson(text, label) {
  const block = markedBlock(text, label)
  if (block.error) return block
  const match = block.value.match(/^```json\s*([\s\S]*?)\s*```$/)
  if (!match) return { error: `${label} 블록이 json 코드펜스가 아니다` }
  try {
    return { value: JSON.parse(match[1]) }
  } catch (error) {
    return { error: `${label} 블록의 JSON을 읽지 못했다: ${error.message}` }
  }
}
