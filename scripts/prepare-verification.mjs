import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { writeTextAtomic } from './lib/atomic-write.mjs'
import { markedBlock } from './lib/contract-blocks.mjs'
import { intentBlock, intentProblems } from './lib/intent.mjs'
import { CURRENT_STATUSES, countBy, enclosingSymbol, identityPending, linkFindings, pathChanges, recheckable } from './lib/review-compare.mjs'
import { parseSnapshot } from './lib/review-snapshot.mjs'
import { ruleDocDigests, rulesDigest } from './lib/run-identity.mjs'
import { logPhase, moduleOutcomes, readEvents, requireStartedTimeline } from './lib/run-record.mjs'
import {
  buildIdentityPrompt, buildRecheckPrompt, buildTaskPrompt, claimOf, docPathForRule, extractClause, instructionsWithManifest, planVerifierTasks,
} from './lib/verifier-tasks.mjs'

// Deterministic preparation for the cross-verification pass.
//
// Everything here runs without a sub-agent. The orchestrator calls it before
// dispatching verifiers so that location checking, eligibility and routing are
// decided by code rather than by a model reading Markdown instructions.
//
// Blob access is injected so the module stays hermetic under test:
//   blobs = { head: { path: contents }, base: { path: contents } }

const HIGH_STAKES_CATEGORIES = new Set(['security-exposure', 'data-loss', 'external-breakage'])

/**
 * A rule id the report can trace back to a rule document.
 *
 * `00-rule.md` 00-2 fixes the shapes: `NN-n` for numbered modules, `10-{ABBREV}`
 * for principles, and the `EX-`/`P-`/`A-`/`C-` namespaces for specialist docs
 * and the correctness agent.
 */
const RULE_ID = /^(?:\d{2}-(?:\d+|[A-Za-z][A-Za-z0-9]*)|(?:EX|P|A|C|CR)-\d+)$/

// A producer that finds one rule violated three times sometimes numbers the
// instances into the id itself — `17-3 (1/3)`, `(2/3)`, `(3/3)`. Observed in a
// 2.8.0 run. The damage is that the three stop being the same rule: they group
// apart, dedup cannot see them as duplicates, and the ids reach the report as
// `17-3 (1/3)#1`, which no rule document contains.
//
// Instance numbering already has a home — `candidateId` is `{ruleId}#{n}` and this
// module assigns it. So the marker is stripped rather than honored.
const INSTANCE_MARKER = /\s*\(\d+\s*\/\s*\d+\)\s*$/

/**
 * Normalize a line or span before comparison.
 *
 * Line endings collapse to LF and the ends are trimmed, but **internal
 * whitespace is preserved** — collapsing it would make `"x  y"` and `"x y"`
 * compare equal, which is exactly the class of difference a location check
 * exists to catch.
 */
