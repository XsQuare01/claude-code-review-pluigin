// 이전 리뷰와 이번 리뷰를 잇는다 — 증분 재리뷰(C-13).
//
// 수정 커밋을 올리고 다시 리뷰하면, 읽는 사람이 알고 싶은 것은 "이전 지적이 고쳐졌나, 새로 생긴
// 문제는 무엇인가"다. 두 리포트를 나란히 놓고 눈으로 맞추면 줄 번호가 밀린 같은 지적이 새 지적으로
// 보이고, 이번에 안 나온 지적은 고쳐진 것으로 보인다. 둘 다 틀린 결론이다.
//
// 지키는 것:
// - **줄 번호·제목·순번으로 같은 지적이라고 하지 않는다.** 같은 지적인지는 규칙, 정규화한 위치(경로와
//   인용한 코드 줄), 위치의 종류로 본다. 조항이 없는 패스의 `CR-{n}`은 번호가 지적의 순번이라 번호를 뺀다.
//   파일 이동은 git의 이름 바꿈 대응으로 따라간다
// - **애매하면 잇지 않는다.** 같은 규칙·같은 위치에 이전 지적이나 이번 지적이 둘 이상이면 어느 것이
//   어느 것인지 말할 수 없다 — 합치지 않고 모두 재확인 필요로 둔다
// - **이번에 안 나온 것은 해결의 증거가 아니다.** 이어지지 않는 이전 지적은 재확인 필요다. 해결 확인은
//   그 지적을 지금 코드로 다시 판정한 결과(재확인 검증)가 있을 때만 준다 — 그 판정은 이 파일이 아니라
//   `finalizePrevious`가 받는다
// - **검토하지 않은 범위의 지적은 그대로 둔다.** 이번 실행에서 그 모듈이 실패했거나 건너뛰었으면,
//   이전 지적이 안 나온 것은 당연하다
//
// 계산만 한다. git과 파일은 호출자가 읽어 넘긴다(`pathChanges`만 git을 부른다).

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

/** 비교에서 지적 하나가 받는 상태. 이번 지적은 new·linked·recheck, 이전 지적은 linked·recheck → 판정 뒤 persisting·resolved·recheck. */
export const CURRENT_STATUSES = ['new', 'linked', 'recheck']
export const PREVIOUS_STATUSES = ['persisting', 'resolved', 'recheck']
export const RECHECK_REASONS = [
  'ambiguous', 'location-unverified', 'not-reviewed', 'rule-changed', 'file-deleted', 'absent',
  'previous-not-reviewed', 'claim-unavailable', 'verification-off', 'no-recheck-verdict',
  'recheck-needs-context', 'recheck-unlocated', 'recheck-location-wrong',
  'identity-unconfirmed', 'identity-different', 'current-rejected', 'current-scope-open', 'current-unverified',
]

/**
 * 해결 확인을 주지 않는 반박 kind — 막는 코드의 위치를 댄 반박이 아니다.
 *
 * - `other`: 위치를 대지 못한 반박이다
 * - `location-wrong`: 결함은 성립한다고 인정하고 위치만 틀렸다고 한 반박이다. 결함이 남아
 *   있다는 말을 해결로 읽으면 고치지 않은 결함이 해결 확인으로 보고된다
 *
 * 교차검증에서 이 둘은 어떤 phase에서도 지적을 지우지 않는다(C-6B). 판정 manifest의
 * `kindEnum`에서 `deletionAllowingKinds`를 뺀 것과 같아야 하고, `validate-rules.mjs`가 그것을
 * 본다 — 이 파일은 계약 파일을 읽지 않는 순수 계산이라 목록을 여기 둔다.
 */
export const NON_RESOLVING_KINDS = ['other', 'location-wrong']

/** 공백을 하나로 접고 양끝을 자른다. 들여쓰기만 바뀐 줄은 같은 줄이다. */
export const normalizeQuote = quote => String(quote ?? '').replace(/\s+/g, ' ').trim()

/** 조항 없는 namespace(`CR`)의 지적은 번호를 뺀다 — `CR-1`과 `CR-2`는 다른 결함이라는 뜻이 아니다. */
export function ruleKeyOf(ruleId, clauselessPrefixes = []) {
  const prefix = String(ruleId).split('-')[0]
  return clauselessPrefixes.includes(prefix) ? `${prefix}-*` : String(ruleId)
}

/**
 * 지적의 위치를 비교할 수 있는 꼴로 바꾼다. 위치를 확인하지 못한 지적은 null이다.
 *
 * `verified`는 작업 트리의 줄이므로 이름 바꿈을 따라간다. `deleted`는 merge-base에서 지운 줄이라
 * 이번 변경의 이름 바꿈과 상관이 없다.
 */
