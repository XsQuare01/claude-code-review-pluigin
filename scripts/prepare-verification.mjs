import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

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

/** Decide whether a candidate gets verified at all. Five schema fields plus the two derived signals — no model involved. */
export function decideEligibility(input) {
  const reasons = eligibilityReasons(input)
  return { eligibility: reasons.length > 0 ? 'VERIFY' : 'SKIP-VERIFY', reasons }
}

/**
 * Send an eligible candidate to a shared bundle or to isolated verification.
 *
 * Isolation wins whenever the anchor file alone cannot settle the claim. The
 * approximation is deliberately conservative: over-isolating costs tokens,
 * while under-isolating can produce a wrong rejection that no later step undoes.
 */
export function routeCandidate(input) {
  const { candidate, locationCheck, ownerCollision } = input
  const { eligibility, reasons } = decideEligibility(input)
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
  const decided = list.map(candidate => {
    const check = checkLocation(candidate.location, blobs)
    const input = { candidate, locationCheck: check.status, ownerCollision: collisions.has(candidate.candidateId) }
    const { eligibility, reasons } = decideEligibility(input)
    const { route } = routeCandidate(input)
    return {
      candidateId: candidate.candidateId,
      ruleId: candidate.ruleId,
      locationCheck: check.status,
      observed: check.observed ?? null,
      ownerCollision: collisions.has(candidate.candidateId),
      eligibility,
      reasons,
      route,
      location: candidate.location,
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
//   node scripts/prepare-verification.mjs --merge-base <sha> < candidates.json
//
// stdin  : { "results": [ <REVIEW_RESULT_CONTRACT_V1>, … ] }   preferred — pipe what you have
//          { "locations": [ {ruleId, path, line, quote}, … ] }  light form for a
//                                                              consolidated pass
//          { "candidates": [ … ] }                            when the caller owns the ids
// stdout : { "candidates": [ … ], "bundles": [ … ], "counts": { … } }
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
  const resolved = resolve(root, candidatePath)
  const prefix = root.endsWith(sep) ? root : root + sep
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

async function main() {
  const argv = process.argv.slice(2)
  const mergeBaseIndex = argv.indexOf('--merge-base')
  const mergeBase = mergeBaseIndex === -1 ? 'HEAD' : argv[mergeBaseIndex + 1]
  const locationsOnly = argv.includes('--locations-only')

  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let payload
  try {
    payload = JSON.parse(raw)
  } catch (error) {
    process.stderr.write(`stdin is not valid JSON: ${error.message}\n`)
    process.exit(2)
  }
  // Producer results are what the orchestrator already holds, so that is the cheap shape.
  // The candidates shape stays accepted for callers that assign their own ids.
  const candidates = Array.isArray(payload)
    ? payload
    : payload.locations
      ? candidatesFromLocations(payload.locations)
      : payload.results
        ? candidatesFromResults(payload.results)
        : (payload.candidates ?? [])
  const result = prepareVerification(candidates, collectBlobs(candidates, gitReaders(mergeBase)), { locationsOnly })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
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
  for (const result of results ?? []) {
    for (const finding of result?.findings ?? []) {
      const { ruleId, repairedFrom } = normalizeRuleId(finding?.ruleId)
      if (repairedFrom) ruleIdRepairs.push({ from: repairedFrom, to: ruleId })
      collected.push(ruleId === finding?.ruleId ? finding : { ...finding, ruleId })
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
    ].join(' ')
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
      candidates.push({
        candidateId: `${ruleId}#${index + 1}`,
        ruleId,
        impact: finding.impact,
        confidence: finding.confidence,
        category: finding.category,
        location: finding.location,
        // 병합된 instance를 candidate에 붙여 보낸다. 이것이 없으면 canonical
        // candidate 하나가 원래 몇 건이었는지 사후에 알 수 없다.
        memberInstanceIds: finding.memberInstanceIds ?? [],
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
