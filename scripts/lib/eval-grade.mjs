// 리뷰 리포트를 점수 벡터로 바꾸는 순수 모듈.
//
// fs도 git도 쓰지 않는다. 파일 내용은 호출자가 주입한다. 그래서 이 모듈 전체가
// 리뷰를 한 번도 실행하지 않고 검증된다 — 새로 만드는 것 중 가장 틀리기 쉬운
// 부분을, 비용이 드는 실행 없이 먼저 테스트한다는 것이 이 설계의 요점이다.

const DETAIL_HEADING = '## 상세 지적'

const strip = value => String(value ?? '').replace(/`/g, '').trim()

/**
 * `heading` 아래부터 다음 `## ` 헤딩 직전까지를 잘라낸다.
 *
 * `### ` 하위 헤딩은 경계가 아니다 — 모듈 이름이 거기 있다.
 */
function sectionBetween(reportText, heading) {
  const lines = String(reportText ?? '').split(/\r\n|\r|\n/)
  const start = lines.findIndex(line => line.trim() === heading)
  if (start === -1) return []
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => /^## /.test(line.trim()))
  return end === -1 ? rest : rest.slice(0, end)
}

// `## 상세 지적` 아래 섹션만 잘라낸다 — 지적 파서가 신뢰하는 경계.
export function extractDetailSection(reportText) {
  return sectionBetween(reportText, DETAIL_HEADING)
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

/**
 * 같은 경로가 mustFind와 mustNotFlag에 동시에 있으면 채점 결과가 조용히
 * 틀린다. 조용히 틀리는 대신 크게 실패한다 — fixture 작성 실수는 지표가
 * 아니라 예외로 드러나야 한다.
 */
export function assertNoPathOverlap(expected) {
  const findPaths = new Set((expected?.mustFind ?? []).map(target => target.path))
  for (const target of expected?.mustNotFlag ?? []) {
    if (findPaths.has(target.path)) {
      throw new Error(`expected.json overlaps on ${target.path} — a path cannot be both mustFind and mustNotFlag`)
    }
  }
}

const onTargetPath = (finding, target) => {
  const location = finding.location
  if (location.unverified) return false
  if (location.path !== target.path) return false
  if (!target.lineRange) return true
  return location.line >= target.lineRange[0] && location.line <= target.lineRange[1]
}

const ruleAllowed = (finding, target) => (target.ruleIds ?? []).includes(finding.ruleId)

// collectBlobs() (prepare-verification.mjs) stores raw file content as a string, not an
// array of lines. If that string ever reaches here unsplit, `.length` silently becomes a
// character count instead of a line count, and locationsInRange stops catching anything —
// so a wrong shape must throw here, not be scored.
const resolveLines = (location, blobLines) => {
  const lines = blobLines?.head?.[location.path] ?? blobLines?.base?.[location.path]
  if (typeof lines === 'string') {
    throw new Error(`blobLines['${location.path}'] is a string, not an array of lines — collectBlobs() output cannot be passed to gradeFindings() directly; split it into lines first`)
  }
  return lines
}

export function gradeFindings(findings, expected, blobLines) {
  assertNoPathOverlap(expected)

  const claimed = new Set()
  const matched = []
  const missed = []
  let ruleOnly = 0

  for (const target of expected?.mustFind ?? []) {
    let index = findings.findIndex((f, i) => !claimed.has(i) && ruleAllowed(f, target) && onTargetPath(f, target))
    let via = 'path'
    if (index === -1) {
      // 결함은 찾았는데 위치를 못 잡은 경우. 탐지로는 인정하되 따로 센다 —
      // 규칙 ID만 나열하고 위치를 전부 비운 리포트가 재현율만으로는 만점이
      // 되기 때문에, 그 형태가 벡터에서 보여야 한다.
      index = findings.findIndex((f, i) => !claimed.has(i) && ruleAllowed(f, target) && f.location.unverified)
      via = 'rule-only'
    }
    if (index === -1) {
      missed.push(target.id)
      continue
    }
    claimed.add(index)
    if (via === 'rule-only') ruleOnly += 1
    matched.push({ target: target.id, index, via })
  }

  const targetById = new Map((expected?.mustFind ?? []).map(target => [target.id, target]))
  const pathMatched = matched.filter(entry => entry.via === 'path')
  const onTargetCount = pathMatched.filter(entry => {
    const target = targetById.get(entry.target)
    const line = findings[entry.index].location.line
    return Math.abs(line - target.line) <= (target.lineTolerance ?? 0)
  }).length

  const falsePositiveHits = []
  const flaggedForbidden = new Set()
  findings.forEach((finding, index) => {
    const hit = (expected?.mustNotFlag ?? []).find(target => onTargetPath(finding, target))
    if (!hit) return
    flaggedForbidden.add(index)
    falsePositiveHits.push({ target: hit.id, ruleId: finding.ruleId, location: finding.location })
  })

  const badLocations = []
  let inRangeOk = 0
  let inRangeOf = 0
  for (const finding of findings) {
    const location = finding.location
    if (location.unverified) continue
    inRangeOf += 1
    const lines = resolveLines(location, blobLines)
    if (!lines) {
      badLocations.push({ path: location.path, line: location.line, reason: 'path not in fixture' })
      continue
    }
    if (location.line < 1 || location.line > lines.length) {
      badLocations.push({ path: location.path, line: location.line, reason: 'line beyond file length' })
      continue
    }
    inRangeOk += 1
  }

  const unclassified = findings.filter((_, index) => !claimed.has(index) && !flaggedForbidden.has(index)).length

  const modules = []
  for (const finding of findings) {
    if (finding.module && !modules.includes(finding.module)) modules.push(finding.module)
  }

  return {
    findings: findings.length,
    recall: { found: matched.length, of: (expected?.mustFind ?? []).length, ruleOnly, missed },
    falsePositives: { count: falsePositiveHits.length, hits: falsePositiveHits },
    unclassified,
    locationsInRange: { ok: inRangeOk, of: inRangeOf, bad: badLocations },
    locationsOnTarget: { ok: onTargetCount, of: pathMatched.length },
    modulesWithFindings: modules,
  }
}

// workflow-contract C-7 문서 골격. 이름과 순서를 그대로 따른다.
export const REQUIRED_SECTIONS = [
  '## 리뷰 기준',
  '## 판정',
  '## 실행 계획',
  '## 상세 지적',
  '## 요약',
  '## 도구 실행 결과',
  '## 미해결 / 후속 확인',
]

export function checkSkeleton(reportText) {
  const headings = String(reportText ?? '')
    .split(/\r\n|\r|\n/)
    .map(line => line.trim())
    .filter(line => /^## /.test(line))
  const problems = []
  let cursor = -1
  for (const section of REQUIRED_SECTIONS) {
    const at = headings.indexOf(section)
    if (at === -1) {
      problems.push(`빠짐: ${section}`)
      continue
    }
    if (at < cursor) problems.push(`순서 어긋남: ${section}`)
    cursor = Math.max(cursor, at)
  }
  return { ok: problems.length === 0, problems }
}

/**
 * 위치 대조 스크립트가 실제로 돌았는지 본다 — 이슈 #50의 질문이다.
 *
 * 세 신호를 따로 남긴다. "돌았다"와 "안 돌렸다고 정직하게 적었다"와
 * "아무 말도 없다"는 서로 다른 결과이고, 세 번째가 가장 나쁘다.
 */
export function checkScriptRan(reportText) {
  const text = String(reportText ?? '')
  const manifestBlock = text.includes('REVIEW_LOCATIONS:BEGIN')
  const countsAttributed = text.includes('counts 출처')
  const declaredSkipped = text.includes('대조 미실행')
  return { ran: countsAttributed && !declaredSkipped, manifestBlock, countsAttributed, declaredSkipped }
}

const SEVERITY_KEY = { '🔴': 'red', '🟡': 'yellow', '🔵': 'blue' }

export function checkSummaryArithmetic(reportText, findings) {
  const summary = { red: 0, yellow: 0, blue: 0 }
  for (const line of sectionBetween(reportText, '## 요약')) {
    const cells = splitRow(line)
    if (!cells || cells.length < 4) continue
    const [, red, yellow, blue] = cells
    if (!/^\d+$/.test(red) || !/^\d+$/.test(yellow) || !/^\d+$/.test(blue)) continue
    summary.red += Number(red)
    summary.yellow += Number(yellow)
    summary.blue += Number(blue)
  }
  const detail = { red: 0, yellow: 0, blue: 0 }
  for (const finding of findings) {
    const key = SEVERITY_KEY[finding.severity]
    if (key) detail[key] += 1
  }
  const ok = summary.red === detail.red && summary.yellow === detail.yellow && summary.blue === detail.blue
  return { ok, summary, detail }
}

/**
 * runner가 부르는 유일한 함수. 축을 하나의 점수로 접지 않는다 —
 * 어느 축이 움직였는지가 이 계측의 전부다.
 */
export function grade(reportText, expected, blobLines) {
  const findings = parseFindings(reportText)
  return {
    ...gradeFindings(findings, expected, blobLines),
    scriptRan: checkScriptRan(reportText),
    skeletonOk: checkSkeleton(reportText),
    summaryArithmetic: checkSummaryArithmetic(reportText, findings),
  }
}