export function anchorOf(location, renamed = null) {
  if (!location || (location.kind !== 'verified' && location.kind !== 'deleted')) return null
  const path = String(location.path ?? '')
  const mapped = location.kind === 'verified' && renamed?.has(path) ? renamed.get(path) : path
  return { side: location.kind, path: mapped, quote: normalizeQuote(location.quote) }
}

const keyOf = (ruleKey, anchor) => `${ruleKey}\u0000${anchor.side}\u0000${anchor.path}\u0000${anchor.quote}`

/**
 * 지적의 fingerprint — 저장소, 규칙, 정규화한 위치. 실행 간 비교의 열쇠다.
 *
 * 위치를 확인하지 못한 지적은 fingerprint가 없다(null). 제목으로 대신하지 않는다.
 */
export function fingerprintOf({ repo, ruleKey, anchor }) {
  if (!anchor) return null
  return `sha256:${createHash('sha256').update(JSON.stringify([repo ?? null, ruleKey, anchor.side, anchor.path, anchor.quote])).digest('hex')}`
}

/**
 * 그 줄을 감싼 선언의 이름 — 같은 코드 줄이 서로 다른 함수에 있으면 다른 자리다(PR #94 리뷰).
 *
 * 줄에서 위로 올라가며 중괄호를 센다. 위에서 열렸는데 그 줄 전에 닫히지 않은 블록이 그 줄을 감싼다. 감싸는
 * 블록을 여는 줄이 선언(함수·화살표 함수를 담은 변수·클래스·메서드)이면 그 이름이다. `if`·`for` 같은 블록은
 * 건너 더 위로 간다. 아무 선언에도 감싸이지 않으면 빈 문자열(모듈 최상위)이다. 중괄호가 없는 언어의 `def`는
 * 들여쓰기로 본다.
 *
 * 문법 분석기가 아니라 모양을 보는 것이므로, 같은 결함이라고 말하는 근거가 아니라 **다른 자리라고 말하는
 * 근거**로만 쓴다.
 */
const DECLARATIONS = [
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
  /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^(?:(?:public|private|protected|static|async|readonly|override)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/,
]
const PYTHON_DEF = /^(\s*)def\s+([A-Za-z_]\w*)/
const NOT_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'with'])
const count = (text, char) => text.split(char).length - 1
export function enclosingSymbol(text, line) {
  if (typeof text !== 'string' || !Number.isInteger(line) || line < 1) return null
  const lines = text.split(/\r?\n/)
  if (line > lines.length) return null
  const targetIndent = lines[line - 1].match(/^\s*/)[0].length
  let closed = 0
  for (let at = line - 2; at >= 0; at -= 1) {
    const raw = lines[at]
    const python = PYTHON_DEF.exec(raw)
    if (python && python[1].length < targetIndent) return python[2]
    closed += count(raw, '}')
    const opened = count(raw, '{')
    if (opened > closed) {
      for (const pattern of DECLARATIONS) {
        const match = pattern.exec(raw.trim())
        if (match && !NOT_NAMES.has(match[1])) return match[1]
      }
      closed = 0
      continue
    }
    closed -= opened
  }
  return ''
}

const sourcesOf = finding => (Array.isArray(finding.sources) ? finding.sources : finding.source !== undefined ? [finding.source] : []).map(String)

/**
 * 이전 지적과 이번 지적을 잇는다.
 *
 * - `previous`: 이전 스냅숏의 지적(`ref`·`lineageId`·`candidateId`·`ruleId`·`sources`·`location`)
 * - `current`: 이번 실행의 후보(`candidateId`·`ruleId`·`sources`/`source`·`location`)
 * - `reviewedNow`: 이번 실행에서 결과를 모은 모듈 이름들
 * - `reviewedBefore`: 이전 실행에서 결과를 모은 모듈 이름들
 * - `paths`: 이전 HEAD와 지금 작업 트리 사이의 `renamed`(옛 경로 → 새 경로)·`deleted`·`changed`. 모르면 null
 * - `ruleChanged(ruleId)`: 그 규칙의 문서가 바뀌었으면 참
 *
 * 열쇠(규칙·경로·인용 줄)가 1:1로 맞는 것은 **이을 후보**다. 같은 결함이라고 하려면 근거가 더 있어야 한다
 * (PR #94 리뷰 — 같은 줄에서 이전 결함을 고치고 다른 결함이 생긴 것도 열쇠는 같다).
 * - 감싼 선언(`symbol`)이 다르면 다른 자리다 — 잇지 않는다. 각자 이어지지 않은 지적으로 간다
 * - 규칙 조항이 결함의 종류를 정하는 지적은 같은 조항·같은 줄·같은 선언이면 잇는다
 * - 조항이 없는 지적(`CR`)은 규칙 ID가 결함의 종류를 말하지 않는다. 위치 대조가 어긋난 지적도 줄이 확실하지
 *   않다. 둘은 **같은 결함인지 검증자에게 묻는다**(`identity-unconfirmed`) — 판정이 같다고 할 때만 잇는다
 */