export function normalizeForCompare(text) {
  return String(text ?? '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .trim()
}

function locationSpan(location) {
  if (location.kind === 'verified') return { start: location.line, end: location.endLine ?? location.line }
  return { start: location.lineBefore, end: location.endLine ?? location.lineBefore }
}

/**
 * Compare a location's quote against the blob it claims to come from.
 *
 * `verified` locations are read from HEAD and `deleted` locations from the
 * merge base. Getting that branch wrong would make every honest re-anchor of a
 * deleted file fail, so the two are kept apart here rather than at the call site.
 */
export function checkLocation(location, blobs) {
  if (!location || typeof location !== 'object') return { status: 'location-unresolvable', reason: 'location is not an object' }
  if (location.kind === 'unverified') return { status: 'not-applicable' }

  const source = location.kind === 'deleted' ? blobs?.base : blobs?.head
  const contents = source?.[location.path]
  if (typeof contents !== 'string') {
    const ref = location.kind === 'deleted' ? 'MERGE_BASE' : 'HEAD'
    return { status: 'location-unresolvable', reason: `${location.path} is not readable at ${ref}` }
  }

  const lines = contents.replace(/\r\n?/g, '\n').split('\n')
  const { start, end } = locationSpan(location)
  if (!Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < start || end > lines.length) {
    return { status: 'location-mismatch', observed: null, reason: 'line range is outside the file' }
  }

  const observed = normalizeForCompare(lines.slice(start - 1, end).join('\n'))
  if (observed === normalizeForCompare(location.quote)) return { status: 'location-ok', observed }
  return { status: 'location-mismatch', observed }
}

function collisionKey(location) {
  if (!location || typeof location !== 'object') return null
  if (location.kind === 'verified') return `v:${location.path}:${location.line}`
  if (location.kind === 'deleted') return `d:${location.path}:${location.lineBefore}`
  return null
}

/**
 * Candidate ids that share a normalized location with a **different** rule.
 *
 * The same rule reported twice at one place is a duplicate for exact dedup to
 * settle, not a signal that two owners disagree about the same code.
 */
export function computeOwnerCollisions(candidates) {
  const byLocation = new Map()
  for (const candidate of candidates ?? []) {
    const key = collisionKey(candidate.location)
    if (!key) continue
    if (!byLocation.has(key)) byLocation.set(key, [])
    byLocation.get(key).push(candidate)
  }
  const collided = new Set()
  for (const group of byLocation.values()) {
    const rules = new Set(group.map(candidate => candidate.ruleId))
    if (rules.size < 2) continue
    for (const candidate of group) collided.add(candidate.candidateId)
  }
  return collided
}

/**
 * 같은 정규화 위치에 걸린 지적 중 **namespace가 다른 것**을 서로 잇는다.
 *
 * correctness 패스(`CR-*`)와 규칙 모듈이 같은 자리를 지적하면, 둘은 근거가 다르다 —
 * 하나는 의도와 경로, 하나는 규칙 문장이다. exact dedup은 규칙 ID가 같아야 병합하므로
 * 둘은 합쳐지지 않고, 합쳐서도 안 된다: 같은 결함인지 입증할 규칙이 아직 없다(#88).
 * 그렇다고 따로 두기만 하면 읽는 사람이 같은 자리의 두 지적을 서로 모른 채 읽는다.
 * 그래서 합치지 않고 잇기만 한다. 각자의 출처와 판정은 그대로다.
 *
 * `prefixes`는 이을 namespace다(조항이 없는 패스의 접두, catalog의 `ruleClauses: false`).
 * 규칙 모듈끼리의 같은 자리는 `ownerCollision`이 이미 다루므로 여기서 잇지 않는다.
 */
export function relatedAcrossNamespaces(candidates, prefixes) {
  const linked = new Map()
  if (!prefixes.length) return linked
  const namespaceOf = candidate => {
    const prefix = String(candidate.ruleId ?? '').split('-')[0]
    return prefixes.includes(prefix) ? prefix : null
  }
  const byLocation = new Map()
  for (const candidate of candidates ?? []) {
    const key = collisionKey(candidate.location)
    if (!key) continue
    if (!byLocation.has(key)) byLocation.set(key, [])
    byLocation.get(key).push(candidate)
  }
  for (const group of byLocation.values()) {
    for (const candidate of group) {
      const own = namespaceOf(candidate)
      // 적어도 한쪽이 이을 namespace여야 하고, 둘의 namespace가 달라야 한다.
      const others = group
        .filter(other => other !== candidate && namespaceOf(other) !== own && (own !== null || namespaceOf(other) !== null))
        .map(other => other.candidateId)
        .sort()
      if (others.length) linked.set(candidate.candidateId, others)
    }
  }
  return linked
}

function eligibilityReasons({ candidate, locationCheck, ownerCollision }) {
  const reasons = []
  if (candidate?.impact === 'high') reasons.push('impact-high')
  if (candidate?.confidence === 'low') reasons.push('confidence-low')
  if (candidate?.location?.kind === 'unverified') reasons.push('location-unverified')
  if (locationCheck === 'location-mismatch' || locationCheck === 'location-unresolvable') reasons.push('location-check-failed')
  if (ownerCollision) reasons.push('owner-collision')
  if (HIGH_STAKES_CATEGORIES.has(candidate?.category)) reasons.push('category-high-stakes')
  return reasons
}

/**
 * Decide whether a candidate gets verified at all. Five schema fields plus the two derived signals — no model involved.
 *
 * `exhaustive` (`--verify exhaustive`) verifies every candidate. A candidate that had a
 * reason keeps it; one that had none is marked `exhaustive`, so the routed output still
 * says why each candidate was sent rather than leaving an empty reason list next to VERIFY.
 */
export function decideEligibility(input, options = {}) {
  const reasons = eligibilityReasons(input)
  if (options.exhaustive && reasons.length === 0) reasons.push('exhaustive')
  return { eligibility: reasons.length > 0 ? 'VERIFY' : 'SKIP-VERIFY', reasons }
}

/**
 * Send an eligible candidate to a shared bundle or to isolated verification.
 *
 * Isolation wins whenever the anchor file alone cannot settle the claim. The
 * approximation is deliberately conservative: over-isolating costs tokens,
 * while under-isolating can produce a wrong rejection that no later step undoes.
 */
export function routeCandidate(input, options = {}) {
  const { candidate, locationCheck, ownerCollision } = input
  const { eligibility, reasons } = decideEligibility(input, options)
  if (eligibility === 'SKIP-VERIFY') return { route: 'none', reasons }

  const isolationReasons = []
  if (candidate?.location?.kind !== 'verified') isolationReasons.push(`location-${candidate?.location?.kind}`)
  if (locationCheck === 'location-mismatch' || locationCheck === 'location-unresolvable') isolationReasons.push('location-check-failed')
  if (ownerCollision) isolationReasons.push('owner-collision')
  if (HIGH_STAKES_CATEGORIES.has(candidate?.category)) isolationReasons.push('category-high-stakes')

  if (isolationReasons.length > 0) return { route: 'isolated', reasons: isolationReasons }
  return { route: 'bundle', reasons }
}

/** Group bundle-routed candidates by anchor file. A file with none produces no bundle, so no agent is spawned for it. */
export function buildBundles(routed) {
  const byPath = new Map()
  for (const entry of routed ?? []) {
    if (entry.route !== 'bundle') continue
    const path = entry.location?.path
    if (typeof path !== 'string') continue
    if (!byPath.has(path)) byPath.set(path, [])
    byPath.get(path).push(entry.candidateId)
  }
  return [...byPath.entries()].map(([anchorPath, candidateIds]) => ({ anchorPath, candidateIds }))
}

/**
 * Location checking with nothing else attached.
 *
 * `/code-review` has no rebuttal pass, so returning eligibility, routes or bundles here
 * would let a report read as though one had run. What it needs is narrower: did the
 * quoted line survive contact with the file.
 */
function locationsOnly(candidates, blobs) {
  const checked = candidates.map(candidate => {
    const check = checkLocation(candidate.location, blobs)
    return {
      candidateId: candidate.candidateId,
      ruleId: candidate.ruleId,
      locationCheck: check.status,
      observed: check.observed ?? null,
      reason: check.reason ?? null,
      location: candidate.location,
    }
  })
  const count = status => checked.filter(entry => entry.locationCheck === status).length
  return {
    candidates: checked,
    counts: {
      total: checked.length,
      locationOk: count('location-ok'),
      locationMismatch: count('location-mismatch'),
      locationUnresolvable: count('location-unresolvable'),
      locationNotApplicable: count('not-applicable'),
    },
  }
}

/**
 * Run the whole deterministic preparation in one call and report counts alongside it.
 *
 * The counts exist so the report cannot claim a coverage split that does not add up:
 * verify + skipVerify always equals total, and bundle + isolated always equals verify.
 * Deriving them here rather than in prose is the point — a hand-written tally is exactly
 * what drifted before.
 */
export function prepareVerification(candidates, blobs, options = {}) {
  const list = candidates ?? []
  if (options.locationsOnly) return locationsOnly(list, blobs)
  const collisions = computeOwnerCollisions(list)
  const related = relatedAcrossNamespaces(list, options.linkPrefixes ?? [])
  const decided = list.map(candidate => {
    const check = checkLocation(candidate.location, blobs)
    const input = { candidate, locationCheck: check.status, ownerCollision: collisions.has(candidate.candidateId) }
    const { eligibility, reasons } = decideEligibility(input, options)
    const { route } = routeCandidate(input, options)
    return {
      candidateId: candidate.candidateId,
      ruleId: candidate.ruleId,
      locationCheck: check.status,
      observed: check.observed ?? null,
      ownerCollision: collisions.has(candidate.candidateId),
      eligibility,
      reasons,
      route,
      // 축(impact/confidence/category)은 그동안 checkLocation·decideEligibility의
      // 입력으로만 쓰이고 출력에는 없었다. 렌더러가 같은 배열을 --input으로 받아
      // 등급을 매기므로(Task 3), 여기서 빠지면 렌더 단계에서 등급을 만들 수 없다.
      impact: candidate.impact,
      confidence: candidate.confidence,
      category: candidate.category,
      location: candidate.location,
      content: candidate.content,
      // candidatesFromResults가 실어 보낸 provenance 필드를 여기서 다시
      // 빠뜨리면(계약 203·244행) candidate는 candidatesFromResults 직후에는
      // memberInstanceIds·source·sources를 갖고 있다가 이 projection을
      // 지나는 순간 잃는다 — canonical candidate ↔ producer instance
      // 관계와 병합된 출처 패스가 렌더 단계에 아예 도달하지 못한다.
      memberInstanceIds: candidate.memberInstanceIds ?? [],
      ...(candidate.source !== undefined ? { source: candidate.source } : {}),
      ...(candidate.sources !== undefined ? { sources: candidate.sources } : {}),
      ...(related.has(candidate.candidateId) ? { relatedCandidateIds: related.get(candidate.candidateId) } : {}),
    }
  })

  const counts = {
    total: decided.length,
    verify: decided.filter(entry => entry.eligibility === 'VERIFY').length,
    skipVerify: decided.filter(entry => entry.eligibility === 'SKIP-VERIFY').length,
    bundle: decided.filter(entry => entry.route === 'bundle').length,
    isolated: decided.filter(entry => entry.route === 'isolated').length,
    locationMismatch: decided.filter(entry => entry.locationCheck === 'location-mismatch').length,
    locationUnresolvable: decided.filter(entry => entry.locationCheck === 'location-unresolvable').length,
    // 병합된 건수와 수리한 rule id를 숨기지 않는다. 후보 수가 줄어든 이유가
    // 리포트에 보이지 않으면, 읽는 사람은 producer가 덜 찾은 것으로 읽는다.
    dedupMerged: candidates?.dedupMerged ?? 0,
    ruleIdRepairs: candidates?.ruleIdRepairs ?? [],
  }

  return { candidates: decided, bundles: buildBundles(decided), counts }
}

// ---------------------------------------------------------------------- CLI
//
//   node scripts/prepare-verification.mjs --merge-base <sha> --dir <d> --run <r> --collect
//   node scripts/prepare-verification.mjs --merge-base <sha> --dir <d> --run <r> --input candidates.json
//   node scripts/prepare-verification.mjs --merge-base <sha> --dir <d> --run <r> < candidates.json
//
// --collect      : gather `<d>/.timing/<r>.<module>.json` — each producer result written
//                  verbatim as it arrived — against the timeline's `module.done` records.
//                  `/code-review-full` uses this; the orchestrator never assembles an
//                  envelope by hand. Cannot be combined with --input.
// --rules <dir>  : the RULES_DIR the producers read (catalog, module docs, verifier
//                  template, verdict manifest). Defaults to this plugin's review-rules.
// --verify off   : no verifier prompt files and no `crossverify.start`. Default selective.
// --verify exhaustive : every candidate is a verification target (reason `exhaustive` when
//                  it had none); bundle/isolated routing is unchanged. The audit sidecar
//                  stays the orchestrator's job (contract C-6B).
// --discard-verdicts : the prompt directory already holds `*.verdict.json` from this run;
//                  without this flag the script refuses rather than wipe them. Resuming a
//                  run uses `tally-verdicts.mjs --validate` instead of preparing again.
//
// Unless --locations-only or --verify off, one prompt file per verifier task is written to
// `<d>/.timing/<r>.verify/` and listed as `verifierTasks` / `promotions`, each with the
// `verdict` path the orchestrator writes the verifier's JSON to. `crossverify.start` is
// logged here when there is at least one task.
//
// --input <path> : read the payload from a file. **Prefer this.** The payload carries
//                  prose, code quotes and Windows paths, and a shell that has to hold
//                  all of it inside one pair of quotes is the part that breaks — one
//                  run failed the documented pipe twice before working around it.
//                  With a path, the shell only ever sees the path.
//
// stdin  : { "results": [ <REVIEW_RESULT_CONTRACT_V1>, … ] }   the same payload, piped
//          { "locations": [ {ruleId, path, line, quote}, … ] }  light form for a
//                                                              consolidated pass
//          { "candidates": [ … ] }                            when the caller owns the ids
// stdout : { "candidates": [ … ], "bundles": [ … ], "counts": { … },
//            "verifierTasks": [ … ], "promotions": { … }, "collected": { … } (--collect) }
//
// --locations-only : location checks and their counts, with no eligibility, route or
//                    bundle. For workflows that have no rebuttal pass.
//
// Blobs are read here rather than passed in, so the caller does not have to
// serialize file contents and cannot accidentally supply the wrong revision.

/**
 * Gather the file contents each location claims to come from.
 *
 * A verified location is read from the working tree first, because that is what the
 * producer read when it recorded the line. Reading HEAD instead makes every uncommitted
 * edit look like a wrong line number, which would discredit the check rather than the
 * finding. HEAD remains the fallback for paths that are not on disk.
 *
 * A deleted location can only come from the merge base — the point of it is that the code
 * is gone from HEAD.
 */
export function collectBlobs(candidates, readers) {
  const head = {}
  const base = {}
  for (const candidate of candidates ?? []) {
    const location = candidate?.location
    const path = location?.path
    if (typeof path !== 'string') continue
    if (location.kind === 'deleted') {
      if (!(path in base)) base[path] = readers.base(path)
    } else if (!(path in head)) {
      head[path] = readers.working(path) ?? readers.head(path)
    }
  }
  return { head, base }
}

/**
 * Resolve a producer-supplied path inside the repository, or refuse it.
 *
 * These paths come from model output, so reading one straight off disk turns a finding
 * into an arbitrary local file read — and the line that comes back is echoed as `observed`.
 * Reading through `git show` was contained by accident, because git refuses paths outside
 * its tree; reading the working tree has to be contained on purpose.
 */
export function resolveWithinRoot(candidatePath, root) {
  if (typeof candidatePath !== 'string' || candidatePath === '') return null
  if (isAbsolute(candidatePath)) return null
  const segments = candidatePath.split('/').flatMap(part => part.split('\\')).filter(Boolean)
  if (segments.includes('..')) return null
  // Segment comparison, not a string prefix — .github is not .git.
  if (segments[0] === '.git') return null
  // 루트도 같은 꼴로 맞춘다. Windows의 `git rev-parse --show-toplevel`은 `C:/…`를 돌려주고 `resolve()`는
  // `C:\…`를 만든다 — 그대로 비교하면 작업 트리 읽기가 늘 실패하고, 호출자는 HEAD blob으로 조용히 물러섰다.
  const base = resolve(root)
  const resolved = resolve(base, candidatePath)
  const prefix = base.endsWith(sep) ? base : base + sep
  return resolved.startsWith(prefix) ? resolved : null
}

let REPO_ROOT_CACHE = null

function repoRoot() {
  if (REPO_ROOT_CACHE) return REPO_ROOT_CACHE
  try {
    REPO_ROOT_CACHE = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    REPO_ROOT_CACHE = process.cwd()
  }
  return REPO_ROOT_CACHE
}

function gitReaders(mergeBase) {
  const show = ref => {
    try {
      // A missing path is an expected outcome, not a problem to report on stderr.
      return execFileSync('git', ['show', ref], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return undefined
    }
  }
  return {
    working: path => {
      const resolved = resolveWithinRoot(path, repoRoot())
      if (!resolved) return undefined
      try {
        return readFileSync(resolved, 'utf8')
      } catch {
        return undefined
      }
    },
    head: path => show(`HEAD:${path}`),
    base: path => show(`${mergeBase}:${path}`),
  }
}

/**
 * `source`로 쓸 수 있는 이름 — 규칙 문서 파일명에서 `.md`를 뗀 값.
 *
 * catalog가 그 목록의 유일한 선언처다. 여기에 손으로 옮겨 두면 모듈이 늘 때
 * 이쪽만 낡는다.
 */
export function loadSourceNames(rulesDir) {
  let catalog
  try {
    catalog = JSON.parse(readFileSync(join(rulesDir, 'catalog.json'), 'utf8'))
  } catch (error) {
    return { error: `catalog.json을 읽지 못했다: ${join(rulesDir, 'catalog.json')} — ${error.message}` }
  }
  const names = (catalog.modules ?? [])
    .filter(module => module.role === 'module' || module.role === 'specialist')
    .map(module => String(module.path ?? '').replace(/\.md$/, ''))
    .filter(Boolean)
  return { value: new Set(names) }
}

const ENVELOPE_KEYS = new Set(['source', 'result'])

/**
 * 입력의 모양을 받기 전에 본다. 문제가 없으면 빈 배열이다.
 *
 * 받는 모양은 넷이다: `{ results }`(producer 결과 또는 envelope), `{ candidates }`,
 * `{ locations }`, 그리고 ID가 이미 붙은 후보의 루트 배열. 어느 것에도 맞지 않는
 * 입력을 후보 0건으로 흘려보내면 검증 대상이 통째로 사라지는데, 출력은 정상
 * 실행과 똑같이 생겼다.
 *
 * envelope는 `source`와 `result`만 갖는다. `source`는 오케스트레이터가 디스패치
 * 기록에서 채우는 값이라, 계약 밖 이름(`sourcePass`)이나 규칙 문서에 없는 이름
 * (`01`)은 그 기록과 이 후보를 이어 주지 못한다.
 */
export function payloadProblems(payload, sourceNames) {
  const problems = []
  if (Array.isArray(payload)) {
    const missing = payload.filter(entry => typeof entry?.candidateId !== 'string').length
    if (missing) {
      problems.push(`루트 배열은 이미 ID가 붙은 후보만 받는다 — ${payload.length}개 중 ${missing}개에 candidateId가 없다. producer 결과는 {"results":[{"source":"<규칙 문서 이름>","result":{…}}]}로 감싼다`)
    }
    return problems
  }
  if (!payload || typeof payload !== 'object') return ['입력이 객체도 배열도 아니다']
  const shapes = ['results', 'candidates', 'locations'].filter(key => key in payload)
  if (!shapes.length) {
    return [`알아보는 키가 없다: ${JSON.stringify(Object.keys(payload))}. results · candidates · locations 중 하나로 넘긴다`]
  }
  for (const key of shapes) {
    if (!Array.isArray(payload[key])) problems.push(`${key}가 배열이 아니다`)
  }
  ;(Array.isArray(payload.results) ? payload.results : []).forEach((entry, at) => {
    const where = `results[${at}]`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`${where}가 객체가 아니다`)
      return
    }
    if (!('result' in entry)) {
      if (!Array.isArray(entry.findings)) problems.push(`${where}는 envelope({source,result})도 producer 결과(findings 배열)도 아니다`)
      return
    }
    const extra = Object.keys(entry).filter(name => !ENVELOPE_KEYS.has(name))
    if (extra.length) problems.push(`${where} envelope에 계약 밖 키가 있다: ${extra.join(', ')}. 쓸 수 있는 키: source, result`)
    if (!sourceNames.has(entry.source)) {
      problems.push(`${where}.source ${JSON.stringify(entry.source)}는 규칙 문서 이름이 아니다. 쓸 수 있는 이름: ${[...sourceNames].join(', ')}`)
    }
    if (!entry.result || typeof entry.result !== 'object' || !Array.isArray(entry.result.findings)) {
      problems.push(`${where}.result에 findings 배열이 없다`)
    }
  })
  return problems
}

