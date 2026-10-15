import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { posix } from 'node:path'

import { normalizeForCompare } from '../prepare-verification.mjs'
import { isExcludedPath } from './review-scope.mjs'

// 기존 구현 검색(C-6C)의 계산. 무엇을 찾을지(검색 계획)는 모델이 쓰고, 계획 검사·검색·원문 수집은 여기서 한다.
//
// 왜 스크립트인가: producer도 Grep을 쓸 수 있지만, 그러면 무엇을 어디서 찾았고 무엇을 못 찾았는지가 남지 않는다.
// "찾아봤는데 없었다"와 "찾아보지 않았다"가 리포트에서 같아진다. 그리고 문장으로만 시킨 절차는 지켜지지 않을 때가
// 있었다 — 스크립트가 강제한 수정만 재발하지 않았다(2026-10-14 대조). 검색은 고정된 commit에서 하고(`git grep
// <SHA>`), 원문도 그 commit에서 읽는다(`git show <SHA>:<path>`). 작업 트리와 섞지 않고 checkout·merge를 하지 않는다.
//
// 검색 결과는 후보일 뿐이다. 이름·문자열이 비슷하다는 것으로 같은 동작이라고 하지 않는다 — 그 판단은 05-7이 한다.

export const REUSE_SCHEMA_VERSION = 1

/**
 * 검색 상한. 큰 결과를 조용히 자르지 않도록 닿은 상한과 생략한 수를 결과에 남긴다. 값은 잠정치다 — 작은·큰 저장소
 * fixture에서 비용을 잰 뒤 고정한다(계획 C-6C).
 */
export const REUSE_LIMITS = Object.freeze({
  candidatesPerTarget: 5,
  candidatesTotal: 40,
  hitsPerQuery: 200,
  linesBefore: 3,
  linesAfter: 20,
  quoteLines: 40,
  quoteBytes: 4096,
  timeLimitSec: 300,
})

const nonEmpty = value => typeof value === 'string' && value.trim() !== ''
export const sha256 = text => createHash('sha256').update(text).digest('hex')

/**
 * 검색 계획을 검사한다. 문제가 하나라도 있으면 검색을 시작하지 않는다.
 *
 * `scope.files`의 모든 파일에 `search` 또는 사유가 있는 `exclude` 결정이 정확히 하나 있어야 한다 — 빠진 파일이
 * 있으면 "검색했는데 없었다"와 "그 파일은 보지 않았다"가 갈리지 않는다. 테스트·mock 같은 제외 파일은 preflight가
 * 이미 `excluded`에 셌으므로 계획에 두지 않는다. 결정이 사유로서 옳은지는 여기서 가리지 못한다(모델 평가의 몫).
 */