export function linkFindings({ previous, current, currentRunId, clauselessPrefixes = [], reviewedNow, reviewedBefore, paths = null, ruleChanged = () => false }) {
  const renamed = paths?.renamed ?? null
  const prevKeyed = previous.map(finding => {
    const anchor = anchorOf(finding.location, renamed)
    return { finding, anchor, key: anchor ? keyOf(ruleKeyOf(finding.ruleId, clauselessPrefixes), anchor) : null }
  })
  const curKeyed = current.map(finding => {
    const anchor = anchorOf(finding.location)
    return { finding, anchor, key: anchor ? keyOf(ruleKeyOf(finding.ruleId, clauselessPrefixes), anchor) : null }
  })
  const group = list => {
    const map = new Map()
    for (const entry of list) {
      if (entry.key === null) continue
      if (!map.has(entry.key)) map.set(entry.key, [])
      map.get(entry.key).push(entry)
    }
    return map
  }
  const prevGroups = group(prevKeyed)
  const curGroups = group(curKeyed)

  // 1:1로 맞은 열쇠마다: 'same'(잇는다)·'identity'(같은 결함인지 묻는다)·'different'(다른 자리다).
  const decisions = new Map()
  for (const [key, before] of prevGroups) {
    const now = curGroups.get(key)
    if (before.length !== 1 || now?.length !== 1) continue
    const [earlier, later] = [before[0].finding, now[0].finding]
    if ((earlier.symbol ?? null) !== (later.symbol ?? null)) {
      decisions.set(key, 'different')
      continue
    }
    const located = [earlier, later].every(finding => finding.locationCheck === undefined || finding.locationCheck === 'location-ok')
    const clauseless = ruleKeyOf(later.ruleId, clauselessPrefixes).endsWith('-*')
    decisions.set(key, clauseless || !located ? 'identity' : 'same')
  }

  const currentOut = new Map()
  for (const { finding, anchor, key } of curKeyed) {
    const own = `${currentRunId}/${finding.candidateId}`
    if (key === null) {
      currentOut.set(finding.candidateId, { status: 'recheck', reason: 'location-unverified', lineageId: own })
      continue
    }
    const decision = decisions.get(key)
    const before = decision === 'different' ? [] : (prevGroups.get(key) ?? [])
    const fileChanged = paths?.changed && anchor.side === 'verified' ? paths.changed.has(anchor.path) : null
    if (decision === 'same') {
      const previousFinding = before[0].finding
      currentOut.set(finding.candidateId, { status: 'linked', previousRef: previousFinding.ref, lineageId: previousFinding.lineageId ?? previousFinding.ref })
      continue
    }
    if (decision === 'identity') {
      const previousFinding = before[0].finding
      // 같은 결함이라는 판정이 오면 이전의 이름을, 다르다는 판정이 오면 신규로 — 그 둘에 필요한 값을 함께 둔다.
      currentOut.set(finding.candidateId, {
        status: 'recheck', reason: 'identity-unconfirmed', lineageId: own,
        previousRef: previousFinding.ref, previousLineageId: previousFinding.lineageId ?? previousFinding.ref,
        fileChanged, ruleChanged: ruleChanged(finding.ruleId) === true,
      })
      continue
    }
    if (before.length) {
      currentOut.set(finding.candidateId, { status: 'recheck', reason: 'ambiguous', lineageId: own })
      continue
    }
    // 이전 실행이 이 모듈을 검토하지 않았으면, 이전 리뷰에 없던 지적이라는 사실이 아무것도 말하지 않는다.
    if (sourcesOf(finding).some(source => !reviewedBefore.has(source))) {
      currentOut.set(finding.candidateId, { status: 'recheck', reason: 'previous-not-reviewed', lineageId: own })
      continue
    }
    currentOut.set(finding.candidateId, {
      status: 'new',
      lineageId: own,
      // 신규는 "이전 리뷰에 없던 지적"이다. 그 자리의 코드가 이번에 바뀌었는지를 함께 남긴다 — 바뀌지
      // 않았으면 이번 변경이 만든 결함이 아니라 이전 리뷰가 놓쳤거나 판단이 달라진 것이다.
      fileChanged,
      ruleChanged: ruleChanged(finding.ruleId) === true,
    })
  }

  const previousOut = prevKeyed.map(({ finding, anchor, key }) => {
    const base = {
      ref: finding.ref,
      lineageId: finding.lineageId ?? finding.ref,
      candidateId: finding.candidateId,
      ruleId: finding.ruleId,
      sources: sourcesOf(finding),
      location: finding.location,
      // 원래 주장의 글이 있는 파일과 그 해시. 이월된 지적은 처음 낸 실행의 파일을 가리킨다(PR #94 리뷰).
      ...(finding.claimSource ? { claimSource: finding.claimSource } : {}),
      ...(finding.carried ? { carried: true } : {}),
    }
    if (key === null) return { ...base, status: 'recheck', reason: 'location-unverified' }
    const decision = decisions.get(key)
    const now = decision === 'different' ? [] : (curGroups.get(key) ?? [])
    if (decision === 'same') return { ...base, status: 'linked', currentCandidateId: now[0].finding.candidateId }
    if (decision === 'identity') return { ...base, status: 'recheck', reason: 'identity-unconfirmed', currentCandidateId: now[0].finding.candidateId }
    if (now.length) return { ...base, status: 'recheck', reason: 'ambiguous' }
    if (base.sources.some(source => !reviewedNow.has(source))) return { ...base, status: 'recheck', reason: 'not-reviewed' }
    if (ruleChanged(finding.ruleId)) return { ...base, status: 'recheck', reason: 'rule-changed' }
    if (anchor.side === 'verified' && paths?.deleted?.has(anchor.path)) return { ...base, status: 'recheck', reason: 'file-deleted' }
    return { ...base, status: 'recheck', reason: 'absent' }
  })

  return { current: currentOut, previous: previousOut }
}

