#!/usr/bin/env node
// 지적별 재현 근거를 남긴다(C-11, #88 PR 2).
//
// 두 가지 일을 한다.
//
//   exec — 재현 명령을 **실제로 돌린다.** 출력은 로그 파일로, 결과는 실행 기록으로 남기고,
//          타임라인에 tool.start/tool.done 한 쌍을 쓴다. `executed`라는 표기는 이 기록이
//          있어야만 붙는다 — 산문으로 "돌려 봤다"고 적는 길로는 만들 수 없다.
//   note — 오케스트레이터가 파일로 넘긴 근거 항목(조건·절차·기대·관찰)을 검사해 근거 파일에
//          합친다. 계약에 맞지 않으면 아무것도 쓰지 않는다.
//
// Usage:
//
//   review-evidence.mjs exec --dir <리포트 디렉터리> --run <basename> --candidate <candidateId> \
//     --expect-exit <코드[,코드]> [--expect-output <글자>] [--side head|base] [--repo <트리>] \
//     [--timeout <초>] [--shell] -- <명령> [인자...]
//
//   review-evidence.mjs note --dir <리포트 디렉터리> --run <basename> --input <항목 JSON 경로>
//
// 재현 명령은 셸 없이 인자 배열 그대로 돈다. Windows의 `npm`처럼 셸이 필요한 명령에만
// `--shell`을 주고, 그때는 `--` 뒤에 **셸 명령 문자열 하나**를 준다 — 인자 배열을 공백으로 이어
// 셸에 넘기면 인자 하나에 든 공백이 다시 쪼개져 기록된 명령과 실제로 돈 명령이 달라진다(PR #92
// 리뷰에서 재현). 명령은 read-only여야 한다(C-6) — 돌리기 전후의 작업 트리를 재서, 바꿨으면
// 기록하되 근거로 쓰지 않는다.
//
// `--side base`는 merge-base를 꺼낸 깨끗한 트리(`--repo`)에서만 돈다. 이 스크립트는 그 트리를
// 만들지 않는다 — 대상 저장소에 쓰지 않는다. 트리가 없으면 base는 미측정으로 남는다.
//
// 종료 코드: 0 기록함(재현 결과와 무관) / 2 사용법·입력 문제(기록하지 않았다)

import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { writeTextAtomic } from './lib/atomic-write.mjs'
import {
  assessEntry, classifyOutcome, entryProblems, EVIDENCE_SCHEMA_VERSION, executionProblems, executionUsability,
  executionsDirOf, loadExecutions, parseEvidenceDoc, planDigestOf, reproductionPlan, sha256, writeEvidenceDoc,
} from './lib/evidence.mjs'
import { currentTarget } from './lib/run-identity.mjs'
import { logPhase, readEvents, requireStartedTimeline } from './lib/run-record.mjs'

