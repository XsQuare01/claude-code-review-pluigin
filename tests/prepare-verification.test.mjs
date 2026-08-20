import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeForCompare,
  checkLocation,
  computeOwnerCollisions,
  decideEligibility,
  routeCandidate,
  buildBundles,
  prepareVerification,
  candidatesFromResults,
} from '../scripts/prepare-verification.mjs'

// ------------------------------------------------------------- normalization

test('normalizeForCompare trims the ends and normalizes line endings', () => {
  assert.equal(normalizeForCompare('  if (pending) return\r\n'), 'if (pending) return')
})

test('normalizeForCompare preserves internal whitespace', () => {
  assert.notEqual(normalizeForCompare('const a = "x  y"'), normalizeForCompare('const a = "x y"'))
})

test('normalizeForCompare strips a leading BOM', () => {
  assert.equal(normalizeForCompare('﻿import x from "y"'), 'import x from "y"')
})

// ------------------------------------------------------------ location check

const blobs = {
  head: {
    'src/hooks/use-camera.ts': 'const a = 1\nif (pending) return\nconst b = 2\n',
    'src/wide.ts': 'first\nsecond\n',
  },
  base: {
    'src/features/chat/use-room.ts': 'a\nb\nreturn () => subscription.unsubscribe()\n',
  },
}

test('verified location whose quote matches the HEAD line is location-ok', () => {
  const result = checkLocation({ kind: 'verified', path: 'src/hooks/use-camera.ts', line: 2, quote: 'if (pending) return' }, blobs)
  assert.equal(result.status, 'location-ok')
})

test('verified location whose quote differs from the HEAD line is location-mismatch', () => {
  const result = checkLocation({ kind: 'verified', path: 'src/hooks/use-camera.ts', line: 2, quote: 'if (busy) return' }, blobs)
  assert.equal(result.status, 'location-mismatch')
  assert.equal(result.observed, 'if (pending) return')
})

test('verified location past the end of the file is location-mismatch', () => {
  const result = checkLocation({ kind: 'verified', path: 'src/wide.ts', line: 99, quote: 'first' }, blobs)
  assert.equal(result.status, 'location-mismatch')
})

test('a path that is absent from the blob set is location-unresolvable', () => {
  const result = checkLocation({ kind: 'verified', path: 'src/gone.ts', line: 1, quote: 'x' }, blobs)
  assert.equal(result.status, 'location-unresolvable')
})

test('deleted location is compared against the MERGE_BASE blob, not HEAD', () => {
  const result = checkLocation(
    { kind: 'deleted', path: 'src/features/chat/use-room.ts', lineBefore: 3, quote: 'return () => subscription.unsubscribe()' },
    blobs,
  )
  assert.equal(result.status, 'location-ok')
})

test('a multi-line span is compared across the whole range', () => {
  const result = checkLocation(
    { kind: 'verified', path: 'src/hooks/use-camera.ts', line: 1, endLine: 2, quote: 'const a = 1\nif (pending) return' },
    blobs,
  )
  assert.equal(result.status, 'location-ok')
})

test('unverified location is not compared', () => {
  const result = checkLocation({ kind: 'unverified', reason: '확인하지 못했습니다' }, blobs)
  assert.equal(result.status, 'not-applicable')
})

// ----------------------------------------------------------- owner collision

test('two rules anchored on the same normalized location collide', () => {
  const collisions = computeOwnerCollisions([
    { candidateId: 'a', ruleId: '17-3', location: { kind: 'verified', path: 'src/x.ts', line: 10, quote: 'q' } },
    { candidateId: 'b', ruleId: 'EX-4', location: { kind: 'verified', path: 'src/x.ts', line: 10, quote: 'q' } },
  ])
  assert.deepEqual([...collisions].sort(), ['a', 'b'])
})

test('the same rule reported twice at one location is not an owner collision', () => {
  const collisions = computeOwnerCollisions([
    { candidateId: 'a', ruleId: '17-3', location: { kind: 'verified', path: 'src/x.ts', line: 10, quote: 'q' } },
    { candidateId: 'b', ruleId: '17-3', location: { kind: 'verified', path: 'src/x.ts', line: 10, quote: 'q' } },
  ])
  assert.equal(collisions.size, 0)
})

// -------------------------------------------------------------- eligibility

const verifiedLocation = { kind: 'verified', path: 'src/x.ts', line: 10, quote: 'q' }
const settled = { locationCheck: 'location-ok', ownerCollision: false }

test('a high-impact candidate is eligible', () => {
  const decision = decideEligibility({ candidate: { impact: 'high', confidence: 'high', category: 'user-malfunction', location: verifiedLocation }, ...settled })
  assert.equal(decision.eligibility, 'VERIFY')
})