/**
 * 재확인 검증을 맡길 이전 지적인가.
 *
 * 같은 자리에 이번 지적이 있어 어느 것과 이어지는지 모르는 것(`ambiguous`)은 맡기지 않는다 — 그
 * 결함은 사라지지 않았고, 모르는 것은 짝이다.
 */
export const recheckable = entry => entry.status === 'recheck' && entry.reason !== 'ambiguous' && entry.reason !== 'identity-unconfirmed'

/** 같은 결함인지 검증자에게 물을 이전 지적인가 — 열쇠가 1:1로 맞았지만 근거가 모자란 것. */
export const identityPending = entry => entry.status === 'recheck' && entry.reason === 'identity-unconfirmed' && entry.currentCandidateId !== undefined

/** 재확인 판정 하나가 이전 지적의 상태로 무엇이 되는가. 위치를 댄 반박만 해결 확인이다. */
export function recheckOutcome(verdict) {
  if (!verdict) return { status: 'recheck', reason: 'no-recheck-verdict' }
  if (verdict.disposition === 'upheld') return { status: 'persisting', basis: 'recheck' }
  if (verdict.disposition === 'needs-context') return { status: 'recheck', reason: 'recheck-needs-context' }
  if (verdict.disposition === 'rejected') {
    const kind = verdict.rebuttal?.kind
    // `other`는 위치를 대지 못한 반박이다(C-6B — 어떤 phase에서도 삭제를 유발하지 않는다).
    if (!kind || kind === 'other') return { status: 'recheck', reason: 'recheck-unlocated' }
    // `location-wrong`은 결함이 남아 있다는 판정이다. 자리가 옮겨 갔다는 뜻이지 고쳐졌다는
    // 뜻이 아니다 — 그래도 어느 자리의 어느 지적과 같은지는 이 판정이 말하지 않으므로
    // 미해결로 단정하지 않고 재확인 필요로 둔다.
    if (kind === 'location-wrong') return { status: 'recheck', reason: 'recheck-location-wrong' }
    return { status: 'resolved', rebuttalKind: kind }
  }
  return { status: 'recheck', reason: 'no-recheck-verdict' }
}

/**
 * 이전 지적의 최종 상태 — 잇기 결과에 재확인 판정을 얹는다.
 *
 * - 이어졌으면 `persisting`(미해결)이다. 이번 리뷰가 같은 자리에서 같은 규칙으로 다시 냈다
 * - 재확인 판정이 있으면 그 판정을 따른다
 * - 그 밖은 `recheck`이고 이유를 남긴다. 재확인을 맡겼는데 판정이 없으면 `no-recheck-verdict`다
 */