const die = message => {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

const argv = process.argv.slice(2)
const subcommand = argv[0]
if (!['exec', 'note'].includes(subcommand)) die('usage: review-evidence.mjs exec|note --dir <리포트 디렉터리> --run <basename> …')
const separator = argv.indexOf('--')
const flags = separator === -1 ? argv.slice(1) : argv.slice(1, separator)
const command = separator === -1 ? [] : argv.slice(separator + 1)

const VALUE_FLAGS = {
  exec: new Set(['dir', 'run', 'candidate', 'expect-exit', 'expect-output', 'side', 'repo', 'timeout', 'routed']),
  note: new Set(['dir', 'run', 'input', 'routed']),
}
const BOOL_FLAGS = { exec: new Set(['shell']), note: new Set() }
const values = new Map()
for (let at = 0; at < flags.length; at += 1) {
  const arg = flags[at]
  // 값에 공백이 있으면 셸이 거기서 쪼갠다. 남은 토큰을 조용히 무시하지 않는다.
  if (!arg.startsWith('--')) die(`unexpected argument ${JSON.stringify(arg)} — 값에 공백이 있으면 따옴표로 감싸고, 재현 명령은 -- 뒤에 둔다`)
  const name = arg.slice(2)
  if (values.has(name)) die(`--${name}이 두 번 왔다`)
  if (BOOL_FLAGS[subcommand].has(name)) { values.set(name, true); continue }
  if (!VALUE_FLAGS[subcommand].has(name)) die(`${subcommand}에 없는 플래그 ${arg}`)
  const value = flags[at + 1]
  if (value === undefined || value.startsWith('--')) die(`${arg} needs a value`)
  values.set(name, value)
  at += 1
}

const dir = values.get('dir')
const run = values.get('run')
const sidecar = requireStartedTimeline(dir, run)
const timing = join(dir, '.timing')
const docPath = join(timing, `${run}.evidence.json`)
const start = readEvents(sidecar).find(event => event?.phase === 'run.start') ?? {}
if (!['runId', 'head', 'worktree', 'mergeBase'].every(key => typeof start[key] === 'string' && start[key])) {
  die('run.start에 실행 식별(runId·head·worktree·mergeBase)이 없다 — 2.16.0 이전 preflight로 시작한 실행이라 재현이 어느 대상의 것인지 정할 수 없다')
}
const runIdentity = { runId: start.runId, head: start.head, worktree: start.worktree, mergeBase: start.mergeBase }

// 근거는 이 실행의 후보에만 붙는다. candidateId는 prepare-verification이 정한다.
//
// routed 출력이 **이 실행의 것인지** 먼저 본다. 후보 ID만 꺼내 쓰면 다른 실행의 routed 파일을 줘도
// 받아들이고, `CR-1#1`처럼 실행마다 되풀이되는 ID가 겹치면 다른 지적의 근거가 이 실행의 근거 파일에
// 들어간다 — 렌더러의 실행 대조는 이미 이 실행의 ID로 쓰인 근거 파일이라 그것을 되돌리지 못한다(PR #92
// 리뷰에서 재현). 그래서 명령을 돌리거나 파일을 만들기 전에 거부한다. 후보 목록의 해시도 실행 기록에
// 남긴다 — 같은 실행에서 검증 준비를 다시 돌려 후보가 바뀌면 그 앞의 재현은 근거로 쓰지 않는다.
const routedPath = values.get('routed') ?? join(timing, `${run}.routed.json`)
if (!existsSync(routedPath)) die(`routed 출력이 없다: ${routedPath} — 근거는 prepare-verification.mjs가 ID를 붙인 후보에만 붙는다`)
let candidateIds
let routedSha256
try {
  const routedText = readFileSync(routedPath, 'utf8')
  const routed = JSON.parse(routedText)
  if (!routed?.collected?.runId) die(`routed 출력에 실행 ID(collected.runId)가 없다: ${routedPath} — prepare-verification.mjs --collect의 출력이어야 어느 실행의 후보인지 안다`)
  if (routed.collected.runId !== start.runId) die(`${routedPath}는 다른 실행(${routed.collected.runId})의 routed 출력이다 — 이 실행은 ${start.runId}다`)
  candidateIds = new Set((routed.candidates ?? []).map(candidate => candidate.candidateId))
  routedSha256 = sha256(routedText)
} catch (error) {
  die(`routed 출력을 읽지 못했다: ${routedPath} — ${error.message}`)
}

/** 근거 파일을 읽는다. 없으면 이 실행의 식별을 담아 만든다. 다른 실행의 파일이면 멈춘다. */
const loadDoc = () => {
  if (!existsSync(docPath)) {
    const doc = { schemaVersion: EVIDENCE_SCHEMA_VERSION, kind: 'review-evidence', run: runIdentity, entries: [] }
    writeEvidenceDoc(docPath, doc)
    return doc
  }
  const parsed = parseEvidenceDoc(readFileSync(docPath, 'utf8'))
  if (parsed.error) die(`${docPath}: ${parsed.error}`)
  if (parsed.value.run.runId !== runIdentity.runId) die(`${docPath}는 다른 실행(${parsed.value.run.runId})의 근거 파일이다`)
  return parsed.value
}

const COMPARISON_TEXT = {
  'pre-existing': '변경 전에도 재현 → 기존 결함',
  'new-regression': '변경 전에는 재현 안 됨 → 신규 회귀',
  'base-unmeasured': 'base 미측정',
  incomparable: '변경 전 재현과 재현 계획이 달라 비교하지 않았다',
}

if (subcommand === 'exec') {
  const candidateId = values.get('candidate')
  if (!candidateId) die('--candidate <candidateId>가 필요하다')
  if (!candidateIds.has(candidateId)) die(`${JSON.stringify(candidateId)}는 이 실행의 후보가 아니다 — routed 출력의 candidateId를 쓴다`)
  // 무엇이 "재현"인지는 돌리기 전에 정한다. 돌린 뒤에 결과를 보고 정하면 무엇이든 재현이 된다.
  const expectExitText = values.get('expect-exit')
  if (!expectExitText) die('--expect-exit <코드[,코드]>가 필요하다 — 결함이 재현됐다는 뜻의 종료 코드를 돌리기 전에 정한다')
  const expectExit = expectExitText.split(',').map(text => Number(text.trim()))
  if (expectExit.some(code => !Number.isInteger(code))) die(`--expect-exit는 정수 목록이다: ${JSON.stringify(expectExitText)}`)
  const expectOutput = values.get('expect-output') ?? null
  const side = values.get('side') ?? 'head'
  if (!['head', 'base'].includes(side)) die('--side는 head 또는 base다')
  const timeoutSec = Number(values.get('timeout') ?? 600)
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) die('--timeout은 양수(초)다')
  if (!command.length) die('재현 명령을 -- 뒤에 준다')
  const shell = values.get('shell') === true
  if (shell && command.length !== 1) {
    die(`--shell은 셸 명령 문자열 하나를 받는다(받은 인자 ${command.length}개) — 인자 배열을 공백으로 이어 붙이면 인자 안의 공백이 다시 쪼개진다. 셸 없이 돌릴 수 있으면 --shell을 빼고 인자 배열로 준다`)
  }
  const repo = values.get('repo') ?? process.cwd()

  let before
  try {
    before = currentTarget(repo, { exclude: [dir] })
  } catch (error) {
    die(`재현할 트리를 읽지 못했다(--repo ${repo}): ${String(error.stderr || error.message).trim()}`)
  }
  // 돌려 봐야 근거로 못 쓰는 재현은 돌리지 않는다.
  if (side === 'head' && (before.head !== runIdentity.head || before.worktree !== runIdentity.worktree)) {
    die(`preflight 뒤에 리뷰 대상이 바뀌었다(HEAD ${runIdentity.head.slice(0, 12)} → ${before.head.slice(0, 12)}, 작업 트리 ${runIdentity.worktree} → ${before.worktree}) — 여기서 돈 재현은 이 실행의 근거가 아니다. 대상을 되돌리거나 새 실행으로 시작한다`)
  }
  if (side === 'base' && (before.head !== runIdentity.mergeBase || before.worktree !== 'clean')) {
    die(`base 쪽 재현은 merge-base ${runIdentity.mergeBase.slice(0, 12)}를 꺼낸 깨끗한 트리에서만 돈다 — --repo ${repo}는 HEAD ${before.head.slice(0, 12)}, 작업 트리 ${before.worktree}다`)
  }

  const doc = loadDoc()
  const executionsDir = executionsDirOf(docPath)
  mkdirSync(executionsDir, { recursive: true })
  const startedAt = new Date()
  const id = `exec-${startedAt.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}-${randomBytes(3).toString('hex')}`

  // 재현 계획은 돌리기 전에 정한다. 저장소 루트는 HEAD와 base에서 다른 경로이므로 계획 안에서는 `<repo>`다.
  const repoRoot = (() => {
    try {
      return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return resolve(repo)
    }
  })()
  const plan = reproductionPlan({ command, shell, repoRoot: resolve(repoRoot), cwd: resolve(repo), expectExit, expectOutput })
  const planDigest = planDigestOf(plan)

  logPhase(dir, run, 'tool.start', { name: 'repro', candidateId, evidenceId: id })
  const result = shell
    ? spawnSync(command[0], { cwd: repo, shell: true, timeout: timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024 })
    : spawnSync(command[0], command.slice(1), { cwd: repo, timeout: timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024 })
  const durationMs = Date.now() - startedAt.getTime()
  const timedOut = result.error?.code === 'ETIMEDOUT'
  const spawnError = result.error && !timedOut ? `${result.error.code ?? ''} ${result.error.message}`.trim() : null
  const stdout = result.stdout ?? Buffer.alloc(0)
  const stderr = result.stderr ?? Buffer.alloc(0)
  const exit = typeof result.status === 'number' ? result.status : null

  let after
  try {
    after = currentTarget(repo, { exclude: [dir] })
  } catch {
    after = null
  }
  const mutatedTree = !after || after.head !== before.head || after.worktree !== before.worktree

  const { outcome, reason } = classifyOutcome({
    spawnError, timedOut, signal: result.signal ?? null, exit,
    output: `${stdout.toString('utf8')}\n${stderr.toString('utf8')}`, expectExit, expectOutput,
  })

  const header = [
    shell ? `$ ${command[0]}` : `$ ${JSON.stringify(command)}`,
    `# cwd ${repo}`,
    `# side ${side} · HEAD ${before.head} · 작업 트리 ${before.worktree}`,
    `# exit ${exit} · signal ${result.signal ?? 'none'} · timedOut ${timedOut}${spawnError ? ` · spawnError ${spawnError}` : ''}`,
    '--- stdout ---',
    '',
  ].join('\n')
  const log = Buffer.concat([Buffer.from(header, 'utf8'), stdout, Buffer.from('\n--- stderr ---\n', 'utf8'), stderr])
  const artifactPath = join(executionsDir, `${id}.log`)
  writeFileSync(artifactPath, log, { flag: 'wx' })

  const record = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    kind: 'review-execution',
    id,
    runId: runIdentity.runId,
    candidateId,
    side,
    command,
    shell,
    cwd: repo,
    startedAt: startedAt.toISOString(),
    durationMs,
    exit,
    signal: result.signal ?? null,
    timedOut,
    spawnError,
    expect: { exit: expectExit, output: expectOutput },
    plan,
    planDigest,
    routedSha256,
    outcome,
    outcomeReason: reason,
    target: before,
    targetAfter: after,
    mutatedTree,
    artifact: { path: relative(timing, artifactPath).split('\\').join('/'), sha256: sha256(log), bytes: log.length },
  }
  const recordProblems = executionProblems(record)
  if (recordProblems.length) die(`실행 기록을 만들지 못했다: ${recordProblems.join(', ')}`)
  writeTextAtomic(join(executionsDir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`)

  logPhase(dir, run, 'tool.done', { name: 'repro', exit, treeSha: before.head, candidateId, evidenceId: id })

  const usability = executionUsability(record, { run: doc.run, artifactSha256: record.artifact.sha256, routedSha256 })
  if (mutatedTree) {
    process.stderr.write(`경고: 재현 명령이 작업 트리를 바꿨다(${before.worktree} → ${after?.worktree ?? '읽지 못함'}) — read-only 계약(C-6) 밖의 실행이라 근거로 쓰지 않는다. 바뀐 파일을 되돌리고, 쓰지 않는 명령으로 다시 재현한다\n`)
  }
  process.stdout.write(`${JSON.stringify({
    id, candidateId, side, outcome, outcomeReason: reason, exit,
    usable: usability.usable, ...(usability.reason ? { reason: usability.reason } : {}),
    artifact: record.artifact.path,
  }, null, 2)}\n`)
  process.exit(0)
}

// note
const inputPath = values.get('input')
if (!inputPath) die('--input <항목 JSON 경로>가 필요하다 — 산문을 셸 인자로 넘기지 않는다')
let input
try {
  input = JSON.parse(readFileSync(inputPath, 'utf8'))
} catch (error) {
  die(`--input을 읽지 못했다: ${inputPath} — ${error.message}`)
}
const entries = Array.isArray(input) ? input : input?.entries
if (!Array.isArray(entries) || !entries.length) die('--input에는 entries 배열(또는 항목 배열)이 있어야 한다')

const doc = loadDoc()
const { executions, problems: loadProblems } = loadExecutions(docPath, doc.run, { routedSha256 })
for (const problem of loadProblems) process.stderr.write(`경고: ${problem}\n`)
const problems = entries.flatMap(entry => entryProblems(entry, { candidateIds, executions }))
const ids = entries.map(entry => entry?.candidateId)
for (const duplicate of ids.filter((value, at) => ids.indexOf(value) !== at)) problems.push(`${duplicate}의 항목이 입력에 둘이다`)
if (problems.length) die(`근거 항목을 받을 수 없다 — 아무것도 쓰지 않았다:\n  - ${problems.join('\n  - ')}`)

const replaced = new Set(ids)
const merged = { ...doc, entries: [...doc.entries.filter(entry => !replaced.has(entry.candidateId)), ...entries] }
try {
  writeEvidenceDoc(docPath, merged)
} catch (error) {
  die(`근거 파일을 쓰지 못했다: ${error.message}`)
}
for (const entry of entries) {
  const assessed = assessEntry(entry, executions)
  const detail = entry.method === 'executed'
    ? ` ${assessed.head?.outcome ?? '?'}${assessed.comparison ? ` · ${COMPARISON_TEXT[assessed.comparison]}` : ''}`
    : ''
  process.stdout.write(`${entry.candidateId} ${entry.method}${detail}\n`)
}
