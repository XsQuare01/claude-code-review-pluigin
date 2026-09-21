// `workflow-contract.md`의 기계 판독 블록을 꺼낸다.
//
// 왜 공용인가: validator와 렌더러가 같은 블록을 읽는다. 자르는 코드를 두 벌
// 두면 한쪽만 고쳐질 수 있고, 그러면 같은 계약 파일을 두 도구가 다르게 읽는다.
//
// 왜 예외가 아니라 값으로 돌려주는가: validator는 실패를 모아 한 번에 보고하고
// 렌더러는 즉시 멈춘다. 호출부가 자기 방식으로 처리할 수 있어야 한다.

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
