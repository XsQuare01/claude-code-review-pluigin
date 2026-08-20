import { execFileSync } from 'node:child_process'
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
  }

  return { candidates: decided, bundles: buildBundles(decided), counts }
}

// ---------------------------------------------------------------------- CLI
//
//   node scripts/prepare-verification.mjs --merge-base <sha> < candidates.json
//
// stdin  : { "results": [ <REVIEW_RESULT_CONTRACT_V1>, … ] }   preferred — pipe what you have
//          { "candidates": [ … ] }                            when the caller owns the ids
// stdout : { "candidates": [ … ], "bundles": [ … ], "counts": { … } }
//
// --locations-only : location checks and their counts, with no eligibility, route or
//                    bundle. For workflows that have no rebuttal pass.
//
// Blobs are read here rather than passed in, so the caller does not have to
// serialize file contents and cannot accidentally supply the wrong revision.

function readBlobs(candidates, mergeBase) {
  const head = {}
  const base = {}
  const show = ref => {
    try {
      // A missing path is an expected outcome, not a problem to report on stderr.
      return execFileSync('git', ['show', ref], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return undefined
    }
  }
  for (const candidate of candidates) {
    const location = candidate?.location
    const path = location?.path
    if (typeof path !== 'string') continue
    if (location.kind === 'deleted') {
      if (!(path in base)) base[path] = show(`${mergeBase}:${path}`)
    } else if (!(path in head)) {
      head[path] = show(`HEAD:${path}`)
    }
  }
  return { head, base }
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
    : payload.results
      ? candidatesFromResults(payload.results)
      : (payload.candidates ?? [])
  const result = prepareVerification(candidates, readBlobs(candidates, mergeBase), { locationsOnly })
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
export function candidatesFromResults(results) {
  const findings = []
  for (const result of results ?? []) {
    for (const finding of result?.findings ?? []) findings.push(finding)
  }

  const sortKey = finding => {
    const location = finding.location ?? {}
    const line = location.line ?? location.lineBefore ?? 0
    return `${location.path ?? ''}:${String(line).padStart(9, '0')}:${finding.title ?? ''}`
  }

  const byRule = new Map()
  for (const finding of findings) {
    const ruleId = finding.ruleId ?? 'unknown'
    if (!byRule.has(ruleId)) byRule.set(ruleId, [])
    byRule.get(ruleId).push(finding)
  }

  const candidates = []
  for (const [ruleId, group] of byRule) {
    group.sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
    group.forEach((finding, index) => {
      candidates.push({
        candidateId: `${ruleId}#${index + 1}`,
        ruleId,
        impact: finding.impact,
        confidence: finding.confidence,
        category: finding.category,
        location: finding.location,
      })
    })
  }
  return candidates
}
