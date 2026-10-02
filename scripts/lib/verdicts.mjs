// 판정 파일을 읽는 유일한 자리.
//
// 같은 판정 파일을 두 스크립트가 읽는다 — `tally-verdicts.mjs`는 세고,
// `render-findings.mjs`는 그린다. 각자 읽으면 받는 모양이 갈린다. 2026-09-30
// 실행이 그 틈에 빠졌다: tally는 `{ tasks: [ … ] }`를 받아 유지 19건으로 셌고,
// 렌더러는 최상위 `verdicts`만 봐서 같은 파일을 0건으로 읽었다 — 그대로 그렸으면
// 검증 대상 23건이 전부 `검증 실패`로 찍혔다. 오류는 어디에도 나지 않았다.

/**
 * payload가 어떤 모양으로 오든 verdict 목록 하나로 편다.
 *
 * 받는 모양은 셋이다: `REVIEW_VERDICT_CONTRACT_V1` payload 하나(`{ verdicts }`),
 * 그 배열, 그리고 `{ tasks: [ … ] }`. 검증 패스는 작업을 여러 개 띄우고 각자
 * payload를 내므로, 여러 벌을 한 파일에 모으는 모양이 여럿 생긴다.
 *
 * 판정 목록을 찾지 못하면 **던진다.** 모르는 모양을 빈 목록으로 흘려보내면 그
 * 파일의 판정이 전부 "판정 없음"이 되는데, 읽는 쪽은 그것이 검증 실패인지 읽기
 * 실패인지 가릴 수 없다. 던진 메시지를 어떻게 끝낼지(exit 코드·경로 표기)는
 * 호출하는 CLI가 정한다.
 */
export function collectVerdicts(payloads) {
  const verdicts = []
  const walk = value => {
    if (Array.isArray(value)) { value.forEach(walk); return }
    if (!value || typeof value !== 'object') {
      throw new Error(`판정 payload 자리에 객체가 아닌 값이 있다: ${JSON.stringify(value)}`)
    }
    if (Array.isArray(value.verdicts)) { verdicts.push(...value.verdicts); return }
    if (Array.isArray(value.tasks)) { value.tasks.forEach(walk); return }
    throw new Error(`verdicts도 tasks도 없는 payload다: ${JSON.stringify(Object.keys(value))}`)
  }
  walk(payloads)
  return verdicts
}

/**
 * 검증 작업 하나가 돌려준 판정 파일의 내용을 계약과 요청에 맞춰 본다.
 *
 * 계약(`REVIEW_VERDICT_CONTRACT_V1`)은 `validateVerdict`가 본다 — 호출자가
 * `lib/contract-validate.mjs`의 `validateVerdictPayload`에 manifest를 묶어 넘긴다.
 * 여기서 더 보는 것은 **요청과의 대응**이다: 판정한 candidateId 집합이 그 작업에
 * 맡긴 집합과 다르면 C-6B는 그것도 malformed-output으로 친다. 이름표가 어긋난
 * 판정은 형식이 맞아도 다른 지적의 판정이 될 수 있기 때문이다.
 *
 * 문제가 없으면 `payload`를, 있으면 `problems`(사람이 읽을 문장 목록)를 돌려준다.
 */
export function checkTaskVerdict(raw, candidateIds, validateVerdict) {
  let payload
  try {
    payload = JSON.parse(raw)
  } catch (error) {
    return { problems: [`JSON으로 읽지 못했다: ${error.message} — 코드펜스나 서문 없이 JSON 객체 하나만 돌려준다`] }
  }
  const problems = validateVerdict(payload).map(error => `${error.code}: ${error.message}`)
  if (Array.isArray(payload?.verdicts)) {
    const returned = payload.verdicts.map(verdict => verdict?.candidateId)
    const missing = candidateIds.filter(id => !returned.includes(id))
    const extra = returned.filter(id => typeof id === 'string' && !candidateIds.includes(id))
    if (missing.length) problems.push(`요청한 candidateId의 판정이 없다: ${missing.join(', ')}`)
    if (extra.length) problems.push(`요청하지 않은 candidateId를 판정했다: ${extra.join(', ')}`)
  }
  return problems.length ? { problems } : { payload }
}