export function planProblems(plan, { scope, runId, head, mergeBase, searchId, scopeSha256 }) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return ['계획이 JSON 객체가 아니다']
  const problems = []
  if (plan.schemaVersion !== REUSE_SCHEMA_VERSION) problems.push(`계획의 schemaVersion이 ${REUSE_SCHEMA_VERSION}이 아니다(${JSON.stringify(plan.schemaVersion ?? null)})`)
  for (const [key, value] of Object.entries({ runId, searchId, head, mergeBase, scopeSha256 })) {
    if (plan[key] !== value) problems.push(`계획의 ${key}(${JSON.stringify(plan[key] ?? null)})가 이 실행(${JSON.stringify(value ?? null)})과 다르다`)
  }
  const files = Array.isArray(scope?.files) ? scope.files : []
  const inScope = new Set(files)
  const decisions = Array.isArray(plan.fileDecisions) ? plan.fileDecisions : null
  if (!decisions) problems.push('fileDecisions가 배열이 아니다')
  const targets = Array.isArray(plan.targets) ? plan.targets : null
  if (!targets) problems.push('targets가 배열이 아니다')

  const idCount = new Map()
  for (const target of targets ?? []) {
    if (!nonEmpty(target?.targetId)) {
      problems.push('targetId가 없는 대상이 있다')
      continue
    }
    idCount.set(target.targetId, (idCount.get(target.targetId) ?? 0) + 1)
  }
  for (const [id, count] of idCount) if (count > 1) problems.push(`targetId ${id}이 ${count}번 나온다`)

  const decisionCount = new Map()
  const chosenBy = new Map()
  for (const decision of decisions ?? []) {
    const path = decision?.path
    if (!nonEmpty(path)) {
      problems.push('path가 없는 결정이 있다')
      continue
    }
    decisionCount.set(path, (decisionCount.get(path) ?? 0) + 1)
    if (!inScope.has(path)) problems.push(`${path}는 scope.files에 없다 — 결정은 리뷰 대상 파일에만 둔다`)
    if (decision.decision === 'exclude') {
      if (!nonEmpty(decision.reason)) problems.push(`${path}의 제외 사유가 비었다`)
    } else if (decision.decision === 'search') {
      const ids = Array.isArray(decision.targetIds) ? decision.targetIds : []
      if (!ids.length) problems.push(`${path}는 search인데 대상이 없다`)
      for (const id of ids) {
        if (!idCount.has(id)) problems.push(`${path}가 없는 targetId ${id}를 가리킨다`)
        else chosenBy.set(id, path)
      }
    } else {
      problems.push(`${path}의 decision은 search나 exclude다(${JSON.stringify(decision.decision ?? null)})`)
    }
  }
  for (const path of files) {
    const count = decisionCount.get(path) ?? 0
    if (count === 0) problems.push(`${path}에 결정이 없다 — scope.files의 모든 파일에 search 또는 사유가 있는 exclude를 둔다`)
    if (count > 1) problems.push(`${path}의 결정이 ${count}개다`)
  }

  for (const target of targets ?? []) {
    if (!nonEmpty(target?.targetId)) continue
    const id = target.targetId
    const anchor = target.anchor
    const chosen = chosenBy.get(id)
    if (!chosen) problems.push(`${id}을 고른 search 결정이 없다`)
    else if (anchor?.path !== chosen) problems.push(`${id}의 anchor(${anchor?.path ?? '없음'})가 그 대상을 고른 파일의 결정과 맞지 않는다(${chosen})`)
    if (!Number.isInteger(anchor?.startLine) || !Number.isInteger(anchor?.endLine) || !nonEmpty(anchor?.quote)) problems.push(`${id}의 anchor에 줄 범위나 인용이 없다`)
    if (!nonEmpty(target.purpose)) problems.push(`${id}의 purpose가 비었다`)
    const queries = Array.isArray(target.queries) ? target.queries : []
    if (!queries.length) problems.push(`${id}에 검색어가 없다`)
    for (const query of queries) {
      if (!nonEmpty(query?.text)) problems.push(`${id}의 검색어가 비었다`)
      const paths = query?.paths
      if (paths !== undefined && (!Array.isArray(paths) || !paths.every(nonEmpty) || paths.some(path => path.split(/[\\/]/).includes('..')))) {
        problems.push(`${id}의 검색 경로가 저장소 안의 경로 목록이 아니다`)
      }
    }
  }
  return problems
}

/** `git diff -U0`의 hunk 머리에서 새 쪽(HEAD) 줄 범위를 읽는다. 줄 수 0인 hunk(삭제만)는 새 쪽 범위가 없다. */
export function changedRanges(diffText) {
  const ranges = []
  for (const line of String(diffText ?? '').split('\n')) {
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (!match) continue
    const start = Number(match[1])
    const count = match[2] === undefined ? 1 : Number(match[2])
    if (count > 0) ranges.push({ start, end: start + count - 1 })
  }
  return ranges
}

const linesOf = text => {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  if (lines.length && lines.at(-1) === '') lines.pop()
  return lines
}

