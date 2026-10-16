// 지적의 언어를 결과를 받는 자리에서 본다.
//
// 리뷰 결과는 사용자가 다른 언어를 정하지 않는 한 한국어로 쓴다(00-rule). 이 지시는 규칙 문서·에이전트 정의·스킬에
// 있지만 문장일 뿐이라, 오케스트레이터가 producer 프롬프트에서 빠뜨린 날 영어 지적이 리포트에 그대로 실렸다 —
// 2026-10-06(02·04·18 모듈), 2026-10-15(13-dx, 07-naming·16-api-contract). 받는 자리에서 막으면 작업 대장이 이미
// 가진 교정 시도로 다시 받는다.
//
// 기준은 제목과 본문에 한글이 한 글자라도 있는가다. 코드 식별자·경로·영어 용어가 섞인 한국어 문장은 통과한다.

const HANGUL = /[\u3131-\u318e\uac00-\ud7a3]/

/**
 * 한국어가 아닌 지적·열린 질문을 짚는다. 한국어 locale(`ko-KR` 등)도 같은 검사를 받는다.
 */
export function resultLanguageProblems(result, { language } = {}) {
  if (typeof language === 'string' && !['ko', 'kor'].includes(language.toLowerCase().split('-')[0])) return []
  const problems = []
  const check = (list, name) => {
    if (!Array.isArray(list)) return
    list.forEach((item, at) => {
      const text = [item?.title, item?.body].filter(value => typeof value === 'string').join(' ')
      if (text.trim() && !HANGUL.test(text)) {
        problems.push(`${name}[${at}]${item?.ruleId ? `(${item.ruleId})` : ''}의 제목·본문에 한글이 없다 — 제목·본문·근거·개선 제안을 한국어로 다시 쓴다(00-rule). 코드 식별자와 경로는 그대로 둔다`)
      }
    })
  }
  check(result?.findings, 'findings')
  check(result?.openQuestions, 'openQuestions')
  return problems
}
