import * as nodeFs from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

import { writeTextAtomic } from './atomic-write.mjs'

// 지적별 재현 근거(C-11, #88 PR 2).
//
// 리포트의 지적은 "왜 그런가"를 본문으로 말하지만, **어떻게 확인했는가**는 말하지 않았다.
// 코드를 읽고 경로를 따라간 것인지, 실제로 돌려서 본 것인지, 확인하지 못한 것인지가 같은
// 모양의 산문으로 섞인다. 읽는 사람은 그 지적을 다시 확인할 길이 없고, 모델은 돌려 보지 않은
// 것을 "실행해서 확인했다"고 쓸 수 있다.
//
// 그래서 근거를 지적 옆의 별도 파일(sidecar)로 둔다. producer 출력(V1)에는 손대지 않는다.
//
// - `method`는 셋이다: `static-trace`(코드 경로 분석) · `executed`(실행) · `not-run`(확인 안 함)
// - **`executed`는 스크립트가 실제로 돌린 기록이 있어야만 붙는다.** 실행 기록은
//   `review-evidence.mjs exec`만 쓴다. 기록 파일·로그 파일·타임라인의 `tool.start`/`tool.done`이
//   서로를 가리키므로, 산문으로 "돌려 봤다"고 적는 것으로는 이 값을 만들 수 없다
// - 실행 기록은 **어느 대상에서 돌았는지**(HEAD·작업 트리 fingerprint, C-10)를 갖는다. 이번
//   실행의 대상과 다르면 근거로 쓰지 않는다
// - 재현 결과는 넷이다: `reproduced` · `not-reproduced` · `inconclusive` · `env-failure`.
//   **어느 것도 결함의 반증이 아니다** — 반증은 교차검증의 `rejected`이고, 이 파일은 지적의
//   존부·등급·판정을 바꾸지 않는다
//
// 이 장치는 착오를 막는다. 세 파일을 일부러 맞춰 위조하는 것까지 막지는 못한다.

export const EVIDENCE_SCHEMA_VERSION = 1
const DOC_KIND = 'review-evidence'
const RECORD_KIND = 'review-execution'

export const METHODS = ['static-trace', 'executed', 'not-run']
export const OUTCOMES = ['reproduced', 'not-reproduced', 'inconclusive', 'env-failure']
export const COMPARISONS = ['pre-existing', 'new-regression', 'base-unmeasured']
const SIDES = ['head', 'base']
const ENTRY_KEYS = new Set(['candidateId', 'method', 'condition', 'procedure', 'expected', 'observed', 'reason', 'codeRefs', 'executions'])

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0
export const sha256 = content => createHash('sha256').update(content).digest('hex')

/**
 * 실행 결과를 넷으로 나눈다. 모델이 아니라 이 함수가 정한다.
 *
 * - 시작하지 못했거나(`spawnError`), 시간을 넘겼거나, 신호로 죽었으면 `env-failure`다. 결함
 *   여부와 무관한 실패다
 * - 지정한 종료 코드로 끝났고, 지정한 출력이 있으면(지정했을 때) `reproduced`다
 * - 0으로 끝났으면 `not-reproduced`다. **반증이 아니다** — 재현 절차가 결함을 건드리지 못했을
 *   수도 있다
 * - 그 밖(예상하지 않은 종료 코드, 지정한 코드지만 지정한 출력이 없음)은 `inconclusive`다.
 *   다른 이유로 실패했을 수 있어 결함으로도 정상으로도 읽지 않는다
 */
export function classifyOutcome({ spawnError = null, timedOut = false, signal = null, exit = null, output = '', expectExit, expectOutput = null }) {
  if (spawnError) return { outcome: 'env-failure', reason: `시작하지 못했다: ${spawnError}` }
  if (timedOut) return { outcome: 'env-failure', reason: '시간 제한을 넘겨 멈췄다' }
  if (exit === null || exit === undefined) return { outcome: 'env-failure', reason: `신호 ${signal ?? '(알 수 없음)'}로 끝났다` }
  const outputMatches = !expectOutput || String(output).includes(expectOutput)
  if (expectExit.includes(exit) && outputMatches) {
    return { outcome: 'reproduced', reason: `종료 코드 ${exit}${expectOutput ? `와 지정한 출력` : ''}는 결함이 재현됐다는 뜻으로 지정한 결과다` }
  }
  if (exit === 0) return { outcome: 'not-reproduced', reason: '0으로 끝났고 지정한 재현 결과가 아니다' }
  if (expectExit.includes(exit)) return { outcome: 'inconclusive', reason: `지정한 종료 코드 ${exit}로 끝났지만 지정한 출력이 없다 — 다른 이유로 실패했을 수 있다` }
  return { outcome: 'inconclusive', reason: `예상하지 않은 종료 코드 ${exit}` }
}

