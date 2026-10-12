// 리뷰 범위에서 지적 대상으로 삼지 않는 파일(C-5). 이름 규칙으로 가를 수 있는 것은 스크립트가 센다.
//
// 오케스트레이터가 세던 때 2026-10-12 실행은 테스트·mock 파일 249개를 빼고도 `scope.done`에 `excluded: 0`을
// 적었다. 세는 일이 기억에 맡겨지면 기록과 실제 범위가 어긋난다 — preflight가 세어 남긴다.
//
// 빼는 것은 **지적 대상**이지 증거가 아니다(00-3). 테스트 변경은 diff에 남고 producer가 근거로 읽는다.
// 이름으로 드러나지 않는 fixture를 더 뺐으면 그 목록을 리포트에 적는다 — 스크립트는 그 판단을 하지 않는다.

const EXCLUDED_DIRECTORIES = new Set(['__test__', '__tests__', '__mocks__', 'mock', 'mocks', 'mockData'])
const EXCLUDED_FILE = /\.(?:test|spec|mock)\.[^/]+$/

/** C-5의 이름 규칙에 걸리는 경로인가. 경로는 저장소 기준이고 구분자는 `/`다. */
export function isExcludedPath(path) {
  const segments = String(path).split('/')
  const name = segments.pop()
  return segments.some(segment => EXCLUDED_DIRECTORIES.has(segment)) || EXCLUDED_FILE.test(name)
}

/** 변경 파일을 리뷰할 것과 뺀 것으로 나눈다. 순서는 받은 순서다. */
export function scopeOf(changed) {
  const files = []
  const excluded = []
  for (const path of changed) (isExcludedPath(path) ? excluded : files).push(path)
  return { files, excluded }
}