/**
 * 조항이 없는 패스(catalog의 `ruleClauses: false`)의 출처 → 접두.
 *
 * 그 패스의 ID(`CR-{n}`)는 지적의 순번이지 규칙 조항이 아니다. 출처와 ID가 서로 맞아야
 * 그 사실을 뒤의 단계(검증자 프롬프트·렌더)가 믿고 쓸 수 있다.
 */
export function clauselessNamespaces(catalog) {
  return new Map((catalog?.modules ?? [])
    .filter(module => module.ruleClauses === false && Array.isArray(module.rulePrefixes) && module.rulePrefixes.length)
    .map(module => [String(module.path ?? '').replace(/\.md$/, ''), module.rulePrefixes]))
}

/**
 * 출처와 지적 ID의 namespace가 어긋난 producer 결과. 문제가 없으면 빈 배열이다.
 *
 * - 조항 없는 패스(correctness)가 규칙 ID를 쓰면 거부한다. 리포트를 읽는 사람이 그 규칙
 *   문서에서 근거를 찾다 실패하고, 검증자는 그 조항으로 반증한다 — 근거가 다른 지적이다
 * - 다른 모듈이 그 패스의 ID(`CR-*`)를 쓰면 거부한다. 규칙 문서를 근거로 한 지적이 조항
 *   없는 지적으로 검증된다
 *
 * 규칙 모듈끼리의 ID(04 모듈이 `17-3`을 내는 것 등)는 여기서 보지 않는다 — 이번 변경의
 * 범위는 조항 없는 namespace다.
 */
export function namespaceProblems(results, namespaces) {
  const problems = []
  const foreign = [...namespaces.values()].flat()
  ;(Array.isArray(results) ? results : []).forEach((entry, at) => {
    if (!entry || typeof entry !== 'object' || !('result' in entry) || !Array.isArray(entry.result?.findings)) return
    const own = namespaces.get(entry.source)
    for (const finding of entry.result.findings) {
      const prefix = String(finding?.ruleId ?? '').split('-')[0]
      if (own && !own.includes(prefix)) {
        problems.push(`results[${at}] ${entry.source}의 지적 ${JSON.stringify(finding?.ruleId)}는 ${own.map(item => `${item}-{번호}`).join('/')}가 아니다 — 이 패스는 규칙 ID를 빌려 쓰지 않는다. 결과를 C-6A 교정 재시도로 다시 받는다`)
      } else if (!own && foreign.includes(prefix)) {
        problems.push(`results[${at}] ${entry.source}의 지적 ${JSON.stringify(finding?.ruleId)}는 다른 패스의 namespace다 — 규칙 문서의 ID를 쓴다. 결과를 C-6A 교정 재시도로 다시 받는다`)
      }
    }
  })
  return problems
}

/** 이 워크플로우에서 켰을 때만 도는 패스(catalog의 `optIn`). */
export function optInPasses(catalog, workflow) {
  if (!workflow) return []
  return (catalog?.modules ?? [])
    .filter(module => (module.optIn ?? []).includes(workflow))
    .map(module => ({ id: module.id, name: String(module.path ?? '').replace(/\.md$/, '') }))
}

