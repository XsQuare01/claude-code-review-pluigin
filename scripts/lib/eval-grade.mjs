// 리뷰 리포트를 점수 벡터로 바꾸는 순수 모듈.
//
// fs도 git도 쓰지 않는다. 파일 내용은 호출자가 주입한다. 그래서 이 모듈 전체가
// 리뷰를 한 번도 실행하지 않고 검증된다 — 새로 만드는 것 중 가장 틀리기 쉬운
// 부분을, 비용이 드는 실행 없이 먼저 테스트한다는 것이 이 설계의 요점이다.

const DETAIL_HEADING = '## 상세 지적'

const strip = value => String(value ?? '').replace(/`/g, '').trim()

/**
 * `## 상세 지적` 아래부터 다음 `## ` 헤딩 직전까지를 잘라낸다.
 *
 * `### ` 하위 헤딩은 경계가 아니다 — 모듈 이름이 거기 있다.
 */
export function extractDetailSection(reportText) {
  const lines = String(reportText ?? '').split(/\r\n|\r|\n/)
  const start = lines.findIndex(line => line.trim() === DETAIL_HEADING)
  if (start === -1) return []
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => /^## /.test(line.trim()))
  return end === -1 ? rest : rest.slice(0, end)
}

/**
 * 위치 셀을 경로와 줄 번호로 나눈다.
 *
 * 확인하지 못한 위치는 버리지 않고 `unverified`로 남긴다. 위치를 못 잡은 것과
 * 결함을 못 찾은 것은 다른 실패이고, 채점에서 다른 축으로 간다.
 */
export function parseLocation(cell) {
  const text = strip(cell).replace(/\s*\([^)]*\)\s*$/, '').trim()
  if (text === '' || text.startsWith('위치 미확인')) return { unverified: true, raw: strip(cell) }
  const match = /^(.+?):(\d+)(?:\s*[-~]\s*(\d+))?$/.exec(text)
  if (!match) return { unverified: true, raw: strip(cell) }
  return {
    path: match[1].trim(),
    line: Number(match[2]),
    endLine: match[3] === undefined ? undefined : Number(match[3]),
  }
}

/**
 * 표 행을 셀로 나눈다.
 *
 * **앞 세 칸만 읽는다.** 이슈/개선 제안 칸에는 코드 인용이 들어오고 거기에
 * 이스케이프되지 않은 `|`가 섞일 수 있다. 뒤쪽 칸이 밀려도 우리가 쓰는
 * 심각도·규칙·위치는 영향받지 않는다.
 */
function splitRow(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return null
  return trimmed.slice(1).split('|').map(cell => cell.trim())
}

const isSeparatorRow = cell => cell !== '' && /^[-:\s]+$/.test(cell)

export function parseFindings(reportText) {
  const findings = []
  let currentModule = null
  for (const line of extractDetailSection(reportText)) {
    const heading = /^###\s+(.*)$/.exec(line.trim())
    if (heading) {
      currentModule = strip(heading[1])
      continue
    }
    const cells = splitRow(line)
    if (!cells || cells.length < 3) continue
    const [severityCell, ruleCell, locationCell] = cells
    if (isSeparatorRow(severityCell)) continue
    if (strip(severityCell) === '' ) continue
    if (strip(severityCell) === '심각도' || strip(ruleCell) === '규칙') continue
    findings.push({
      module: currentModule,
      severity: strip(severityCell),
      ruleId: strip(ruleCell),
      location: parseLocation(locationCell),
    })
  }
  return findings
}