/** 검색 대상의 anchor가 HEAD의 실제 줄·인용과 맞고, 이번 변경(새 쪽 범위)에 닿는지 본다. */
export function anchorProblems(target, { headText, ranges }) {
  const id = target?.targetId ?? '?'
  const anchor = target?.anchor ?? {}
  if (typeof headText !== 'string') return [`${id}의 anchor 파일(${anchor.path})을 HEAD에서 읽지 못했다`]
  const lines = linesOf(headText)
  const { startLine: start, endLine: end } = anchor
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) {
    return [`${id}의 anchor 줄 범위가 파일 밖이다(${start}–${end}, 파일 ${lines.length}줄)`]
  }
  const problems = []
  if (normalizeForCompare(lines.slice(start - 1, end).join('\n')) !== normalizeForCompare(anchor.quote)) {
    problems.push(`${id}의 anchor 인용이 HEAD와 다르다(${anchor.path}:${start}–${end})`)
  }
  if (!(ranges ?? []).some(range => range.start <= end && start <= range.end)) {
    problems.push(`${id}의 anchor(${anchor.path}:${start}–${end})가 이번 변경에 닿지 않는다 — 검색 대상은 diff가 추가하거나 바꾼 구현이다`)
  }
  return problems
}

/** `git grep -n -z`의 출력(`<rev>:<path>\0<줄>\0<내용>`)을 나눈다. 경로는 인용되지 않는다. */
export function parseGrepOutput(stdout, rev) {
  const hits = []
  for (const raw of String(stdout ?? '').split('\n')) {
    if (!raw) continue
    const first = raw.indexOf('\0')
    const second = raw.indexOf('\0', first + 1)
    if (first === -1 || second === -1) continue
    const head = raw.slice(0, first)
    const path = head.startsWith(`${rev}:`) ? head.slice(rev.length + 1) : head
    const line = Number(raw.slice(first + 1, second))
    if (!Number.isInteger(line)) continue
    hits.push({ path, line, text: raw.slice(second + 1).replace(/\r$/, '') })
  }
  return hits
}

/** 같은 파일의 hit 줄들을 앞뒤 여유를 둔 구간으로 묶는다. 구간 길이에는 상한이 있고, 넘으면 잘린 것을 표시한다. */
export function candidateWindows(hitLines, totalLines, { linesBefore, linesAfter, quoteLines }) {
  const hits = [...new Set(hitLines)].filter(line => Number.isInteger(line) && line >= 1).sort((a, b) => a - b)
  const windows = []
  for (const hit of hits) {
    const start = Math.max(1, hit - linesBefore)
    const end = Math.min(totalLines, hit + linesAfter)
    const last = windows.at(-1)
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end)
      last.hits.push(hit)
    } else {
      windows.push({ start, end, hits: [hit] })
    }
  }
  return windows.map(window => (window.end - window.start + 1 > quoteLines
    ? { ...window, end: window.start + quoteLines - 1, truncated: true }
    : window))
}

/** 대상별 상태를 센다. 0인 상태는 싣지 않는다. */
export function summarizeTargets(targets) {
  const counts = {}
  for (const target of targets ?? []) counts[target.status] = (counts[target.status] ?? 0) + 1
  return counts
}

/** 검색 전체의 상태. 계획이 틀리면 `failed`, 대상이 없으면 `not-applicable`. */
export function overallStatus(targets, { planOk }) {
  if (!planOk) return 'failed'
  if (!targets?.length) return 'not-applicable'
  if (targets.every(target => target.status === 'failed')) return 'failed'
  if (targets.every(target => target.status === 'complete')) return 'complete'
  return 'partial'
}

/**
 * 저장소의 git을 인자 배열로만 부른다. 셸 문자열을 조립하지 않는다 — 검색어에 따옴표·괄호가 들어도 그대로 넘어간다.
 * grep의 종료 코드 1은 "찾지 못했다"이지 실패가 아니다. 그 밖의 실패는 사유와 함께 돌려준다.
 */