test('a low-confidence candidate is eligible', () => {
  const decision = decideEligibility({ candidate: { impact: 'low', confidence: 'low', location: verifiedLocation }, ...settled })
  assert.equal(decision.eligibility, 'VERIFY')
})

test('an unverified location makes a candidate eligible', () => {
  const decision = decideEligibility({ candidate: { impact: 'low', confidence: 'high', location: { kind: 'unverified', reason: 'r' } }, ...settled })
  assert.equal(decision.eligibility, 'VERIFY')
})

test('a location mismatch makes a candidate eligible', () => {
  const decision = decideEligibility({ candidate: { impact: 'low', confidence: 'high', location: verifiedLocation }, locationCheck: 'location-mismatch', ownerCollision: false })
  assert.equal(decision.eligibility, 'VERIFY')
})

test('an owner collision makes a candidate eligible', () => {
  const decision = decideEligibility({ candidate: { impact: 'low', confidence: 'high', location: verifiedLocation }, locationCheck: 'location-ok', ownerCollision: true })
  assert.equal(decision.eligibility, 'VERIFY')
})

test('a settled low-impact high-confidence candidate is not eligible', () => {
  const decision = decideEligibility({ candidate: { impact: 'low', confidence: 'high', location: verifiedLocation }, ...settled })
  assert.equal(decision.eligibility, 'SKIP-VERIFY')
})

test('eligibility is deterministic — the same input yields the same decision', () => {
  const input = { candidate: { impact: 'low', confidence: 'high', location: verifiedLocation }, ...settled }
  const first = decideEligibility(input)
  assert.equal(first.eligibility, 'SKIP-VERIFY')
  assert.deepEqual(first, decideEligibility(input))
})

// ----------------------------------------------------------------- routing

test('a settled verified candidate routes to a bundle', () => {
  const route = routeCandidate({ candidate: { impact: 'high', confidence: 'high', category: 'user-malfunction', location: verifiedLocation }, ...settled })
  assert.equal(route.route, 'bundle')
})

test('a deleted location is promoted to isolated verification', () => {
  const route = routeCandidate({ candidate: { impact: 'high', confidence: 'high', category: 'user-malfunction', location: { kind: 'deleted', path: 'src/x.ts', lineBefore: 3, quote: 'q' } }, ...settled })
  assert.equal(route.route, 'isolated')
})

test('an unverified location is promoted to isolated verification', () => {
  const route = routeCandidate({ candidate: { impact: 'high', confidence: 'high', category: 'user-malfunction', location: { kind: 'unverified', reason: 'r' } }, ...settled })
  assert.equal(route.route, 'isolated')
})

test('a security-exposure candidate is promoted to isolated verification', () => {
  const route = routeCandidate({ candidate: { impact: 'high', confidence: 'high', category: 'security-exposure', location: verifiedLocation }, ...settled })
  assert.equal(route.route, 'isolated')
})

test('an owner collision is promoted to isolated verification', () => {
  const route = routeCandidate({ candidate: { impact: 'high', confidence: 'high', category: 'user-malfunction', location: verifiedLocation }, locationCheck: 'location-ok', ownerCollision: true })
  assert.equal(route.route, 'isolated')
})

test('a location mismatch is promoted to isolated verification', () => {
  const route = routeCandidate({ candidate: { impact: 'high', confidence: 'high', category: 'user-malfunction', location: verifiedLocation }, locationCheck: 'location-mismatch', ownerCollision: false })
  assert.equal(route.route, 'isolated')
})

// ----------------------------------------------------------------- bundling

test('bundles group eligible candidates by anchor file', () => {
  const bundles = buildBundles([
    { candidateId: 'a', route: 'bundle', location: { kind: 'verified', path: 'src/x.ts', line: 1, quote: 'q' } },
    { candidateId: 'b', route: 'bundle', location: { kind: 'verified', path: 'src/x.ts', line: 9, quote: 'q' } },
    { candidateId: 'c', route: 'bundle', location: { kind: 'verified', path: 'src/y.ts', line: 1, quote: 'q' } },
  ])
  assert.equal(bundles.length, 2)
  assert.deepEqual(bundles.find(b => b.anchorPath === 'src/x.ts').candidateIds, ['a', 'b'])
})

test('a file with no bundle-routed candidate produces no bundle', () => {
  const bundles = buildBundles([
    { candidateId: 'a', route: 'isolated', location: { kind: 'verified', path: 'src/x.ts', line: 1, quote: 'q' } },
  ])
  assert.deepEqual(bundles, [])
})

// ------------------------------------------------------- composed preparation

