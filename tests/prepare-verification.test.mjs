import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

import {
  normalizeForCompare,
  checkLocation,
  computeOwnerCollisions,
  decideEligibility,
  routeCandidate,
  buildBundles,
  prepareVerification,
  candidatesFromResults,
  collectBlobs,
  resolveWithinRoot,
  candidatesFromLocations,
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

// -------------------------------------------------------------- blob sources

const readers = {
  working: path => (path === 'src/edited.ts' ? 'working tree line\n' : undefined),
  head: path => (path === 'src/edited.ts' ? 'committed line\n' : path === 'src/clean.ts' ? 'clean line\n' : undefined),
  base: path => (path === 'src/gone.ts' ? 'removed line\n' : undefined),
}

test('a verified location reads the working tree, which is what the producer read', () => {
  const collected = collectBlobs([{ location: { kind: 'verified', path: 'src/edited.ts', line: 1, quote: 'x' } }], readers)
  assert.equal(collected.head['src/edited.ts'], 'working tree line\n')
})

test('a verified location falls back to HEAD when the file is not in the working tree', () => {
  const collected = collectBlobs([{ location: { kind: 'verified', path: 'src/clean.ts', line: 1, quote: 'x' } }], readers)
  assert.equal(collected.head['src/clean.ts'], 'clean line\n')
})

test('a deleted location reads the merge base, not the working tree', () => {
  const collected = collectBlobs([{ location: { kind: 'deleted', path: 'src/gone.ts', lineBefore: 1, quote: 'x' } }], readers)
  assert.equal(collected.base['src/gone.ts'], 'removed line\n')
  assert.equal(collected.head['src/gone.ts'], undefined)
})

test('an uncommitted edit does not produce a false location mismatch', () => {
  const candidates = [{ candidateId: 'a#1', ruleId: 'a', impact: 'low', confidence: 'high', location: { kind: 'verified', path: 'src/edited.ts', line: 1, quote: 'working tree line' } }]
  const result = prepareVerification(candidates, collectBlobs(candidates, readers), { locationsOnly: true })
  assert.equal(result.candidates[0].locationCheck, 'location-ok')
})

// ------------------------------------------------------------- stable sorting

test('candidate ordering uses code points, so it does not shift with the machine locale', () => {
  const ids = candidatesFromResults([
    {
      schemaVersion: 1,
      openQuestions: [],
      findings: [
        { ruleId: '01-1', title: 't', body: 'b', impact: 'low', confidence: 'high', location: { kind: 'verified', path: 'a.ts', line: 1, quote: 'q' } },
        { ruleId: '01-1', title: 't', body: 'b', impact: 'low', confidence: 'high', location: { kind: 'verified', path: 'B.ts', line: 1, quote: 'q' } },
      ],
    },
  ])
  // 'B' (0x42) sorts before 'a' (0x61) by code point; most locales collate the other way.
  assert.deepEqual(ids.map(c => `${c.candidateId}:${c.location.path}`), ['01-1#1:B.ts', '01-1#2:a.ts'])
})

// ------------------------------------------------------------ locations only

test('prepareVerification in locations-only mode reports location checks without eligibility', () => {
  const result = prepareVerification(candidatesFromResults(producerResults), blobs, { locationsOnly: true })
  assert.equal(result.counts.total, 3)
  assert.equal(result.counts.locationOk + result.counts.locationMismatch + result.counts.locationUnresolvable, result.counts.total)
})

test('locations-only omits eligibility, routing and bundles so a report cannot imply a verify pass ran', () => {
  const result = prepareVerification(candidatesFromResults(producerResults), blobs, { locationsOnly: true })
  assert.equal(result.bundles, undefined)
  assert.equal(result.counts.verify, undefined)
  assert.equal(result.counts.bundle, undefined)
  for (const candidate of result.candidates) {
    assert.equal(candidate.eligibility, undefined)
    assert.equal(candidate.route, undefined)
    assert.ok(candidate.locationCheck)
  }
})

test('locations-only still reports the mismatch so the renderer can fall back to 위치 미확인', () => {
  const result = prepareVerification(
    [{ candidateId: 'x#1', ruleId: '03-1', impact: 'low', confidence: 'high', location: { kind: 'verified', path: 'src/hooks/use-camera.ts', line: 2, quote: 'WRONG' } }],
    blobs,
    { locationsOnly: true },
  )
  assert.equal(result.candidates[0].locationCheck, 'location-mismatch')
  assert.equal(result.counts.locationMismatch, 1)
})

test('the default mode is unchanged and still reports eligibility', () => {
  const result = prepareVerification(candidatesFromResults(producerResults), blobs)
  assert.ok(result.bundles)
  assert.equal(typeof result.counts.verify, 'number')
})

// ---------------------------------------------------------- path containment

// Derived rather than written as a literal — a Windows path spelled inline invites an
// escaping mistake that makes every case fail for the wrong reason.
const ROOT = process.cwd()

test('a repo-relative source path resolves inside the root', () => {
  assert.ok(resolveWithinRoot('src/hooks/use-camera.ts', ROOT))
})

test('an absolute path is refused', () => {
  assert.equal(resolveWithinRoot(resolve(ROOT, 'src/x.ts'), ROOT), null)
  assert.equal(resolveWithinRoot('/etc/passwd', ROOT), null)
})

test('a parent traversal is refused', () => {
  assert.equal(resolveWithinRoot('../.claude/settings.json', ROOT), null)
})

test('a traversal buried mid-path is refused', () => {
  assert.equal(resolveWithinRoot('src/a/../../../outside.ts', ROOT), null)
})

test('the git directory is refused', () => {
  assert.equal(resolveWithinRoot('.git/config', ROOT), null)
  assert.equal(resolveWithinRoot('.git', ROOT), null)
})

test('a directory that merely starts with .git is still readable', () => {
  // .github is not .git — comparing string prefixes instead of path segments would refuse it.
  assert.ok(resolveWithinRoot('.github/workflows/validate.yml', ROOT))
})

test('a refused path yields location-unresolvable rather than reading the file', () => {
  const candidates = [{ candidateId: 'p#1', ruleId: 'x', impact: 'low', confidence: 'high', location: { kind: 'verified', path: '../secret.json', line: 1, quote: 'q' } }]
  const guarded = {
    working: path => (resolveWithinRoot(path, ROOT) ? 'readable\n' : undefined),
    head: () => undefined,
    base: () => undefined,
  }
  const result = prepareVerification(candidates, collectBlobs(candidates, guarded), { locationsOnly: true })
  assert.equal(result.candidates[0].locationCheck, 'location-unresolvable')
})

// ------------------------------------------------------------- id tie-break

const tiedResult = body => ({
  schemaVersion: 1,
  openQuestions: [],
  findings: [{ ruleId: '01-1', title: 't', body, impact: 'low', confidence: 'high', location: { kind: 'verified', path: 'a.ts', line: 1, quote: `q-${body}` } }],
})

test('two findings that differ only below the title keep their ids when producer order flips', () => {
  const forward = candidatesFromResults([tiedResult('A'), tiedResult('B')])
  const reverse = candidatesFromResults([tiedResult('B'), tiedResult('A')])
  const pair = list => list.map(c => `${c.candidateId}:${c.location.quote}`).sort()
  assert.deepEqual(pair(forward), pair(reverse))
  assert.deepEqual(pair(forward), ['01-1#1:q-A', '01-1#2:q-B'])
})

test('all four location states account for the total', () => {
  const candidates = [
    { candidateId: 'a#1', ruleId: 'a', impact: 'low', confidence: 'high', location: { kind: 'verified', path: 'src/hooks/use-camera.ts', line: 2, quote: 'if (pending) return' } },
    { candidateId: 'b#1', ruleId: 'b', impact: 'low', confidence: 'high', location: { kind: 'verified', path: 'src/hooks/use-camera.ts', line: 2, quote: 'WRONG' } },
    { candidateId: 'c#1', ruleId: 'c', impact: 'low', confidence: 'high', location: { kind: 'verified', path: 'src/gone.ts', line: 1, quote: 'q' } },
    { candidateId: 'd#1', ruleId: 'd', impact: 'low', confidence: 'low', location: { kind: 'unverified', reason: 'r' } },
  ]
  const { counts } = prepareVerification(candidates, blobs, { locationsOnly: true })
  assert.equal(counts.locationOk + counts.locationMismatch + counts.locationUnresolvable + counts.locationNotApplicable, counts.total)
  assert.equal(counts.locationNotApplicable, 1)
})

// ------------------------------------------------------- light location input

const manifest = [
  { ruleId: '03-1', path: 'src/hooks/use-camera.ts', line: 2, quote: 'if (pending) return' },
  { ruleId: '03-1', path: 'src/hooks/use-camera.ts', line: 1, quote: 'const a = 1' },
  { ruleId: '09-4', path: 'src/wide.ts', line: 1, quote: 'first' },
]

test('candidatesFromLocations accepts the light manifest a consolidated pass can afford', () => {
  const candidates = candidatesFromLocations(manifest)
  assert.equal(candidates.length, 3)
  assert.deepEqual(candidates.map(c => c.candidateId).sort(), ['03-1#1', '03-1#2', '09-4#1'])
  assert.equal(candidates[0].location.kind, 'verified')
})

test('the light manifest checks locations exactly like a full producer result would', () => {
  const candidates = candidatesFromLocations(manifest)
  const { counts } = prepareVerification(candidates, blobs, { locationsOnly: true })
  assert.equal(counts.total, 3)
  assert.equal(counts.locationOk, 3)
})

test('a manifest row with a wrong quote is reported as a mismatch', () => {
  const candidates = candidatesFromLocations([{ ruleId: '03-1', path: 'src/hooks/use-camera.ts', line: 2, quote: 'WRONG' }])
  const { counts } = prepareVerification(candidates, blobs, { locationsOnly: true })
  assert.equal(counts.locationMismatch, 1)
})

test('a row missing its line or quote is dropped rather than checked as if complete', () => {
  // A dropped row must not silently become a passing check — the caller counts what came
  // back against what it sent, so a drop shows up as a count mismatch instead.
  const candidates = candidatesFromLocations([
    { ruleId: '03-1', path: 'src/x.ts' },
    { ruleId: '03-1', path: 'src/x.ts', line: 1, quote: 'q' },
  ])
  assert.equal(candidates.length, 1)
})