async function main() {
  const argv = process.argv.slice(2)
  const mergeBaseIndex = argv.indexOf('--merge-base')
  const mergeBase = mergeBaseIndex === -1 ? 'HEAD' : argv[mergeBaseIndex + 1]
  const locationsOnly = argv.includes('--locations-only')
  const dirIndex = argv.indexOf('--dir')
  const runIndex = argv.indexOf('--run')
  const inputIndex = argv.indexOf('--input')
  const dir = dirIndex === -1 ? undefined : argv[dirIndex + 1]
  const run = runIndex === -1 ? undefined : argv[runIndex + 1]
  const inputPath = inputIndex === -1 ? undefined : argv[inputIndex + 1]
  const rulesIndex = argv.indexOf('--rules')
  const rulesDir = rulesIndex === -1
    ? join(dirname(fileURLToPath(import.meta.url)), '..', 'review-rules')
    : argv[rulesIndex + 1]
  // 모듈별 결과 파일에서 입력을 모은다. `--input`과 함께 주면 어느 쪽이 입력인지
  // 호출자만 알고 스크립트는 모른다 — 고르지 않고 거부한다.
  const collect = argv.includes('--collect')
  if (collect && inputPath !== undefined) {
    process.stderr.write('--collect와 --input을 함께 줄 수 없다. 모듈별 결과 파일을 모으거나 입력 파일 하나를 넘긴다\n')
    process.exit(2)
  }
  // 출력은 `--out`으로 받은 자리에 스크립트가 직접 UTF-8로 쓴다. 셸 리다이렉트(`>`)로 받으면 PowerShell 5.1이
  // node의 UTF-8 출력을 시스템 코드 페이지로 읽어 한글을 되돌릴 수 없게 깨뜨린다 — 2026-10-06 실행은 그래서
  // 검증 준비를 다시 돌렸고, 끝이 없는 교차검증 시작이 기록에 남았다.
  const outIndex = argv.indexOf('--out')
  const outPath = outIndex === -1 ? undefined : argv[outIndex + 1]
  if (outIndex !== -1 && (outPath === undefined || outPath.startsWith('--'))) {
    process.stderr.write('--out에는 routed 출력을 쓸 파일 경로를 준다(보통 <리포트 디렉터리>/.timing/<실행 이름>.routed.json)\n')
    process.exit(2)
  }
  const verifyIndex = argv.indexOf('--verify')
  const verifyMode = verifyIndex === -1 ? 'selective' : argv[verifyIndex + 1]
  if (!['selective', 'exhaustive', 'off'].includes(verifyMode)) {
    process.stderr.write(`--verify는 selective, exhaustive, off 중 하나다 (받은 값: ${JSON.stringify(verifyMode)})\n`)
    process.exit(2)
  }

  // 인자를 먼저 본다. 입력을 다 읽고 나서 거부하면 실패 메시지가 파이프 오류에
  // 묻히고, 무엇을 고쳐야 하는지가 가려진다.
  //
  // 이 스크립트는 렌더 전 **필수 관문**이라 여기서 거부하면 반드시 걸린다. C-9는
  // 첫 sub-agent보다 먼저 `run.start`를 남기라고 하지만 그것은 기억해야 하는
  // 지시였고, 2026-09-08의 한 실행은 계약을 읽고도 타임라인을 한 줄도 남기지
  // 않았다. 디스패치 이후라 부팅을 강제할 수는 없지만, 타임라인 없이 검증까지
  // 가는 경로는 여기서 닫힌다. 시작 자체를 강제하는 것은 `review-preflight.mjs`의 몫이다.
  const sidecar = requireStartedTimeline(dir, run)

  // 부른 사실을 먼저 남긴다. `script.start`만 있고 `script.done`이 없는 기록은
  // "불렀고 끝내지 못했다"는 뜻이고, 아무 줄도 없는 것은 "부르지 않았다"는 뜻이다.
  // 둘을 구분하지 못하면 조립에 걸린 시간과 스크립트가 걸린 시간도 갈리지 않는다 —
  // 한 실행에서 그 구간이 1086초로 전체 최장이었는데 무엇이 오래 걸렸는지 알 수 없었다.
  logPhase(dir, run, 'script.start', { script: 'prepare-verification' })

  const fail = message => {
    process.stderr.write(`${message}\n`)
    process.exit(2)
  }

  // 규칙 문서 목록은 이 스크립트와 같은 플러그인의 것을 기본으로 쓴다. 호출자가
  // `--rules`를 주면 producer가 읽은 그 디렉터리를 쓴다.
  const sourceNames = loadSourceNames(rulesDir)
  if (sourceNames.error) fail(sourceNames.error)
  // loadSourceNames가 이미 같은 파일을 읽어 검사했다.
  const catalog = JSON.parse(readFileSync(join(rulesDir, 'catalog.json'), 'utf8'))
  const namespaces = clauselessNamespaces(catalog)

  // 선택 패스를 켰는지는 preflight가 run.start에 남긴다. 켜지 않은 패스의 결과는 이 실행의
  // 결과가 아니다 — 모으지 않되, 있었다는 사실은 출력과 경고에 남긴다.
  const events = readEvents(sidecar)
  const start = events.find(event => event?.phase === 'run.start') ?? {}
  const passes = optInPasses(catalog, start.workflow)
  const optIn = Object.fromEntries(passes.map(pass => [pass.id, start[pass.id] === 'on' ? 'on' : 'off']))
  const notRequested = new Set(passes.filter(pass => optIn[pass.id] !== 'on').map(pass => pass.name))

  let source
  let payload
  let collected
  if (collect) {
    source = '--collect'
    const gathered = collectResultFiles({
      events,
      sourceNames: sourceNames.value,
      notRequested,
      pathOf: name => join(dir, '.timing', `${run}.${name}.json`),
      read: path => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
    })
    if (gathered.problems.length) fail(`모듈별 결과를 모으지 못했다:\n  - ${gathered.problems.join('\n  - ')}`)
    for (const warning of gathered.warnings) process.stderr.write(`경고: ${warning}\n`)
    payload = gathered.payload
    // runId는 이 routed 출력이 어느 실행의 것인지다. 렌더러가 재현 근거 파일(C-11)이 같은 실행의
    // 것인지 대조할 때 쓴다.
    collected = { ...gathered.collected, ...(passes.length ? { optIn } : {}), ...(start.runId ? { runId: start.runId } : {}) }
  } else {
    source = inputPath === undefined ? 'stdin' : inputPath
    let raw = ''
    if (inputPath === undefined) {
      for await (const chunk of process.stdin) raw += chunk
    } else {
      try {
        raw = readFileSync(inputPath, 'utf8')
      } catch (error) {
        fail(`--input을 읽지 못했다: ${inputPath} — ${error.message}`)
      }
    }
    try {
      payload = JSON.parse(raw)
    } catch (error) {
      fail(`${source} is not valid JSON: ${error.message}`)
    }
  }

  const problems = [...payloadProblems(payload, sourceNames.value), ...namespaceProblems(payload?.results, namespaces)]
  if (problems.length) fail(`${source}를 검증 준비 입력으로 받을 수 없다:\n  - ${problems.join('\n  - ')}`)

  // Producer results are what the orchestrator already holds, so that is the cheap shape.
  // The candidates shape stays accepted for callers that assign their own ids.
  const candidates = Array.isArray(payload)
    ? payload
    : payload.locations
      ? candidatesFromLocations(payload.locations)
      : payload.results
        ? candidatesFromResults(payload.results)
        : (payload.candidates ?? [])
  const result = prepareVerification(candidates, collectBlobs(candidates, gitReaders(mergeBase)), {
    locationsOnly, exhaustive: verifyMode === 'exhaustive', linkPrefixes: [...namespaces.values()].flat(),
  })
  if (collected) result.collected = collected

  // 이전 리뷰와 비교한다(C-13). preflight가 `--previous`로 받은 스냅숏을 run.start에 남겼을 때만이다.
  let rechecks = []
  let identities = []
  if (start.previousSnapshot !== undefined) {
    if (!collect) fail('이전 리뷰와 비교하는 실행(run.start에 previousSnapshot이 있다)은 --collect로 모은다 — 어느 모듈을 검토했는지가 비교에 필요하다')
    const compared = compareWithPrevious({ start, result, catalog, namespaces, rulesDir, mergeBase, fail })
    result.previous = compared.previous
    rechecks = verifyMode === 'off' || locationsOnly ? [] : compared.rechecks
    identities = verifyMode === 'off' || locationsOnly ? [] : compared.identities
    // 검증을 끈 실행은 재확인도 하지 않는다. 재확인할 이전 지적은 그 이유로 남는다 — 해결로 읽지 않는다.
    if (verifyMode === 'off' || locationsOnly) {
      result.previous.recheck = 'verification-off'
      for (const entry of result.previous.entries) {
        if (entry.status !== 'recheck' || entry.reason === 'ambiguous' || entry.reason === 'claim-unavailable') continue
        entry.firstReason = entry.reason
        entry.reason = 'verification-off'
      }
    }
  }

  // 변경 의도의 원문(`review-intent.mjs`). 조항 없는 지적(CR)의 검증자가 producer와 같은 원문을 받는다.
  // 다른 실행의 의도 파일이면 멈춘다 — 그 원문은 이 변경의 의도가 아니다.
  let intent = null
  const intentPath = join(dir, '.timing', `${run}.intent.json`)
  if (existsSync(intentPath)) {
    const text = readFileSync(intentPath, 'utf8')
    let doc
    try {
      doc = JSON.parse(text)
    } catch (error) {
      fail(`변경 의도 파일이 JSON이 아니다: ${intentPath} — ${error.message}`)
    }
    const problems = intentProblems(doc)
    if (problems.length) fail(`변경 의도 파일을 쓸 수 없다: ${intentPath} — ${problems.join(' / ')}`)
    if (doc.runId !== (start.runId ?? null)) fail(`${intentPath}는 다른 실행(${doc.runId})의 의도 파일이다`)
    const sha256 = createHash('sha256').update(text).digest('hex')
    intent = { block: intentBlock(doc, { path: `.timing/${run}.intent.json`, sha256 }), sha256, status: doc.status }
    if (result.collected) result.collected.intent = { path: `.timing/${run}.intent.json`, sha256, status: doc.status }
  } else if (optIn.correctness === 'on') {
    process.stderr.write(`경고: 변경 의도 파일이 없다: ${intentPath} — 정확성 패스의 검증자가 의도의 원문과 대조하지 못한다. review-intent.mjs를 preflight 뒤에 돌린다\n`)
  }

  // 검증자 프롬프트는 여기서 파일로 만든다. 오케스트레이터는 그 내용을 넘기기만
  // 한다 — 다시 쓰지 않는다(`lib/verifier-tasks.mjs` 머리말).
  let written = { tasks: [], promotions: {} }
  if (!locationsOnly) {
    if (verifyMode !== 'off') {
      const outDir = verifyDirOf(dir, run)
      if (outDir.error) fail(outDir.error)
      // 작업 대장(C-12)이 이번 라운드의 검증 작업을 이미 내줬으면 그 프롬프트를 지우지 않는다. 판정
      // 파일이 아직 없어도 검증자는 돌고 있을 수 있다 — 지우고 다시 만들면 돌고 있는 작업과 새 작업
      // 목록이 어긋난다.
      const round = events.map(event => event?.phase).lastIndexOf('crossverify.start')
      const claimed = round === -1 ? [] : events.slice(round).filter(event => event?.phase === 'verify.start')
      if (claimed.length && !argv.includes('--discard-verdicts')) {
        fail(`이번 교차검증에서 검증 작업 ${claimed.length}개를 이미 띄웠다(verify.start) — 같은 실행을 이어 가는 중이면 이 스크립트를 다시 돌리지 않고 review-tasks.mjs status로 남은 작업을 본다. 검증을 처음부터 다시 하려면 --discard-verdicts를 준다`)
      }
      written = writeVerifierTasks({ result, rulesDir, mergeBase, outDir: outDir.path, discardVerdicts: argv.includes('--discard-verdicts'), fail, rechecks, identities, intent })
      if (result.previous) {
        for (const task of written.tasks) {
          if (task.route !== 'recheck' && task.route !== 'identity') continue
          const entry = result.previous.entries.find(one => one.ref === task.candidateIds[0])
          if (entry) entry[task.route === 'recheck' ? 'recheckTask' : 'identityTask'] = task.taskId
        }
      }
    }
    result.verifierTasks = written.tasks
    result.promotions = written.promotions
  }

  // `--out`이면 기록보다 먼저 쓴다 — 쓰지 못했으면 이 준비는 끝나지 않은 것이고, 교차검증도 시작하지 않은 것이다.
  const text = `${JSON.stringify(result, null, 2)}\n`
  let outFile = null
  if (outPath !== undefined) {
    const path = resolve(outPath)
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeTextAtomic(path, text, {
        verify: back => {
          try {
            JSON.parse(back)
            return null
          } catch (error) {
            return `JSON으로 읽히지 않는다(${error.message})`
          }
        },
      })
    } catch (error) {
      fail(`--out에 routed 출력을 쓰지 못했다: ${path} — ${error.message}`)
    }
    outFile = { path, sha256: createHash('sha256').update(text).digest('hex') }
  }

  logPhase(dir, run, 'script.done', { ran: true, counts: result.counts })
  // 교차검증의 시작은 **검증자를 띄울 준비가 끝난 이 자리**에서 남긴다. 오케스트레이터가
  // 남기게 두었더니 2026-09-30 실행이 검증자 19개가 다 끝난 뒤에야 찍었고, 80분
  // 검증이 "무엇이 돌았는지 기록에 없는 5173초"로 보였다.
  // 라운드마다 이름을 붙인다. 작업 대장이 claim과 응답 자리에 넣어, 검증을 다시 준비했을 때 앞 라운드의
  // 늦은 응답이 새 라운드의 결과가 되지 않게 한다(C-12).
  if (written.tasks.length) logPhase(dir, run, 'crossverify.start', { targets: result.counts.verify, round: randomBytes(4).toString('hex') })
  // `--out`이면 표준 출력에는 무엇을 어디에 썼는지만 낸다 — 같은 JSON을 다시 내면 리다이렉트로 받는 길이 남는다.
  process.stdout.write(outFile === null ? text : `${JSON.stringify({
    out: outFile.path,
    sha256: outFile.sha256,
    counts: result.counts,
    verifierTasks: (result.verifierTasks ?? []).length,
  }, null, 2)}\n`)
}