test('prepareVerification reports counts that reconcile with the candidate total', () => {
  const result = prepareVerification(
    [
      { candidateId: 'a', ruleId: '17-3', impact: 'high', confidence: 'high', category: 'user-malfunction', location: { kind: 'verified', path: 'src/hooks/use-camera.ts', line: 2, quote: 'if (pending) return' } },
      { candidateId: 'b', ruleId: '05-4', impact: 'low', confidence: 'high', location: { kind: 'verified', path: 'src/hooks/use-camera.ts', line: 1, quote: 'const a = 1' } },
      { candidateId: 'c', ruleId: '20-4', impact: 'low', confidence: 'low', location: { kind: 'deleted', path: 'src/features/chat/use-room.ts', lineBefore: 3, quote: 'return () => subscription.unsubscribe()' } },
    ],
    blobs,
  )
  assert.equal(result.counts.total, 3)
  assert.equal(result.counts.verify + result.counts.skipVerify, result.counts.total)
  assert.equal(result.counts.bundle + result.counts.isolated, result.counts.verify)
})

test('prepareVerification counts a settled low-impact candidate as skipped, not verified', () => {
  const result = prepareVerification(
    [{ candidateId: 'b', ruleId: '05-4', impact: 'low', confidence: 'high', location: { kind: 'verified', path: 'src/hooks/use-camera.ts', line: 1, quote: 'const a = 1' } }],
    blobs,
  )
  assert.equal(result.counts.verify, 0)
  assert.equal(result.counts.skipVerify, 1)
})

test('prepareVerification carries the per-candidate decision alongside the counts', () => {
  const result = prepareVerification(
    [{ candidateId: 'a', ruleId: '17-3', impact: 'high', confidence: 'high', category: 'security-exposure', location: { kind: 'verified', path: 'src/hooks/use-camera.ts', line: 2, quote: 'if (pending) return' } }],
    blobs,
  )
  const decision = result.candidates.find(entry => entry.candidateId === 'a')
  assert.equal(decision.eligibility, 'VERIFY')
  assert.equal(decision.route, 'isolated')
  assert.equal(decision.locationCheck, 'location-ok')
})

// ------------------------------------------- producer results as direct input

const producerResults = [
  {
    schemaVersion: 1,
    findings: [
      { ruleId: '17-3', title: 'a', body: 'b', impact: 'high', category: 'user-malfunction', evidence: 'e', confidence: 'high', location: { kind: 'verified', path: 'src/hooks/use-camera.ts', line: 2, quote: 'if (pending) return' } },
      { ruleId: '17-3', title: 'c', body: 'd', impact: 'low', confidence: 'high', location: { kind: 'verified', path: 'src/hooks/use-camera.ts', line: 1, quote: 'const a = 1' } },
    ],
    openQuestions: [],
  },
  {
    schemaVersion: 1,
    findings: [
      { ruleId: '05-4', title: 'e', body: 'f', impact: 'low', confidence: 'high', location: { kind: 'verified', path: 'src/wide.ts', line: 1, quote: 'first' } },
    ],
    openQuestions: [],
  },
]

test('candidatesFromResults flattens producer findings without needing a caller-supplied id', () => {
  const candidates = candidatesFromResults(producerResults)
  assert.equal(candidates.length, 3)
  assert.deepEqual(candidates.map(c => c.ruleId).sort(), ['05-4', '17-3', '17-3'])
})

test('candidate ids are ordinal within a rule id, so they trace back to the report', () => {
  const ids = candidatesFromResults(producerResults).map(c => c.candidateId).sort()
  assert.deepEqual(ids, ['05-4#1', '17-3#1', '17-3#2'])
})

test('candidate ids are stable across runs for the same input', () => {
  const first = candidatesFromResults(producerResults).map(c => c.candidateId)
  const again = candidatesFromResults(producerResults).map(c => c.candidateId)
  assert.equal(first.length, 3)
  assert.deepEqual(first, again)
})

test('candidate ids do not depend on the order producers happened to return in', () => {
  const forward = candidatesFromResults(producerResults)
  const reversed = candidatesFromResults([...producerResults].reverse())
  const key = list => list.map(c => `${c.candidateId}:${c.location.line}`).sort()
  assert.equal(forward.length, 3)
  assert.deepEqual(key(forward), key(reversed))
})

test('a finding with an unverified location still receives an id', () => {
  const candidates = candidatesFromResults([
    { schemaVersion: 1, findings: [{ ruleId: '09-1', title: 't', body: 'b', impact: 'low', confidence: 'low', reason: 'r', location: { kind: 'unverified', reason: 'not found' } }], openQuestions: [] },
  ])
  assert.equal(candidates[0].candidateId, '09-1#1')
})

test('prepareVerification accepts producer results directly and still reconciles', () => {
  const result = prepareVerification(candidatesFromResults(producerResults), blobs)
  assert.equal(result.counts.total, 3)
  assert.equal(result.counts.verify + result.counts.skipVerify, result.counts.total)
})