/**
 * 실행 기록 하나를 이 실행의 근거로 쓸 수 있는가.
 *
 * - `other-run` — 다른 실행의 기록이다
 * - `other-target` — HEAD 쪽은 이번 실행의 HEAD·작업 트리, base 쪽은 merge-base의 깨끗한
 *   트리에서 돈 것이어야 한다. 같은 HEAD라도 작업 트리가 다르면 다른 코드를 돌린 것이다
 * - `tree-mutated` — 재현 명령이 작업 트리를 바꿨다. read-only 계약(C-6) 밖의 실행이고, 바꾼
 *   뒤의 트리가 리뷰 대상과 같다고 말할 수 없다
 * - `artifact-missing`·`artifact-changed` — 로그가 없거나 기록 뒤에 바뀌었다
 */
export function executionUsability(record, { run, artifactSha256 }) {
  if (record.runId !== run.runId) return { usable: false, reason: 'other-run' }
  const expected = record.side === 'base'
    ? { head: run.mergeBase, worktree: 'clean' }
    : { head: run.head, worktree: run.worktree }
  if (record.target?.head !== expected.head || record.target?.worktree !== expected.worktree) {
    return { usable: false, reason: 'other-target' }
  }
  if (record.mutatedTree) return { usable: false, reason: 'tree-mutated' }
  if (!artifactSha256) return { usable: false, reason: 'artifact-missing' }
  if (artifactSha256 !== record.artifact?.sha256) return { usable: false, reason: 'artifact-changed' }
  return { usable: true }
}

/** 실행 기록의 모양. 스크립트가 쓰지만, 읽을 때 손댄 파일을 가린다. */
export function executionProblems(record) {
  if (!isObject(record)) return ['실행 기록이 객체가 아니다']
  const problems = []
  if (record.schemaVersion !== EVIDENCE_SCHEMA_VERSION) problems.push(`지원하지 않는 schemaVersion ${JSON.stringify(record.schemaVersion)}`)
  if (record.kind !== RECORD_KIND) problems.push(`kind가 ${RECORD_KIND}가 아니다`)
  for (const key of ['id', 'runId', 'candidateId', 'startedAt']) if (!nonEmpty(record[key])) problems.push(`${key}가 없다`)
  if (!SIDES.includes(record.side)) problems.push('side가 head/base가 아니다')
  if (!OUTCOMES.includes(record.outcome)) problems.push(`outcome ${JSON.stringify(record.outcome)}는 ${OUTCOMES.join('/')} 밖이다`)
  if (!Array.isArray(record.command) || !record.command.length) problems.push('command가 없다')
  if (!isObject(record.target) || !nonEmpty(record.target.head) || !nonEmpty(record.target.worktree)) problems.push('target이 없다')
  if (!isObject(record.artifact) || !nonEmpty(record.artifact.path) || !/^[0-9a-f]{64}$/.test(String(record.artifact.sha256))) problems.push('artifact가 없다')
  return problems
}

/**
 * 근거 항목 하나의 계약 위반. 없으면 빈 배열이다.
 *
 * `executions`는 실행 ID → `{ record, usability }`다. `executed`는 **이 지적의, 쓸 수 있는
 * HEAD 쪽 기록**이 적어도 하나 있어야 한다 — 이것이 "실행하지 않은 분석에 executed를 붙일 수
 * 없다"의 실행 지점이다.
 */