/**
 * 모듈별 결과 파일(`<run>.<규칙 문서 이름>.json`)을 envelope 입력으로 모은다.
 *
 * 기준은 파일이 아니라 **기록**이고, 모으는 것은 최종 `module.done`이 `ok`인 모듈뿐이다. 최종은
 * **가장 큰 시도**의 마지막 줄이다(`moduleOutcomes`) — 파일의 마지막 줄로 읽으면, 시도 1을 나중에
 * `failed`로 정정한 줄이 시도 2의 성공을 덮어 그 모듈의 결과를 버린다(PR #87 리뷰에서 재현).
 *
 * - `ok`인데 결과 파일이 없으면 거부한다. 모은 것만 보고 넘어가면 빠진 모듈이 "지적
 *   0건"과 구분되지 않는다
 * - `failed`로 끝난 모듈의 파일은 쓰지 않는다(C-6A: 실패한 패스를 부분 보정으로
 *   통과시키지 않는다)
 * - `ok`도 `failed`도 아닌 상태는 거부한다. 기록 단계는 목록 밖 값도 줄은 남기고
 *   경고만 하므로, 여기서 성공으로 읽으면 타임라인이 경고한 값을 검증 준비가 성공으로
 *   쓴다. 2026-09-30 실행은 22줄 전부에 `COMPLETED`를 적었다
 * - `module.done` 없이 파일만 있으면 거부한다. 결과 파일은 `module.done`보다 먼저
 *   쓰므로(SKILL), 기록이 없는 파일은 쓰다 만 것이거나 앞 실행의 것일 수 있다
 *
 * append 전용 기록이므로 상태를 바로잡는 방법은 같은 시도의 `module.done`을 `note`와
 * 함께 한 줄 더 남기는 것이다 — 그 시도 안에서는 마지막 줄이 정본이고, `review-timeline.mjs
 * --check`는 그 줄을 중복이 아니라 정정으로 받는다.
 *
 * 작업 대장(C-12)이 결과를 받았으면 `module.done`에 그 내용의 해시(`resultSha256`)가 있다. 파일이
 * 그 해시와 다르면 거부한다 — 그 파일은 기록된 시도의 결과가 아니다(늦게 온 앞 시도의 응답이
 * 덮었거나, 손으로 고쳤다).
 */
export function collectResultFiles({ events, sourceNames, pathOf, read, notRequested = new Set() }) {
  const outcomes = moduleOutcomes(events)
  const results = []
  const problems = []
  const warnings = []
  const collected = { sources: [], excludedFailed: [] }
  for (const name of sourceNames) {
    const path = pathOf(name)
    const raw = read(path)
    const outcome = outcomes.get(name)
    const status = outcome?.status
    // 켜지 않은 선택 패스. 기록이나 파일이 있어도 이 실행의 결과로 모으지 않는다 — 실행
    // 기록(run.start)이 그 패스를 켜지 않았다고 말한다. 조용히 버리지 않고 알린다.
    if (notRequested.has(name)) {
      if (raw !== undefined || status !== undefined) {
        collected.excludedNotRequested = [...(collected.excludedNotRequested ?? []), name]
        warnings.push(`${name}는 이 실행에서 켜지 않은 선택 패스인데 기록이나 결과 파일이 있다 — 모으지 않는다. 그 패스를 쓰려면 preflight에 --${name} on을 주고 새 실행으로 시작한다`)
      }
      continue
    }
    if (status === 'failed') {
      if (raw !== undefined) {
        collected.excludedFailed.push(name)
        warnings.push(`${name}는 마지막 module.done이 failed라 결과 파일을 쓰지 않는다: ${path}`)
      }
      continue
    }
    if (status === undefined) {
      if (raw !== undefined) {
        problems.push(`${name}는 module.done 없이 결과 파일만 있다: ${path} — 이번 실행에서 끝난 모듈이면 module.done(status ok)을 남기고 다시 돌린다. 아니면 그 파일은 이번 실행의 결과가 아니다`)
      }
      continue
    }
    if (status !== 'ok') {
      problems.push(`${name}의 마지막 module.done status ${JSON.stringify(status)}는 ok도 failed도 아니다 — 성공인지 알 수 없어 모으지 않는다. 같은 모듈·같은 attempt의 module.done을 ok 또는 failed와 사유를 적은 note로 한 줄 더 남기고 다시 돌린다`)
      continue
    }
    if (raw === undefined) {
      problems.push(`${name}는 module.done이 ok인데 결과 파일이 없다: ${path}`)
      continue
    }
    if (outcome.resultSha256 !== undefined && createHash('sha256').update(raw).digest('hex') !== outcome.resultSha256) {
      problems.push(`${name}의 결과 파일이 시도 ${outcome.attempt}에서 받은 내용과 다르다: ${path} — 작업 대장이 받은 뒤 파일이 바뀌었다. 늦게 온 앞 시도의 응답이 덮었을 수 있다. 결과 파일은 review-tasks.mjs done만 쓴다`)
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      problems.push(`${path}를 JSON으로 읽지 못했다: ${error.message}`)
      continue
    }
    results.push({ source: name, result: parsed })
    collected.sources.push(name)
  }
  return { payload: { results }, problems, warnings, collected }
}