export function gitReader(repo) {
  const run = (args, { noMatchIsEmpty = false } = {}) => {
    try {
      return { ok: true, out: execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) }
    } catch (error) {
      if (noMatchIsEmpty && error.status === 1 && !String(error.stderr ?? '').trim()) return { ok: true, out: '' }
      return { ok: false, error: String(error.stderr || error.message).trim().split('\n')[0] || 'git 실패' }
    }
  }
  const shown = new Map()
  return {
    root: () => {
      const out = run(['rev-parse', '--show-toplevel'])
      return out.ok ? out.out.trim() : null
    },
    show(rev, path) {
      const key = `${rev}\0${path}`
      if (!shown.has(key)) {
        const out = run(['show', `${rev}:${path}`])
        shown.set(key, out.ok ? out.out : null)
      }
      return shown.get(key)
    },
    grep: (rev, text, paths) => run(['grep', '-n', '-z', '-F', '-I', '--full-name', '-e', text, rev, '--', ...(paths?.length ? paths : ['.'])], { noMatchIsEmpty: true }),
    diff: (from, to, path) => run(['diff', '-U0', '--no-color', '--no-ext-diff', from, to, '--', path]),
  }
}

/** 첫 검색 범위 — anchor 파일이 있는 디렉터리의 부모(같은 기능·도메인 묶음). 없으면 저장소 전체. */
const nearbyScope = path => {
  const dir = posix.dirname(path)
  const parent = posix.dirname(dir)
  return parent === '.' || parent === '' ? (dir === '.' ? '.' : dir) : parent
}

const truncateBytes = (lines, maxBytes) => {
  let kept = lines
  while (kept.length > 1 && Buffer.byteLength(kept.join('\n'), 'utf8') > maxBytes) kept = kept.slice(0, -1)
  return { lines: kept, truncated: kept.length < lines.length }
}

/**
 * 계획의 대상 하나를 검색해 후보를 모은다.
 *
 * - 검색어는 고정 문자열이다(`-F`). 경로를 주지 않은 검색어는 anchor 근처에서 먼저 찾고, 그 대상의 후보가 하나도
 *   없을 때만 저장소 전체로 넓힌다 — 넓혀도 검색어는 변경에서 나온 단서뿐이다(00-3)
 * - HEAD를 먼저, base가 merge-base 뒤로 앞서 나갔으면 그 끝(baseHead)에서도 찾는다. 같은 원문은 하나로 묶고 출처를
 *   모두 남긴다. base에만 있는 구현은 `onlyInBase`로 표시한다 — 병합 결과를 보기 전에는 공존으로 확정하지 않는다
 * - 대상 자신(같은 파일·anchor 범위의 hit)은 뺀다. 같은 파일의 다른 구현은 남긴다
 * - HEAD 후보는 merge-base에도 같은 원문이 있었는지(`existedAtMergeBase`)를 적는다 — 없으면 이번 변경이 함께 더한 것이다
 * - 테스트·mock 경로의 후보는 `kind: test`로 production 후보와 가른다
 */
