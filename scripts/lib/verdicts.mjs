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