export function finalizePrevious(entries, verdictsByRef = new Map(), { recheckRequested = new Set(), identityRequested = new Set(), currentDispositions = new Map() } = {}) {
  // 이어진 이전 지적의 상태는 **이번 후보의 최종 판정**을 따른다. "1차 producer가 다시 냈다"와 "검증 뒤에도
  // 남아 있다"는 다른 사실이다(PR #94 리뷰). 이번 후보가 반박됐거나 검증이 확정되지 않았으면 이전 지적은
  // 재확인 필요다 — 그렇다고 해결 확인으로 바꾸지도 않는다. 해결 확인은 재확인 판정만 준다.
  const settle = (entry, basis) => {
    const disposition = currentDispositions.get(entry.currentCandidateId)
    if (disposition === 'rejected') return { ...entry, status: 'recheck', reason: 'current-rejected' }
    if (disposition === 'scope-open') return { ...entry, status: 'recheck', reason: 'current-scope-open' }
    if (disposition === 'verification-unavailable') return { ...entry, status: 'recheck', reason: 'current-unverified' }
    return { ...entry, status: 'persisting', basis }
  }
  return entries.map(entry => {
    if (entry.status === 'linked') return settle(entry, 'linked')
    if (identityRequested.has(entry.ref)) {
      const verdict = verdictsByRef.get(entry.ref)
      const { reason, ...rest } = entry
      if (verdict?.disposition === 'upheld') return settle({ ...rest, firstReason: reason }, 'identity')
      if (verdict?.disposition === 'rejected') return { ...rest, status: 'recheck', reason: 'identity-different', firstReason: reason }
      return entry
    }
    if (!recheckRequested.has(entry.ref)) return entry
    const outcome = recheckOutcome(verdictsByRef.get(entry.ref))
    const { reason, ...rest } = entry
    // 재확인 이유는 재확인 필요에만 붙는다. 판정으로 상태가 정해졌으면 처음 이유만 남긴다.
    return outcome.status === 'recheck'
      ? { ...rest, reason: outcome.reason, firstReason: reason }
      : { ...rest, ...outcome, firstReason: reason }
  })
}

/**
 * 이번 지적의 최종 관계 — 같은 결함인지 물은 지적에 그 판정을 얹는다. 렌더러와 스냅숏이 같은 함수를 쓴다.
 *
 * 같다고 하면 이전의 이름을 물려받아 이어지고, 다르다고 하면 신규다. 판정이 없으면 재확인 필요로 남는다.
 */
export function finalizeCurrent(lineage, identityVerdict) {
  if (!lineage || lineage.status !== 'recheck' || lineage.reason !== 'identity-unconfirmed') return lineage
  if (identityVerdict?.disposition === 'upheld') {
    return { status: 'linked', previousRef: lineage.previousRef, lineageId: lineage.previousLineageId, basis: 'identity' }
  }
  if (identityVerdict?.disposition === 'rejected') {
    return { status: 'new', lineageId: lineage.lineageId, fileChanged: lineage.fileChanged ?? null, ruleChanged: lineage.ruleChanged === true, differsFrom: lineage.previousRef }
  }
  return lineage
}

/** 상태별 수. */
export function countBy(entries, statuses) {
  return Object.fromEntries(statuses.map(status => [status, entries.filter(entry => entry.status === status).length]))
}

/**
 * 이전 HEAD와 지금 작업 트리 사이의 경로 변화. 그 커밋을 저장소에서 찾지 못하면 null이다.
 *
 * 이름 바꿈은 git의 대응(`-M`)을 따른다. 추적하지 않는 새 파일도 바뀐 것으로 센다. 리포트 디렉터리처럼
 * 대상 밖의 경로는 호출자가 걸러 본다.
 */
export function pathChanges(repo, fromCommit) {
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
  try {
    git(['cat-file', '-e', `${fromCommit}^{commit}`])
  } catch {
    return null
  }
  const renamed = new Map()
  const deleted = new Set()
  const changed = new Set()
  const fields = git(['diff', '-M', '--name-status', '-z', fromCommit]).split('\0')
  for (let at = 0; at < fields.length && fields[at]; ) {
    const status = fields[at]
    if (status.startsWith('R') || status.startsWith('C')) {
      const [from, to] = [fields[at + 1], fields[at + 2]]
      if (status.startsWith('R')) renamed.set(from, to)
      // 내용이 그대로인 이동(R100)은 바뀐 파일이 아니다 — 옮긴 파일의 지적은 이번 변경이 만든 것이 아니다.
      if (status !== 'R100') changed.add(to)
      at += 3
      continue
    }
    const path = fields[at + 1]
    if (status === 'D') deleted.add(path)
    else changed.add(path)
    at += 2
  }
  for (const path of git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) changed.add(path)
  return { renamed, deleted, changed }
}