export function searchTarget(target, { git, head, mergeBase, baseHead, limits, deadline, budget }) {
  const anchor = target.anchor
  const revs = [{ rev: head, sourceRef: 'head' }, ...(baseHead && baseHead !== mergeBase && baseHead !== head ? [{ rev: baseHead, sourceRef: 'base' }] : [])]
  const errors = []
  const reached = new Set()
  const byFile = new Map()
  const queries = []
  let omittedHits = 0
  let grepsDone = 0
  const collect = (rev, sourceRef, hits, text) => {
    for (const hit of hits) {
      if (sourceRef === 'head' && hit.path === anchor.path && hit.line >= anchor.startLine && hit.line <= anchor.endLine) continue
      const key = `${sourceRef}\0${hit.path}`
      if (!byFile.has(key)) byFile.set(key, { rev, sourceRef, path: hit.path, lines: new Set(), clues: new Set() })
      byFile.get(key).lines.add(hit.line)
      byFile.get(key).clues.add(text)
    }
  }
  for (const query of target.queries) {
    const scopes = query.paths?.length ? [query.paths] : [[nearbyScope(anchor.path)], ['.']]
    const record = { text: query.text, ...(query.paths ? { paths: query.paths } : {}), searched: [], hits: 0 }
    for (const [at, paths] of scopes.entries()) {
      if (at > 0 && byFile.size > 0) break
      if (Date.now() > deadline) {
        reached.add('time')
        break
      }
      record.searched.push(paths)
      for (const { rev, sourceRef } of revs) {
        const out = git.grep(rev, query.text, paths)
        if (!out.ok) {
          errors.push(`검색어 ${JSON.stringify(query.text)}(${sourceRef}) — ${out.error}`)
          continue
        }
        grepsDone += 1
        let hits = parseGrepOutput(out.out, rev)
        if (hits.length > limits.hitsPerQuery) {
          omittedHits += hits.length - limits.hitsPerQuery
          reached.add('hits')
          hits = hits.slice(0, limits.hitsPerQuery)
        }
        record.hits += hits.length
        collect(rev, sourceRef, hits, query.text)
      }
    }
    queries.push(record)
  }

  // 후보 구간과 원문 — 같은 commit에서 읽는다
  const found = []
  for (const file of byFile.values()) {
    const text = git.show(file.rev, file.path)
    if (typeof text !== 'string') {
      errors.push(`${file.path}(${file.sourceRef})를 읽지 못했다`)
      continue
    }
    const lines = linesOf(text)
    for (const window of candidateWindows([...file.lines], lines.length, limits)) {
      const sliced = truncateBytes(lines.slice(window.start - 1, window.end), limits.quoteBytes)
      const quote = sliced.lines.join('\n')
      found.push({
        sourceRef: file.sourceRef, rev: file.rev, path: file.path, startLine: window.start, endLine: window.start + sliced.lines.length - 1,
        quote, sha256: sha256(quote), clues: [...file.clues].sort(), hitLines: window.hits, kind: isExcludedPath(file.path) ? 'test' : 'production',
        ...(window.truncated || sliced.truncated ? { truncated: true } : {}),
      })
    }
  }
  // HEAD와 base의 같은 원문은 하나로 묶는다
  const merged = new Map()
  for (const candidate of found) {
    const key = `${candidate.path}\0${normalizeForCompare(candidate.quote)}`
    const seen = merged.get(key)
    if (seen) {
      seen.sourceRefs = [...new Set([...seen.sourceRefs, candidate.sourceRef])]
      seen.clues = [...new Set([...seen.clues, ...candidate.clues])].sort()
    } else {
      merged.set(key, { ...candidate, sourceRefs: [candidate.sourceRef] })
    }
  }
  let candidates = [...merged.values()].map(candidate => {
    const { sourceRef, ...rest } = candidate
    const inHead = candidate.sourceRefs.includes('head')
    const base = git.show(mergeBase, candidate.path)
    const existedAtMergeBase = typeof base === 'string' && normalizeForCompare(base).includes(normalizeForCompare(candidate.quote))
    return { ...rest, sourceRef: inHead ? 'head' : 'base', ...(inHead ? { existedAtMergeBase } : { onlyInBase: true }) }
  })
  // production 먼저, hit가 많은 것 먼저
  candidates.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'production' ? -1 : 1) || b.hitLines.length - a.hitLines.length || a.path.localeCompare(b.path) || a.startLine - b.startLine)
  let omittedCandidates = 0
  const cap = Math.min(limits.candidatesPerTarget, Math.max(0, budget.remaining))
  if (candidates.length > cap) {
    omittedCandidates = candidates.length - cap
    reached.add(cap < limits.candidatesPerTarget ? 'candidates-total' : 'candidates')
    candidates = candidates.slice(0, cap)
  }
  budget.remaining -= candidates.length
  candidates = candidates.map((candidate, at) => ({ candidateId: `${target.targetId}.c${at + 1}`, ...candidate }))

  // 한 번도 검색하지 못했으면 실패, 일부만 했거나 상한에 닿았으면 부분, 계획을 다 했으면 완료다. 완료는 "같은 구현이
  // 없다"는 보장이 아니다 — 후보 0건도 완료일 수 있다.
  const status = grepsDone === 0 ? 'failed' : errors.length || reached.size ? 'partial' : 'complete'
  return {
    targetId: target.targetId, anchor, purpose: target.purpose, queries, status, candidates,
    ...(reached.size || omittedHits || omittedCandidates ? { limits: { reached: [...reached].sort(), ...(omittedHits ? { omittedHits } : {}), ...(omittedCandidates ? { omittedCandidates } : {}) } } : {}),
    ...(errors.length ? { errors } : {}),
  }
}