/**
 * 검증자 프롬프트 디렉터리(`<dir>/.timing/<run>.verify`)를 정한다.
 *
 * 이 디렉터리는 실행마다 **재귀로 지우고** 다시 만든다. 그래서 지우기 전에 경로가
 * `.timing` 안인지 본다. `--run`의 구분자 검사만으로는 부족하다 — Windows에서
 * `D:evil`은 구분자가 없는데도 다른 드라이브로 풀린다.
 */
export function verifyDirOf(dir, run) {
  const timing = resolve(dir, '.timing')
  const path = resolve(timing, `${run}.verify`)
  const rel = relative(timing, path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return { error: `검증자 프롬프트 디렉터리가 ${timing} 밖으로 풀린다: ${path} — --run은 경로가 아니라 리포트 basename이어야 한다` }
  }
  return { path }
}

/**
 * verifier 작업마다 프롬프트 파일을 쓰고, 그 목록을 돌려준다.
 *
 * 지시문·manifest·규칙 문서는 모두 `rulesDir`에서 읽는다 — producer가 읽은 규칙과
 * 검증자가 받는 규칙이 같아야 한다. 디렉터리는 실행마다 새로 만든다. 앞 실행의
 * 파일이 남으면 이번 목록에 없는 작업이 디렉터리에는 있게 된다.
 */
function writeVerifierTasks({ result, rulesDir, mergeBase, outDir, discardVerdicts, fail, rechecks = [], identities = [], intent = null }) {
  const planned = planVerifierTasks(result)
  if (!planned.tasks.length && !rechecks.length && !identities.length) return { tasks: [], promotions: {} }

  const readRule = name => {
    try {
      return readFileSync(join(rulesDir, name), 'utf8')
    } catch (error) {
      fail(`${join(rulesDir, name)}를 읽지 못했다: ${error.message}`)
    }
  }
  const template = markedBlock(readRule('verifier-prompt.md'), 'VERIFIER_PROMPT')
  if (template.error) fail(`verifier-prompt.md: ${template.error}`)
  const manifest = markedBlock(readRule('workflow-contract.md'), 'REVIEW_VERDICT_CONTRACT_V1')
  if (manifest.error) fail(`workflow-contract.md: ${manifest.error}`)
  const instructions = instructionsWithManifest(template.value, manifest.value)
  if (instructions.error) fail(instructions.error)

  const catalog = JSON.parse(readRule('catalog.json'))
  const docs = new Map()
  const clauses = new Map()
  for (const candidate of [...result.candidates, ...rechecks.map(entry => entry.claim), ...identities.map(entry => entry.previousClaim)]) {
    if (clauses.has(candidate.ruleId)) continue
    const docPath = docPathForRule(candidate.ruleId, catalog)
    if (docPath && !docs.has(docPath)) docs.set(docPath, readRule(docPath))
    // 조항이 원래 없는 패스(`ruleClauses: false`)는 문서의 판정 기준 블록을 준다. 그 블록이
    // 없으면 멈춘다 — 조항도 기준도 없는 프롬프트는 검증자에게 무엇으로 판정할지 말하지 않는다.
    if (docPath && catalog.modules?.find(module => module.path === docPath)?.ruleClauses === false) {
      const basis = markedBlock(docs.get(docPath), 'VERIFICATION_BASIS')
      if (basis.error) fail(`${docPath}: ${basis.error}`)
      clauses.set(candidate.ruleId, { basis: basis.value })
      continue
    }
    clauses.set(candidate.ruleId, docPath ? extractClause(docs.get(docPath), candidate.ruleId) : null)
  }

  // 받은 판정이 있는 디렉터리는 지우지 않는다. 같은 실행을 이어 가다 이 스크립트를 다시
  // 돌리면 검증자가 이미 낸 판정까지 지워진다 — 2026-09-30의 한 실행은 검증 도중 스킬을
  // 다시 불렀다. 남은 작업은 판정 파일에서 셀 수 있으므로 다시 준비할 이유가 없다.
  const received = existsSync(outDir) ? readdirSync(outDir).filter(name => name.endsWith('.verdict.json')) : []
  if (received.length && !discardVerdicts) {
    fail(`${outDir}에 이미 받은 판정 파일이 ${received.length}개 있다 — 같은 실행을 이어 가는 중이면 이 스크립트를 다시 돌리지 않고 tally-verdicts.mjs --validate --targets <routed>로 남은 작업을 본다. 받은 판정을 버리고 검증을 처음부터 다시 하려면 --discard-verdicts를 준다`)
  }
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const candidatesById = new Map(result.candidates.map(candidate => [candidate.candidateId, candidate]))
  // 검증자가 돌려준 JSON을 남길 자리(`verdict`)도 여기서 정한다. 오케스트레이터가
  // 이름을 지으면 실행마다 달라지고, `tally-verdicts.mjs --collect`가 찾지 못한다.
  const write = task => {
    const { prompt, missingClauses } = buildTaskPrompt({ instructions: instructions.value, task, candidatesById, clauses, mergeBase, intent })
    const path = join(outDir, `${task.taskId}.md`)
    writeFileSync(path, prompt, 'utf8')
    return { prompt: path, verdict: join(outDir, `${task.taskId}.verdict.json`), missingClauses }
  }
  const tasks = planned.tasks.map(task => {
    const { prompt, verdict, missingClauses } = write(task)
    return {
      taskId: task.taskId,
      route: task.kind,
      candidateIds: task.candidateIds,
      prompt,
      verdict,
      ...(missingClauses.length ? { missingClauses } : {}),
    }
  })
  const promotions = Object.fromEntries(planned.promotions.map(task => {
    const { prompt, verdict } = write(task)
    return [task.candidateIds[0], { taskId: task.taskId, prompt, verdict }]
  }))

  // 재확인 작업(C-13). 지시는 같은 문서의 `RECHECK_PROMPT` 블록이다 — 교차검증의 "기본 입장은 반박"을
  // 그대로 쓰면, 반박이 곧 "해결됐다"인 이 작업에서 고치지 않은 결함이 해결로 보고된다.
  if (rechecks.length) {
    const recheckTemplate = markedBlock(readRule('verifier-prompt.md'), 'RECHECK_PROMPT')
    if (recheckTemplate.error) fail(`verifier-prompt.md: ${recheckTemplate.error}`)
    const recheckInstructions = instructionsWithManifest(recheckTemplate.value, manifest.value)
    if (recheckInstructions.error) fail(recheckInstructions.error)
    for (const entry of rechecks) {
      // 작업 이름은 이전 지적의 ref에서 만든다 — 이월된 지적은 다른 실행의 같은 candidateId를 가질 수 있다.
      const taskId = `recheck-${String(entry.claim.candidateId).replace(/[^A-Za-z0-9-]/g, '-')}`
      const task = { taskId, kind: 'recheck', candidateIds: [entry.claim.candidateId] }
      const { prompt, missingClauses } = buildRecheckPrompt({
        instructions: recheckInstructions.value, task, claim: entry.claim, previousHead: entry.previousHead,
        reason: entry.reason, movedTo: entry.movedTo, clauses,
      })
      const path = join(outDir, `${taskId}.md`)
      writeFileSync(path, prompt, 'utf8')
      tasks.push({
        taskId, route: 'recheck', candidateIds: task.candidateIds, prompt: path,
        verdict: join(outDir, `${taskId}.verdict.json`),
        ...(missingClauses.length ? { missingClauses } : {}),
      })
    }
  }

  // 같은 결함인지 묻는 작업(C-13). 열쇠는 1:1로 맞지만 조항이 결함의 종류를 말하지 않는 지적(CR)이나 위치가
  // 확실하지 않은 지적은, 같은 결함이라는 판정이 있을 때만 이전의 이름을 물려받는다.
  if (identities.length) {
    const identityTemplate = markedBlock(readRule('verifier-prompt.md'), 'IDENTITY_PROMPT')
    if (identityTemplate.error) fail(`verifier-prompt.md: ${identityTemplate.error}`)
    const identityInstructions = instructionsWithManifest(identityTemplate.value, manifest.value)
    if (identityInstructions.error) fail(identityInstructions.error)
    for (const entry of identities) {
      const taskId = `identity-${String(entry.previousClaim.candidateId).replace(/[^A-Za-z0-9-]/g, '-')}`
      const task = { taskId, kind: 'identity', candidateIds: [entry.previousClaim.candidateId] }
      const { prompt, missingClauses } = buildIdentityPrompt({
        instructions: identityInstructions.value, task, previousClaim: entry.previousClaim, currentClaim: entry.currentClaim,
        previousHead: entry.previousHead, clauses,
      })
      const path = join(outDir, `${taskId}.md`)
      writeFileSync(path, prompt, 'utf8')
      tasks.push({
        taskId, route: 'identity', candidateIds: task.candidateIds, prompt: path,
        verdict: join(outDir, `${taskId}.verdict.json`),
        ...(missingClauses.length ? { missingClauses } : {}),
      })
    }
  }
  return { tasks, promotions }
}

/**
 * 이전 리뷰의 스냅숏과 이번 후보를 잇는다(C-13).
 *
 * - 스냅숏은 preflight가 남긴 해시와 같아야 한다. 그 사이에 바뀐 파일과 비교하면 preflight가 확인한
 *   이전 리뷰가 아니다
 * - 이전 지적의 글(제목·본문·근거)은 스냅숏에 없다. 이전 실행의 routed 출력에서 읽고, 스냅숏이 남긴
 *   해시와 맞을 때만 쓴다. 못 읽으면 비교는 하되 재확인 작업은 만들지 않는다 — 지적의 글 없이 다시
 *   판정하라고 하면 검증자가 주장을 지어낸다
 * - 이번 후보마다 `lineage`(신규·이어짐·재확인 필요)를, 이전 지적마다 상태와 이유를 남긴다. 재확인할
 *   지적은 재확인 작업으로 돌려준다
 */