export function entryProblems(entry, { candidateIds, executions }) {
  if (!isObject(entry)) return ['항목이 객체가 아니다']
  const problems = []
  const where = `${entry.candidateId ?? '(candidateId 없음)'}`
  const extra = Object.keys(entry).filter(key => !ENTRY_KEYS.has(key))
  if (extra.length) problems.push(`${where}: 계약 밖 키 ${extra.join(', ')}`)
  if (!nonEmpty(entry.candidateId) || !candidateIds.has(entry.candidateId)) {
    problems.push(`${where}: 이 실행의 후보가 아니다 — routed 출력의 candidateId를 쓴다`)
  }
  if (!METHODS.includes(entry.method)) {
    problems.push(`${where}: method ${JSON.stringify(entry.method)}는 ${METHODS.join('/')} 밖이다`)
    return problems
  }
  const require = keys => keys.filter(key => !nonEmpty(entry[key])).forEach(key => problems.push(`${where}: ${entry.method}에는 ${key}가 필요하다`))
  if (entry.method === 'static-trace') require(['condition', 'procedure', 'expected', 'observed'])
  if (entry.method === 'not-run') require(['reason'])
  if (entry.method === 'executed') {
    require(['condition', 'expected'])
    if (!Array.isArray(entry.executions) || !entry.executions.length) {
      problems.push(`${where}: executed에는 executions(review-evidence.mjs exec가 남긴 실행 ID)가 필요하다 — 실행하지 않았으면 static-trace나 not-run으로 적는다`)
    } else {
      for (const id of entry.executions) {
        const found = executions.get(id)
        if (!found) problems.push(`${where}: 실행 기록 ${JSON.stringify(id)}가 없다`)
        else if (found.record.candidateId !== entry.candidateId) problems.push(`${where}: 실행 기록 ${id}는 ${found.record.candidateId}의 것이다`)
      }
      const usableHead = entry.executions
        .map(id => executions.get(id))
        .filter(found => found && found.record.candidateId === entry.candidateId && found.record.side === 'head' && found.usability.usable)
      if (!usableHead.length && !problems.some(problem => problem.includes('실행 기록'))) {
        const reasons = entry.executions.map(id => `${id}: ${executions.get(id)?.usability.reason ?? '?'}`).join(', ')
        problems.push(`${where}: 근거로 쓸 수 있는 HEAD 쪽 실행 기록이 없다(${reasons}) — 실행 근거가 아니므로 static-trace나 not-run으로 적는다`)
      }
    }
  } else if (entry.executions !== undefined) {
    problems.push(`${where}: executions는 executed에만 쓴다`)
  }
  if (entry.codeRefs !== undefined && (!Array.isArray(entry.codeRefs) || entry.codeRefs.some(ref => !isObject(ref) || !nonEmpty(ref.path)))) {
    problems.push(`${where}: codeRefs는 {path, line?}의 배열이다`)
  }
  return problems
}

/**
 * HEAD와 base의 재현 결과로 기존 결함인지 신규 회귀인지 가른다.
 *
 * 양쪽을 **실제로 잰 경우에만** 결론을 낸다. base를 재지 못했거나(기록 없음·환경 실패·쓸 수
 * 없는 기록) 결과가 판단 불가면 `base-unmeasured`다 — 미측정을 "base에서는 정상"으로 읽으면
 * 기존 결함이 이 변경의 회귀로 둔갑한다(C-6 "게이트 수치는 baseline 대비로").
 */
export function compareSides(head, base) {
  if (!head?.usable || head.outcome !== 'reproduced') return null
  if (!base?.usable) return 'base-unmeasured'
  if (base.outcome === 'reproduced') return 'pre-existing'
  if (base.outcome === 'not-reproduced') return 'new-regression'
  return 'base-unmeasured'
}

const summarize = (found, id) => (found
  ? {
    id,
    side: found.record.side,
    outcome: found.record.outcome,
    outcomeReason: found.record.outcomeReason,
    exit: found.record.exit,
    artifact: found.record.artifact?.path,
    head: found.record.target?.head,
    usable: found.usability.usable,
    ...(found.usability.reason ? { reason: found.usability.reason } : {}),
  }
  : null)

/**
 * 항목 하나를 평가한다 — 렌더러와 스냅숏이 같은 결과를 쓴다.
 *
 * `executed`면 나열한 실행 중 쓸 수 있는 마지막 HEAD 기록(없으면 마지막 HEAD 기록)과 base
 * 기록을 고르고, 둘로 기존 결함·신규 회귀를 가른다.
 */
export function assessEntry(entry, executions) {
  const assessed = { candidateId: entry.candidateId, method: entry.method }
  for (const key of ['condition', 'procedure', 'expected', 'observed', 'reason']) if (nonEmpty(entry[key])) assessed[key] = entry[key]
  if (entry.method !== 'executed') return assessed
  const pick = side => {
    const ids = (entry.executions ?? []).filter(id => executions.get(id)?.record.side === side && executions.get(id)?.record.candidateId === entry.candidateId)
    const usable = ids.filter(id => executions.get(id).usability.usable)
    const id = (usable.length ? usable : ids).at(-1)
    return id === undefined ? null : summarize(executions.get(id), id)
  }
  assessed.head = pick('head')
  assessed.base = pick('base')
  assessed.comparison = compareSides(assessed.head, assessed.base)
  return assessed
}

/** 근거 파일의 모양. 실행 식별은 preflight가 남긴 run.start에서 온다. */
export function evidenceDocProblems(doc) {
  if (!isObject(doc)) return ['근거 파일이 JSON 객체가 아니다']
  if (doc.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    return [`지원하지 않는 schemaVersion ${JSON.stringify(doc.schemaVersion)} — 이 스크립트는 ${EVIDENCE_SCHEMA_VERSION}만 읽는다`]
  }
  const problems = []
  if (doc.kind !== DOC_KIND) problems.push(`kind가 ${DOC_KIND}가 아니다`)
  if (!isObject(doc.run) || !['runId', 'head', 'worktree', 'mergeBase'].every(key => nonEmpty(doc.run[key]))) {
    problems.push('run(runId·head·worktree·mergeBase)이 없다')
  }
  if (!Array.isArray(doc.entries)) problems.push('entries가 배열이 아니다')
  else {
    const seen = new Set()
    for (const entry of doc.entries) {
      if (!isObject(entry) || !nonEmpty(entry.candidateId)) { problems.push('entries에 candidateId 없는 항목이 있다'); continue }
      if (seen.has(entry.candidateId)) problems.push(`${entry.candidateId}의 항목이 둘이다`)
      seen.add(entry.candidateId)
    }
  }
  return problems
}

