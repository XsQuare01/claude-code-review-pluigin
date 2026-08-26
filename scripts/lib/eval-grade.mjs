// 리뷰 리포트를 점수 벡터로 바꾸는 순수 모듈.
//
// fs도 git도 쓰지 않는다. 파일 내용은 호출자가 주입한다. 그래서 이 모듈 전체가
// 리뷰를 한 번도 실행하지 않고 검증된다 — 새로 만드는 것 중 가장 틀리기 쉬운
// 부분을, 비용이 드는 실행 없이 먼저 테스트한다는 것이 이 설계의 요점이다.

const DETAIL_HEADING = '## 상세 지적'
// C-7 섹션 표에 적용 범위 '전체'로 등재돼 있다 — /code-review에도 걸린다.
const OPEN_QUESTIONS_HEADING = '## 미해결 / 후속 확인'

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

// 셀/줄 전체가 정확히 path:line[-endLine]일 때만 맞는 앵커 패턴. 백틱 조각
// 하나가 위치 자체인지 (코드 인용이 아닌지) 판단할 때 쓴다.
const LOCATION_EXACT = /^(.+?):(\d+)(?:\s*[-~]\s*(\d+))?$/

// 백틱이 없을 때, 평문 어디든 처음 나오는 path:line 조각을 찾는다. 공백·백틱·
// 파이프는 경로 문자에서 제외한다 — 표 칸 구분자와 뒤따르는 설명이 경로에
// 섞이지 않게 한다.
const LOCATION_ANYWHERE = /([^\s`|]+):(\d+)(?:\s*[-~]\s*(\d+))?/

const toLocation = match => ({
  path: match[1].trim(),
  line: Number(match[2]),
  endLine: match[3] === undefined ? undefined : Number(match[3]),
})

/**
 * 위치 칸/줄에서 경로와 줄 번호를 찾는다.
 *
 * 확인하지 못한 위치는 버리지 않고 `unverified`로 남긴다. 위치를 못 잡은 것과
 * 결함을 못 찾은 것은 다른 실패이고, 채점에서 다른 축으로 간다.
 *
 * 실제 리포트는 위치와 코드 인용을 한 칸/한 줄에 같이 담는다
 * (`` `path:line` — `code` ``). 그래서 칸 전체가 path:line이라고 요구하지
 * 않고 첫 path:line 조각만 찾는다. 백틱으로 감싼 조각을 먼저 본다 — 워크플로가
 * 위치를 백틱으로 감싸는 규칙이라 더 강한 신호이고, 인용된 코드 안에서 우연히
 * path:line처럼 보이는 부분을 집어내는 사고도 막아준다. 백틱 조각이 없을
 * 때만 평문에서 찾는다.
 */
export function parseLocation(cell) {
  const raw = strip(cell)
  if (raw === '' || raw.startsWith('위치 미확인')) return { unverified: true, raw }

  for (const segment of String(cell ?? '').matchAll(/`([^`]*)`/g)) {
    const match = LOCATION_EXACT.exec(segment[1].trim())
    if (match) return toLocation(match)
  }

  const match = LOCATION_ANYWHERE.exec(raw)
  return match ? toLocation(match) : { unverified: true, raw }
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

function tableFindingsInLines(lines, module) {
  const findings = []
  for (const line of lines) {
    const cells = splitRow(line)
    if (!cells || cells.length < 3) continue
    const [severityCell, ruleCell, locationCell] = cells
    if (isSeparatorRow(severityCell)) continue
    if (strip(severityCell) === '') continue
    if (strip(severityCell) === '심각도' || strip(ruleCell) === '규칙') continue
    findings.push({
      module,
      severity: strip(severityCell),
      ruleId: strip(ruleCell),
      location: parseLocation(locationCell),
    })
  }
  return findings
}

const SEVERITY_GLYPHS = ['🔴', '🟡', '🔵']

/**
 * `#### 🟡 \`규칙-id\` 제목` 헤딩 블록으로 나온 지적을 읽는다.
 *
 * 실제 워크플로는 표 대신 이 형태를 쓰기도 한다 — C-7은 섹션 이름과 순서만
 * 고정하고, `## 상세 지적` 안의 지적 표현 형식까지는 고정하지 않는다.
 * 헤딩에서 심각도·규칙을 읽고, 헤딩 다음 줄부터 다음 `####`/`###` 헤딩
 * 전까지에서 백틱 위치(`parseLocation`이 unverified가 아니라고 판단하는
 * 첫 줄)를 위치로 삼는다 — 위치와 별개로 표에도 없는 `본문`/`근거` 같은 산문
 * 줄에서 우연히 걸릴 수 있어, 위치를 찾으면 그 뒤로는 더 보지 않는다.
 */
function blockFindingsInLines(lines, module) {
  const findings = []
  let current = null
  const flush = () => {
    if (!current) return
    findings.push({ module, severity: current.severity, ruleId: current.ruleId, location: current.location })
    current = null
  }
  for (const line of lines) {
    const trimmed = line.trim()
    const heading = /^####\s+(.*)$/.exec(trimmed)
    if (heading) {
      flush()
      const title = heading[1]
      const severity = SEVERITY_GLYPHS.find(glyph => title.includes(glyph))
      const ruleMatch = /`([^`]+)`/.exec(title)
      if (!severity || !ruleMatch) continue // 형태가 안 맞으면 지적으로 세지 않는다
      current = { severity, ruleId: ruleMatch[1].trim(), location: { unverified: true, raw: '' } }
      continue
    }
    if (current && current.location.unverified) {
      const location = parseLocation(trimmed)
      if (!location.unverified) current.location = location
    }
  }
  flush()
  return findings
}

export function parseFindings(reportText) {
  // `### ` 모듈 경계로 먼저 나눈다. 모듈마다 표/블록 중 무엇을 썼는지가
  // 다를 수 있고, 같은 모듈에 둘 다 있으면 이중 집계가 되기 때문이다.
  const segments = []
  let current = { module: null, lines: [] }
  for (const line of extractDetailSection(reportText)) {
    const heading = /^###\s+(.*)$/.exec(line.trim())
    if (heading) {
      segments.push(current)
      current = { module: strip(heading[1]), lines: [] }
      continue
    }
    current.lines.push(line)
  }
  segments.push(current)

  const findings = []
  for (const segment of segments) {
    const tableFindings = tableFindingsInLines(segment.lines, segment.module)
    // 표가 하나라도 있으면 그 모듈은 표만 신뢰하고 블록은 무시한다 — 표가
    // 더 엄격하게 구조화된 원래 형식이라 우선한다. 표가 없을 때만 블록을 본다.
    findings.push(...(tableFindings.length > 0 ? tableFindings : blockFindingsInLines(segment.lines, segment.module)))
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
 *
 * `counts 출처`가 있는지 **라벨만** 보고 판단하던 첫 구현은 틀렸다.
 * workflow-contract.md가 정의하는 두 provenance 줄은 둘 다 그 라벨을
 * 담는다 —
 *   `counts 출처: \`prepare-verification.mjs\`` (실제로 돌았다)
 *   `counts 출처: 미실행 (모델 판정)` (정직하게 안 돌렸다고 적었다)
 * 라벨은 두 경우 모두 등장하므로, 라벨 존재만으로는 이 둘을 구분하지
 * 못한다 — 정확히 이 함수가 구분해야 하는 두 경우가 서로 같은 값으로
 * 접힌다. 반드시 라벨 **뒤에 오는 값**을 읽어야 한다.
 */
export function checkScriptRan(reportText) {
  const text = String(reportText ?? '')
  // `REVIEW_LOCATIONS:BEGIN`은 이 branch(`feat/eval-harness`) 기준 `review-rules/`,
  // `skills/`, `prepare-verification.mjs` 어디에도 없다 — 그래서 지금은 항상
  // false다. 이 sentinel은 아직 머지되지 않은 `feat/light-location-manifest`
  // (PR #52, `skills/code-review/SKILL.md`)가 심는 것을 겨냥한다. 그 브랜치가
  // 머지되기 전까지는 신호가 아니라 항상-false 상수이므로, 소비하는 쪽에서
  // "false=신호 없음"과 "false=아직 이 sentinel을 낼 수 있는 코드가 없음"을
  // 구분해서 읽어야 한다. PR #52가 머지되면 이 주석을 지운다.
  const manifestBlock = text.includes('REVIEW_LOCATIONS:BEGIN')
  const provenance = /counts 출처:\s*(.+)/.exec(text)?.[1] ?? ''
  const countsAttributed = provenance !== ''
  // 계약의 1차 신호는 provenance 값 안의 `미실행`. `대조 미실행`은 일부
  // 실제 리포트가 provenance 절 자체를 이 문구로 대신 쓰는 것을 받아주는
  // 보조 신호로 남긴다 — 계약 문구가 우선이고 이것은 대안이다.
  const declaredSkipped = /미실행/.test(provenance) || text.includes('대조 미실행')
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
 * "확인할 수 없어 보류했다"를 "못 찾았다"와 구분해서 센다.
 *
 * 실사용 리포트(`/code-review-full` @ 2.5.7)에서 4건이 "대상 파일이 현재 HEAD에
 * 없어 검증된 삭제 위치조차 잡지 못함"으로 보류됐다. 리포트는 그것을 정직하게
 * 신고했고 산술도 맞았다 — 후보 27 = 유지 12 + 반박됨 4 + 분류 밖 1 + 범위 미확정
 * 4 + 대상 아님 6. 담을 칸이 없던 것은 채점기 쪽이었다.
 *
 * 왜 축이 필요한가: 이 결말이 `recall`에도 `falsePositives`에도 `unclassified`에도
 * 들어가지 않는다. 세지 않으면 **보류를 늘려 실패를 감추는 변화와 진짜 개선이
 * 같은 점수를 받는다.**
 *
 * 반대로 이 값을 `recall`의 분모에서 빼서도 안 된다. 그러면 못 찾은 결함을
 * "확인 불가"로 신고하는 것만으로 재현율이 오른다. 이 축은 감점이 아니라 관측이며,
 * 두 축을 나눠 들고 가는 이유가 그것이다.
 *
 * 표지는 발명하지 않는다. `workflow-contract.md`가 전체 워크플로우 공통으로
 * 이미 정의한 세 가지를 그대로 센다 — `위치 미확인 사유:`(C-7 렌더링),
 * `추가 확인 이유:`(C-6A openQuestions), `범위 미확정`(C-6B disposition).
 *
 * 앞의 둘은 섹션 안에서만 센다. 문서 전체 grep으로 접으면 어느 결말이었는지를
 * 구분하지 못하게 되고, 세 결말을 구분하려고 만든 축이 그 능력을 잃는다.
 * `범위 미확정`은 disposition 토큰이라 실행 계획에도 상세 지적에도 나올 수 있어
 * 문서 전체에서 센다.
 */
export function countUnverifiable(reportText) {
  const text = String(reportText ?? '')
  const occurrences = (haystack, marker) => haystack.split(marker).length - 1
  const locationUnverified = occurrences(extractDetailSection(text).join('\n'), '위치 미확인 사유:')
  const openQuestions = occurrences(sectionBetween(text, OPEN_QUESTIONS_HEADING).join('\n'), '추가 확인 이유:')
  const scopeOpen = occurrences(text, '범위 미확정')
  return {
    locationUnverified,
    openQuestions,
    scopeOpen,
    total: locationUnverified + openQuestions + scopeOpen,
  }
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
    unverifiable: countUnverifiable(reportText),
  }
}
