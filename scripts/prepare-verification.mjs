import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { markedBlock } from './lib/contract-blocks.mjs'
import { logPhase, readEvents, requireStartedTimeline } from './lib/run-record.mjs'
import {
  buildTaskPrompt, docPathForRule, extractClause, instructionsWithManifest, planVerifierTasks,
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
  const verifyIndex = argv.indexOf('--verify')
  const verifyMode = verifyIndex === -1 ? 'selective' : argv[verifyIndex + 1]
  if (!['selective', 'off'].includes(verifyMode)) {
    process.stderr.write(`--verify는 selective 또는 off다 (받은 값: ${JSON.stringify(verifyMode)}). exhaustive 라우팅은 이 스크립트가 아직 하지 않는다\n`)
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

  let source
  let payload
  let collected
  if (collect) {
    source = '--collect'
    const gathered = collectResultFiles({
      events: readEvents(sidecar),
      sourceNames: sourceNames.value,
      pathOf: name => join(dir, '.timing', `${run}.${name}.json`),
      read: path => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
    })
    if (gathered.problems.length) fail(`모듈별 결과를 모으지 못했다:\n  - ${gathered.problems.join('\n  - ')}`)
    for (const warning of gathered.warnings) process.stderr.write(`경고: ${warning}\n`)
    payload = gathered.payload
    collected = gathered.collected
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

  const problems = payloadProblems(payload, sourceNames.value)
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
  const result = prepareVerification(candidates, collectBlobs(candidates, gitReaders(mergeBase)), { locationsOnly })
  if (collected) result.collected = collected

  // 검증자 프롬프트는 여기서 파일로 만든다. 오케스트레이터는 그 내용을 넘기기만
  // 한다 — 다시 쓰지 않는다(`lib/verifier-tasks.mjs` 머리말).
  let written = { tasks: [], promotions: {} }
  if (!locationsOnly) {
    if (verifyMode !== 'off') {
      written = writeVerifierTasks({ result, rulesDir, mergeBase, outDir: resolve(dir, '.timing', `${run}.verify`), fail })
    }
    result.verifierTasks = written.tasks
    result.promotions = written.promotions
  }

  logPhase(dir, run, 'script.done', { ran: true, counts: result.counts })
  // 교차검증의 시작은 **검증자를 띄울 준비가 끝난 이 자리**에서 남긴다. 오케스트레이터가
  // 남기게 두었더니 2026-09-30 실행이 검증자 19개가 다 끝난 뒤에야 찍었고, 80분
  // 검증이 "무엇이 돌았는지 기록에 없는 5173초"로 보였다.
  if (written.tasks.length) logPhase(dir, run, 'crossverify.start', { targets: result.counts.verify })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

/**
 * 모듈별 결과 파일(`<run>.<규칙 문서 이름>.json`)을 envelope 입력으로 모은다.
 *
 * 기준은 파일이 아니라 **기록**이다. 마지막 `module.done`이 `failed`가 아닌 모듈은
 * 결과 파일이 반드시 있어야 하고, 없으면 거부한다 — 모은 것만 보고 넘어가면 빠진
 * 모듈이 "지적 0건"과 구분되지 않는다. `failed`로 끝난 모듈의 파일은 쓰지 않는다
 * (C-6A: 실패한 패스를 부분 보정으로 통과시키지 않는다). 기록 없이 파일만 있으면
 * 쓰되 경고한다.
 */
export function collectResultFiles({ events, sourceNames, pathOf, read }) {
  const finalStatus = new Map()
  for (const event of events) {
    if (event?.phase === 'module.done') finalStatus.set(String(event.module), event.status)
  }
  const results = []
  const problems = []
  const warnings = []
  const collected = { sources: [], excludedFailed: [], withoutModuleDone: [] }
  for (const name of sourceNames) {
    const path = pathOf(name)
    const raw = read(path)
    const status = finalStatus.get(name)
    if (status === 'failed') {
      if (raw !== undefined) {
        collected.excludedFailed.push(name)
        warnings.push(`${name}는 마지막 module.done이 failed라 결과 파일을 쓰지 않는다: ${path}`)
      }
      continue
    }
    if (raw === undefined) {
      if (status !== undefined) problems.push(`${name}는 module.done이 있는데 결과 파일이 없다: ${path}`)
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      problems.push(`${path}를 JSON으로 읽지 못했다: ${error.message}`)
      continue
    }
    if (status === undefined) {
      collected.withoutModuleDone.push(name)
      warnings.push(`${name}는 module.done 없이 결과 파일만 있다 — 쓰지만 기록에 그 모듈이 끝난 흔적이 없다: ${path}`)
    }
    results.push({ source: name, result: parsed })
    collected.sources.push(name)
  }
  return { payload: { results }, problems, warnings, collected }
}

/**
 * verifier 작업마다 프롬프트 파일을 쓰고, 그 목록을 돌려준다.
 *
 * 지시문·manifest·규칙 문서는 모두 `rulesDir`에서 읽는다 — producer가 읽은 규칙과
 * 검증자가 받는 규칙이 같아야 한다. 디렉터리는 실행마다 새로 만든다. 앞 실행의
 * 파일이 남으면 이번 목록에 없는 작업이 디렉터리에는 있게 된다.
 */
function writeVerifierTasks({ result, rulesDir, mergeBase, outDir, fail }) {
  const planned = planVerifierTasks(result)
  if (!planned.tasks.length) return { tasks: [], promotions: {} }

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
  for (const candidate of result.candidates) {
    if (clauses.has(candidate.ruleId)) continue
    const docPath = docPathForRule(candidate.ruleId, catalog)
    if (docPath && !docs.has(docPath)) docs.set(docPath, readRule(docPath))
    clauses.set(candidate.ruleId, docPath ? extractClause(docs.get(docPath), candidate.ruleId) : null)
  }

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const candidatesById = new Map(result.candidates.map(candidate => [candidate.candidateId, candidate]))
  // 검증자가 돌려준 JSON을 남길 자리(`verdict`)도 여기서 정한다. 오케스트레이터가
  // 이름을 지으면 실행마다 달라지고, `tally-verdicts.mjs --collect`가 찾지 못한다.
  const write = task => {
    const { prompt, missingClauses } = buildTaskPrompt({ instructions: instructions.value, task, candidatesById, clauses, mergeBase })
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
  return { tasks, promotions }
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