/** 근거 파일을 읽는다. `{ value }` 또는 `{ error }`다. 잘린 파일을 빈 근거로 읽지 않는다. */
export function parseEvidenceDoc(text) {
  if (typeof text !== 'string' || !text.trim()) return { error: '근거 파일이 비어 있다' }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { error: `근거 파일이 JSON이 아니다(잘렸을 수 있다): ${error.message}` }
  }
  const problems = evidenceDocProblems(parsed)
  if (problems.length) return { error: `근거 파일을 읽을 수 없다:\n  - ${problems.join('\n  - ')}` }
  return { value: parsed }
}

/** 근거 파일 옆의 실행 기록 디렉터리(`<run>.evidence/`). */
export const executionsDirOf = docPath => join(dirname(docPath), basename(docPath).replace(/\.json$/, ''))

/**
 * 근거 파일과 실행 기록을 읽어 평가에 필요한 것을 모은다.
 *
 * 실행 기록마다 로그 파일을 다시 해시해 기록과 대조한다. 기록을 쓴 뒤 로그가 바뀌었거나
 * 없어졌으면 그 기록은 근거로 쓰지 않는다. 계약에 맞지 않는 기록은 `problems`로 알리고 뺀다.
 */
export function loadEvidence(docPath, { fs = nodeFs } = {}) {
  if (!fs.existsSync(docPath)) return { error: `근거 파일이 없다: ${docPath}` }
  const parsed = parseEvidenceDoc(fs.readFileSync(docPath, 'utf8'))
  if (parsed.error) return { error: `${docPath}: ${parsed.error}` }
  const doc = parsed.value
  const { executions, problems } = loadExecutions(docPath, doc.run, { fs })
  return { doc, executions, problems }
}

export function loadExecutions(docPath, run, { fs = nodeFs } = {}) {
  const dir = executionsDirOf(docPath)
  const executions = new Map()
  const problems = []
  if (!fs.existsSync(dir)) return { executions, problems }
  for (const name of fs.readdirSync(dir).filter(file => file.endsWith('.json')).sort()) {
    let record
    try {
      record = JSON.parse(fs.readFileSync(join(dir, name), 'utf8'))
    } catch (error) {
      problems.push(`${name}: 실행 기록이 JSON이 아니다 — ${error.message}`)
      continue
    }
    const recordProblems = executionProblems(record)
    if (recordProblems.length) {
      problems.push(`${name}: ${recordProblems.join(', ')}`)
      continue
    }
    const artifactPath = join(dirname(docPath), record.artifact.path)
    const artifactSha256 = fs.existsSync(artifactPath) ? sha256(fs.readFileSync(artifactPath)) : null
    executions.set(record.id, { record, usability: executionUsability(record, { run, artifactSha256 }) })
  }
  return { executions, problems }
}

/** 근거 파일을 계약대로 검사한 뒤 원자적으로 쓴다. */
export function writeEvidenceDoc(docPath, doc, { fs = nodeFs } = {}) {
  const problems = evidenceDocProblems(doc)
  if (problems.length) throw new Error(`계약에 맞지 않는 근거 파일은 쓰지 않는다:\n  - ${problems.join('\n  - ')}`)
  writeTextAtomic(docPath, `${JSON.stringify(doc, null, 2)}\n`, { fs, verify: written => parseEvidenceDoc(written).error })
}

/**
 * 근거 파일의 항목을 후보별 평가로 바꾼다 — 렌더러와 스냅숏이 같은 함수를 쓴다.
 *
 * 계약에 맞지 않는 항목(손으로 고친 파일 등)은 평가하지 않고 `{ candidateId, method, problems }`로
 * 둔다. 그 항목을 그대로 평가하면 `executed`를 실행 기록 없이 붙인 항목이 실행 근거로 그려진다.
 */
export function assessEvidence(doc, executions, candidateIds) {
  return new Map(doc.entries.map(entry => {
    const problems = entryProblems(entry, { candidateIds, executions })
    return [entry.candidateId, problems.length
      ? { candidateId: entry.candidateId, method: entry.method, problems }
      : assessEntry(entry, executions)]
  }))
}