function compareWithPrevious({ start, result, catalog, namespaces, rulesDir, mergeBase, fail }) {
  const snapshotPath = start.previousSnapshot
  let text
  try {
    text = readFileSync(snapshotPath, 'utf8')
  } catch (error) {
    fail(`이전 리뷰의 스냅숏을 읽지 못했다: ${snapshotPath} — ${error.message}`)
  }
  if (createHash('sha256').update(text).digest('hex') !== start.previousSha256) {
    fail(`이전 리뷰의 스냅숏이 preflight 뒤에 바뀌었다: ${snapshotPath} — preflight가 확인한 파일과 다른 것과 비교하지 않는다`)
  }
  const parsed = parseSnapshot(text)
  if (parsed.error) fail(`이전 리뷰의 스냅숏을 쓸 수 없다: ${snapshotPath} — ${parsed.error}`)
  const before = parsed.value

  // 비교할 이전 지적 = 그 실행이 낸 지적 + **그 실행이 계속 추적하던 이전 지적**(미해결·재확인 필요).
  // 직전 스냅숏의 지적만 보면, 그 실행이 재확인으로 "지금도 성립한다"고 확인했거나 재확인하지 못한 이전
  // 지적이 다음 비교에서 사라진다 — 가장 최근 스냅숏을 고르는 흐름에서 세 번째 리뷰마다 되풀이된다(PR #94
  // 리뷰에서 재현). 이월 항목은 처음 낸 실행의 주장 파일(경로·해시)과 이름을 그대로 들고 간다. 같은 이름이
  // 그 실행의 지적에도 있으면 지적 쪽을 쓴다 — 더 최근의 주장이다.
  const routedInput = before.inputs.find(input => input.role === 'routed')
  const ownClaims = routedInput ? { path: resolve(dirname(snapshotPath), '..', routedInput.path), sha256: routedInput.sha256 } : null
  const locatedAt = { head: before.target.head, mergeBase: before.target.mergeBase }
  const fromFindings = before.findings.map(finding => ({
    ...finding, lineageId: finding.lineageId ?? finding.ref, locatedAt, ...(ownClaims ? { claimSource: ownClaims } : {}),
  }))
  const tracked = new Set(fromFindings.map(finding => finding.lineageId))
  const carried = (before.comparison?.entries ?? [])
    .filter(entry => entry.status !== 'resolved' && !tracked.has(entry.lineageId ?? entry.ref))
    .map(entry => ({
      ref: entry.ref,
      lineageId: entry.lineageId ?? entry.ref,
      candidateId: entry.candidateId ?? String(entry.ref).split('/').slice(1).join('/'),
      ruleId: entry.ruleId,
      sources: entry.sources ?? [],
      location: entry.location,
      ...(entry.locatedAt ? { locatedAt: entry.locatedAt } : {}),
      ...(entry.claimSource ? { claimSource: entry.claimSource } : {}),
      carried: true,
    }))
  const previous = [...fromFindings, ...carried]

  // 주장 파일은 경로마다 한 번 읽고 해시를 맞춘다. 못 읽으면 그 파일에서 온 항목은 지우지 않고
  // `claim-unavailable`로 남긴다 — 글이 없다고 추적을 멈추면 결함이 조용히 빠진다.
  const claimFiles = new Map()
  const claimsOf = source => {
    if (!source?.path) return { problem: '주장 파일을 가리키는 기록이 없다' }
    if (!claimFiles.has(source.path)) {
      try {
        const routedText = readFileSync(source.path, 'utf8')
        claimFiles.set(source.path, createHash('sha256').update(routedText).digest('hex') !== source.sha256
          ? { problem: `${source.path}가 그 스냅숏을 쓴 뒤에 바뀌었다` }
          : { claims: new Map((JSON.parse(routedText).candidates ?? []).map(candidate => [candidate.candidateId, candidate])) })
      } catch (error) {
        claimFiles.set(source.path, { problem: `${source.path}를 읽지 못했다 — ${error.message}` })
      }
    }
    return claimFiles.get(source.path)
  }
  const claimOfEntry = entry => claimsOf(entry.claimSource).claims?.get(entry.candidateId) ?? null

  // 감싼 선언(C-13). 같은 줄이 다른 함수에 있으면 다른 자리다. 이전 지적은 그 지적이 가리킨 코드의 버전에서,
  // 이번 후보는 지금 트리(삭제는 merge-base)에서 읽는다.
  const show = ref => {
    try {
      return execFileSync('git', ['show', ref], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return null
    }
  }
  const readers = gitReaders(mergeBase)
  const symbolAt = (location, read) => {
    if (location?.kind === 'verified') return enclosingSymbol(read('head', location.path), location.line)
    if (location?.kind === 'deleted') return enclosingSymbol(read('base', location.path), location.lineBefore)
    return null
  }
  for (const finding of previous) {
    if (!finding.locatedAt) continue
    finding.symbol = symbolAt(finding.location, (side, path) => show(`${side === 'head' ? finding.locatedAt.head : finding.locatedAt.mergeBase}:${path}`))
  }
  const currentWithSymbols = result.candidates.map(candidate => ({
    ...candidate, symbol: symbolAt(candidate.location, (side, path) => (side === 'head' ? readers.working(path) : readers.base(path)) ?? null),
  }))

  const paths = pathChanges(process.cwd(), before.target.head)
  const currentDocs = ruleDocDigests(rulesDir, (catalog.modules ?? []).map(module => module.path).filter(Boolean))
  const digestNow = rulesDigest(rulesDir)
  const ruleChanged = ruleId => {
    const doc = docPathForRule(ruleId, catalog)
    if (!doc || !currentDocs[doc]) return true
    const earlier = before.run.ruleDocs?.[doc]
    // 문서별 digest가 없는 스냅숏(2.20.0 이전)은 디렉터리 전체로만 본다. 다르면 어느 문서가 바뀌었는지
    // 모르므로 바뀐 것으로 본다.
    if (earlier === undefined) return before.run.rulesDigest !== digestNow
    return earlier !== currentDocs[doc]
  }
  const linked = linkFindings({
    previous,
    current: currentWithSymbols,
    currentRunId: start.runId,
    clauselessPrefixes: [...namespaces.values()].flat(),
    reviewedNow: new Set(result.collected?.sources ?? []),
    reviewedBefore: new Set(before.scope.modules.filter(module => module.state === 'ok').map(module => module.name)),
    paths,
    ruleChanged,
  })
  for (const candidate of result.candidates) candidate.lineage = linked.current.get(candidate.candidateId)
  // 다음 비교가 이 항목을 이어받을 때 감싼 선언을 다시 셀 수 있게, 위치가 가리키는 코드의 버전을 남긴다.
  const located = new Map(previous.map(finding => [finding.ref, finding.locatedAt]))
  for (const entry of linked.previous) if (located.get(entry.ref)) entry.locatedAt = located.get(entry.ref)

  const byId = new Map(result.candidates.map(candidate => [candidate.candidateId, candidate]))
  const rechecks = []
  const identities = []
  for (const entry of linked.previous) {
    const wantsRecheck = recheckable(entry)
    const wantsIdentity = identityPending(entry)
    if (!wantsRecheck && !wantsIdentity) continue
    const claim = claimOfEntry(entry)
    if (!claim) {
      entry.claim = 'unavailable'
      if (wantsRecheck) {
        entry.firstReason = entry.reason
        entry.reason = 'claim-unavailable'
      }
      continue
    }
    // 판정할 ID는 이전 지적의 ref다. 이번 실행의 candidateId와 섞이지 않는다.
    const previousClaim = { ...claimOf(claim), candidateId: entry.ref }
    if (wantsIdentity) {
      identities.push({ previousClaim, currentClaim: claimOf(byId.get(entry.currentCandidateId)), previousHead: entry.locatedAt?.head ?? before.target.head })
      continue
    }
    rechecks.push({
      claim: previousClaim,
      previousHead: entry.locatedAt?.head ?? before.target.head,
      reason: entry.reason,
      movedTo: entry.location?.kind === 'verified' ? paths?.renamed?.get(entry.location.path) : undefined,
    })
  }
  const currentStates = [...linked.current.values()]
  const problems = [...claimFiles.values()].map(file => file.problem).filter(Boolean)
  return {
    rechecks,
    identities,
    previous: {
      snapshot: { path: snapshotPath, sha256: start.previousSha256, runId: before.run.runId, head: before.target.head, createdAt: before.createdAt, status: before.status },
      paths: paths ? 'known' : 'unknown',
      claims: problems.length ? `unavailable — ${problems.join(' / ')}` : 'available',
      reused: 0,
      carried: carried.length,
      counts: {
        current: countBy(currentStates, CURRENT_STATUSES),
        previous: countBy(linked.previous, ['linked', 'recheck']),
      },
      entries: linked.previous,
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}

/**
 * Turn validated producer results into candidates, assigning the ids here.
 *
 * The caller already holds these objects, so accepting them verbatim removes the
 * transformation step that made calling this module more expensive than eyeballing the
 * numbers. Assigning ids here also settles them: every run names the same finding the
 * same way, and the name traces back to a rule id the report already prints.
 *
 * The ordinal follows normalized location rather than the order producers happened to
 * finish in, so a slow module does not rename everyone else's candidates.
 */
/**
 * Strip an invented instance marker and report what was repaired.
 *
 * Repairs are surfaced rather than applied silently. A producer emitting ids the
 * contract does not define is a contract violation, and swallowing it here means
 * nobody ever fixes the producer.
 */
export function normalizeRuleId(raw) {
  const id = String(raw ?? '').trim()
  const stripped = id.replace(INSTANCE_MARKER, '')
  if (stripped !== id && RULE_ID.test(stripped)) return { ruleId: stripped, repairedFrom: id }
  return { ruleId: id || 'unknown', repairedFrom: null }
}

/**
 * The dedup key from C-6A, or null when the contract forbids automatic merging.
 *
 * The contract requires **all** of these to match: rule id, a `verified` or
 * `deleted` location, the normalized location, the same core claim, the same
 * `impact` and `category`, the same `confidence`.
 *
 * "Same core claim" is a judgment, and this module does not make judgments — so
 * it uses the strictest reading available to code: the title and body are
 * byte-identical. Two findings that argue the same thing in different words stay
 * separate here. That is the safe direction; merging them would delete a claim
 * nobody compared.
 *
 * `unverified` locations return null. Without an anchor there is nothing to key
 * on, and the contract says so explicitly.
 */
export function dedupKey(finding) {
  const location = finding?.location ?? {}
  if (location.kind !== 'verified' && location.kind !== 'deleted') return null
  const line = location.kind === 'verified' ? location.line : location.lineBefore
  if (location.path === undefined || line === undefined) return null
  return JSON.stringify([
    finding.ruleId ?? '',
    location.kind,
    location.path,
    line,
    finding.impact ?? '',
    finding.category ?? '',
    finding.confidence ?? '',
    finding.title ?? '',
    finding.body ?? '',
  ])
}

/**
 * Merge byte-identical findings, keeping every instance traceable.
 *
 * The contract requires the canonical candidate to preserve `memberInstanceIds`
 * and every source label. Instance ids are positional here — producers do not
 * carry them into this module — but positional ids still let a reader walk from
 * a merged candidate back to the inputs that produced it.
 */
export function exactDedup(findings) {
  const byKey = new Map()
  const kept = []
  let merged = 0
  ;(findings ?? []).forEach((finding, index) => {
    const instanceId = `i${index + 1}`
    const key = dedupKey(finding)
    if (key === null) {
      kept.push({ ...finding, memberInstanceIds: [instanceId] })
      return
    }
    const seen = byKey.get(key)
    if (!seen) {
      const entry = { ...finding, memberInstanceIds: [instanceId] }
      byKey.set(key, entry)
      kept.push(entry)
      return
    }
    seen.memberInstanceIds.push(instanceId)
    // 기여한 source label을 전부 보존한다 — 어느 패스가 같은 것을 봤는지가
    // 병합으로 사라지면 커버리지를 되짚을 수 없다.
    if (finding.source && !(seen.sources ?? []).includes(finding.source)) {
      seen.sources = [...(seen.sources ?? [seen.source].filter(Boolean)), finding.source]
    }
    merged += 1
  })
  return { findings: kept, merged }
}

export function candidatesFromResults(results) {
  const collected = []
  const ruleIdRepairs = []
  for (const entry of results ?? []) {
    // envelope 형태 `{ source, result }`와 맨 producer 결과(`{ schemaVersion,
    // findings, openQuestions }`)를 모두 받는다. `source`는 오케스트레이터만
    // 붙일 수 있는 값이다 — `findingsItem.allowed`(계약)는 애초에 producer
    // finding에 `source` 필드를 허용하지 않는다. producer가 자기 출처를
    // 자기 입으로 말하게 하면, 신뢰하지 않는 producer 출력이 스스로 이름표를
    // 다는 셈이라 근거로 가장 약하다 — 어느 producer가 어떤 결과를 냈는지
    // 신뢰성 있게 아는 것은 그 결과를 디스패치한 오케스트레이터뿐이다.
    const isEnvelope = entry && typeof entry === 'object' && 'result' in entry &&
      entry.result && typeof entry.result === 'object'
    const result = isEnvelope ? entry.result : entry
    const source = isEnvelope ? entry.source : undefined
    for (const finding of result?.findings ?? []) {
      const { ruleId, repairedFrom } = normalizeRuleId(finding?.ruleId)
      if (repairedFrom) ruleIdRepairs.push({ from: repairedFrom, to: ruleId })
      const withRuleId = ruleId === finding?.ruleId ? finding : { ...finding, ruleId }
      // envelope의 source를 finding에 태그한다. finding 자체가 이미
      // source를 갖고 있을 일은 없다(위 이유) — 있다면 그건 이 함수가
      // 신뢰하지 않아야 할 producer 출력이 그 필드를 흉내 낸 것이다.
      collected.push(source !== undefined ? { ...withRuleId, source } : withRuleId)
    }
  }

  // 계약 순서: 위치 대조 → exact dedup → candidate ID. 위치 대조는 호출부에서
  // 이미 끝났고, 여기서 dedup한 뒤에 ID를 붙인다. 순서를 바꾸면 같은 결함에
  // 서로 다른 ID가 붙어 verifier가 같은 것을 두 번 반박한다.
  const { findings, merged } = exactDedup(collected)

  const sortKey = finding => {
    const location = finding.location ?? {}
    const line = location.line ?? location.lineBefore ?? 0
    // Everything the finding says, not just its heading. Two findings sharing a rule,
    // path, line and title still get a stable order from their body and quote; a tie
    // below all of that means the two are indistinguishable, which exact dedup settles.
    return [
      location.path ?? '',
      String(line).padStart(9, '0'),
      location.quote ?? '',
      finding.title ?? '',
      finding.body ?? '',
      // NUL separator: no field can contain it, so two findings cannot collide by having
      // a value that happens to span the boundary. Written as the escape rather than a
      // literal NUL byte in the source — a real 0x00 here makes grep and other tools
      // treat this whole file as binary and skip it silently.
    ].join('\0')
  }

  const byRule = new Map()
  for (const finding of findings) {
    const ruleId = finding.ruleId ?? 'unknown'
    if (!byRule.has(ruleId)) byRule.set(ruleId, [])
    byRule.get(ruleId).push(finding)
  }

  const candidates = []
  for (const [ruleId, group] of byRule) {
    // Code points, not localeCompare — collation varies by machine locale, and an id that
    // shifts with the reviewer's locale is not the stable id this function promises.
    group.sort((a, b) => {
      const left = sortKey(a)
      const right = sortKey(b)
      return left < right ? -1 : left > right ? 1 : 0
    })
    group.forEach((finding, index) => {
      const content = { title: finding.title, body: finding.body }
      // 선택 필드는 없으면 키를 만들지 않는다. 빈 문자열을 넣으면 렌더러가
      // "값이 없다"와 "값이 빈 문자열이다"를 구분할 수 없다.
      if (finding.evidence !== undefined) content.evidence = finding.evidence
      if (finding.recommendation !== undefined) content.recommendation = finding.recommendation
      if (finding.reason !== undefined) content.reason = finding.reason

      candidates.push({
        candidateId: `${ruleId}#${index + 1}`,
        ruleId,
        impact: finding.impact,
        confidence: finding.confidence,
        category: finding.category,
        location: finding.location,
        // 산문은 렌더러가 쓴다. 축과 위치를 여기 복제하지 않는 이유는 같은 값이
        // 두 벌이 되면 나중에 한쪽만 고쳐져 어긋나기 때문이다.
        content,
        // 병합된 instance를 candidate에 붙여 보낸다. 이것이 없으면 canonical
        // candidate 하나가 원래 몇 건이었는지 사후에 알 수 없다.
        memberInstanceIds: finding.memberInstanceIds ?? [],
        // exactDedup이 seen.source/seen.sources에 모은 출처 패스 label을
        // 여기서 놓치면, 병합 판정 자체는 옳아도 "누가 봤는지"는 candidate에
        // 도달하기 전에 사라진다(계약 203·244행 — 병합된 finding은 기여한
        // 모든 source/pass label을 보존해야 한다). 없으면 키를 만들지
        // 않는다 — content의 선택 필드와 같은 이유다.
        ...(finding.source !== undefined ? { source: finding.source } : {}),
        ...(finding.sources !== undefined ? { sources: finding.sources } : {}),
      })
    })
  }
  candidates.dedupMerged = merged
  candidates.ruleIdRepairs = ruleIdRepairs
  return candidates
}

/**
 * Accept a light location manifest instead of full producer results.
 *
 * A consolidated pass has one agent covering every module, and making it emit a complete
 * REVIEW_RESULT_CONTRACT_V1 envelope for every finding is what timed that pass out. Four
 * short fields per finding is what such a pass can afford, and it is all a location check
 * needs.
 *
 * Rows without a line or a quote are dropped rather than treated as checked, so a caller
 * comparing what it sent against what came back sees the gap instead of a passing check.
 */
export function candidatesFromLocations(locations) {
  const usable = (locations ?? []).filter(
    row => row && typeof row.path === 'string' && Number.isInteger(row.line) && typeof row.quote === 'string',
  )
  return candidatesFromResults([
    {
      schemaVersion: 1,
      openQuestions: [],
      findings: usable.map(row => ({
        ruleId: row.ruleId,
        title: row.title ?? '',
        body: '',
        impact: 'low',
        confidence: 'high',
        location: { kind: 'verified', path: row.path, line: row.line, quote: row.quote },
      })),
    },
  ])
}
