#!/usr/bin/env node
// 한 실행의 결과 스냅숏을 남긴다 — 무엇을 리뷰했고, 어디까지 끝냈고, 무엇을 찾았는가.
//
// 왜 있는가(#88 PR 0): 그 답이 리포트 Markdown·타임라인·중간 파일 여럿에 흩어져 있어,
// 이전 실행과 비교하려면 매번 다시 조립해야 했다. 조립하는 쪽마다 "끝난 모듈"과
// "검토하지 않은 범위"를 다르게 읽으면 같은 실행이 비교마다 다른 실행이 된다. 그
// 판단을 여기서 한 번 하고 파일로 남긴다(판단 자체는 `lib/review-snapshot.mjs`).
//
// 리포트의 `실행 계획`에 붙일 블록을 stdout으로 낸다. 그 블록은 **방금 저장한 파일을
// 다시 읽어서** 그린다 — 리포트와 JSON이 다른 것을 말할 길을 남기지 않는다.
//
// Usage:
//
//   review-snapshot.mjs --dir <리포트 디렉터리> --run <리포트 basename> --rules <RULES_DIR> \
//     --verification-state <ran|disabled> [--repo .] [--routed <경로>] [--verdicts <경로> | --no-verdicts]
//
//   review-snapshot.mjs --show <스냅숏 경로>     저장된 스냅숏을 검사하고 같은 블록을 낸다
//
// routed와 판정은 기본으로 `<dir>/.timing/<run>.routed.json`·`.verdicts.json`을 읽는다 —
// SKILL이 그 자리에 쓰라고 한다. 스냅숏은 `<dir>/.timing/<run>.snapshot.json`에 쓴다.
//
// 종료 코드: 0 성공 / 1 `--show`가 읽을 수 없는 스냅숏 / 2 사용법·입력 문제(스냅숏을 쓰지 않았다)

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { requireStartedTimeline, readEvents } from './lib/run-record.mjs'
import { currentTarget, rulesDigest } from './lib/run-identity.mjs'
import { buildSnapshot, parseSnapshot, renderSnapshotMarkdown, writeSnapshotAtomic } from './lib/review-snapshot.mjs'
import { collectVerdicts } from './lib/verdicts.mjs'

const die = message => {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

const VALUE_FLAGS = new Set(['dir', 'run', 'rules', 'verification-state', 'repo', 'routed', 'verdicts', 'show'])
const BOOL_FLAGS = new Set(['no-verdicts'])
{
  const argv = process.argv.slice(2)
  const seen = new Set()
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at]
    // 값에 공백이 있으면 셸이 거기서 쪼갠다. 남은 토큰을 조용히 무시하면 잘린 값으로
    // 돌고 아무도 모른다 — review-preflight.mjs와 같은 이유로 시끄럽게 실패시킨다.
    if (!arg.startsWith('--')) die(`unexpected argument ${JSON.stringify(arg)} — 값에 공백이 있으면 따옴표로 감싸라`)
    const name = arg.slice(2)
    if (seen.has(name)) die(`--${name}이 두 번 왔다. 값을 읽는 쪽은 첫 번째만 본다`)
    seen.add(name)
    if (BOOL_FLAGS.has(name)) continue
    if (!VALUE_FLAGS.has(name)) die(`unknown flag ${arg}`)
    const value = argv[at + 1]
    if (value === undefined || value.startsWith('--')) die(`${arg} needs a value`)
    at += 1
  }
}

const flag = name => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}
const has = name => process.argv.includes(`--${name}`)

const readText = (path, what) => {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    die(`${what}를 읽지 못했다: ${path} — ${error.message}`)
  }
}
const readJson = (path, what) => {
  const text = readText(path, what)
  try {
    return { text, value: JSON.parse(text) }
  } catch (error) {
    die(`${what}가 JSON이 아니다: ${path} — ${error.message}`)
  }
}
const digest = text => createHash('sha256').update(text).digest('hex')

if (flag('show') !== undefined) {
  if (process.argv.slice(2).length !== 2) die('--show는 다른 플래그와 함께 쓰지 않는다')
  const path = flag('show')
  const parsed = parseSnapshot(readText(path, '스냅숏'))
  if (parsed.error) {
    process.stderr.write(`${path}: ${parsed.error}\n`)
    process.exit(1)
  }
  process.stdout.write(`${renderSnapshotMarkdown(parsed.value)}\n`)
  process.exit(0)
}

const dir = flag('dir')
const run = flag('run')
const rules = flag('rules')
const verificationState = flag('verification-state')
const repo = flag('repo') ?? process.cwd()
if (!rules) die('--rules <RULES_DIR>가 필요하다 — 어느 모듈이 적용 대상인지가 catalog에서 나온다')
// 기본값이 없다. "검증을 껐다"와 "검증이 깨졌다"는 다른 사실이고(C-6B), 판정 파일이
// 있는지로 추측하면 둘 중 하나를 다른 것으로 남긴다 — render-findings.mjs와 같은 이유다.
if (!['ran', 'disabled'].includes(verificationState)) die('--verification-state는 ran 또는 disabled여야 한다')

const sidecar = requireStartedTimeline(dir, run)
const timing = join(dir, '.timing')
const relativeToDir = path => relative(dir, path).split('\\').join('/')
const events = readEvents(sidecar)
const inputs = [{ role: 'timeline', path: relativeToDir(sidecar), sha256: digest(readText(sidecar, '타임라인')) }]

const catalog = readJson(join(rules, 'catalog.json'), 'catalog.json').value

const routedPath = flag('routed') ?? join(timing, `${run}.routed.json`)
if (!existsSync(routedPath)) die(`routed 출력이 없다: ${routedPath} — prepare-verification.mjs --collect의 출력을 그 자리에 두거나 --routed로 넘긴다`)
const routed = readJson(routedPath, 'routed 출력')
inputs.push({ role: 'routed', path: relativeToDir(routedPath), sha256: digest(routed.text) })

// 판정. 검증을 끈 실행에 판정 파일을 주면 두 신호가 모순된다 — 조용히 무시하지 않는다.
const verdicts = new Map()
if (verificationState === 'disabled') {
  if (flag('verdicts') !== undefined || has('no-verdicts')) die('--verification-state disabled에는 판정이 없다 — --verdicts·--no-verdicts와 함께 줄 수 없다')
} else {
  if (flag('verdicts') !== undefined && has('no-verdicts')) die('--verdicts와 --no-verdicts를 함께 줄 수 없다')
  const verdictsPath = flag('verdicts') ?? join(timing, `${run}.verdicts.json`)
  const needsVerdicts = (routed.value.candidates ?? []).some(candidate => candidate?.eligibility === 'VERIFY')
  if (existsSync(verdictsPath) && !has('no-verdicts')) {
    const loaded = readJson(verdictsPath, '판정 파일')
    let list
    try {
      list = collectVerdicts(loaded.value)
    } catch (error) {
      die(`판정 파일에서 판정 목록을 찾지 못했다: ${verdictsPath} — ${error.message}`)
    }
    for (const verdict of list) verdicts.set(verdict.candidateId, { disposition: verdict.disposition, rebuttalKind: verdict.rebuttal?.kind })
    inputs.push({ role: 'verdicts', path: relativeToDir(verdictsPath), sha256: digest(loaded.text) })
  } else if (flag('verdicts') !== undefined) {
    die(`판정 파일이 없다: ${verdictsPath}`)
  } else if (needsVerdicts && !has('no-verdicts')) {
    // 판정이 없는 검증 대상은 `verification-unavailable`이 된다. 파일이 다른 자리에 있을
    // 뿐인데 그렇게 남기면, 검증이 돈 실행이 검증이 깨진 실행으로 기록된다.
    die(`판정 파일이 없다: ${verdictsPath} — tally-verdicts.mjs --collect가 쓴 파일을 --verdicts로 넘긴다. 검증자가 하나도 판정을 내지 못했으면 --no-verdicts를 준다(검증 대상 전부가 검증 실패로 남는다)`)
  }
}

// producer 결과의 openQuestions. routed 출력에는 실리지 않으므로 수집한 모듈의 결과 파일에서 읽는다.
const openQuestionsBySource = new Map()
for (const source of Array.isArray(routed.value.collected?.sources) ? routed.value.collected.sources : []) {
  const path = join(timing, `${run}.${source}.json`)
  if (!existsSync(path)) die(`수집한 모듈 ${source}의 결과 파일이 없다: ${path} — 스냅숏이 그 모듈의 열린 질문을 빠뜨린다`)
  const result = readJson(path, `${source} 결과`)
  if (!Array.isArray(result.value?.openQuestions)) die(`${path}에 openQuestions 배열이 없다`)
  openQuestionsBySource.set(source, result.value.openQuestions)
  inputs.push({ role: 'result', path: relativeToDir(path), sha256: digest(result.text) })
}

// 지금의 대상. 시작할 때 기록한 값과 다르면 실행 도중 대상이 바뀐 것이다.
let current
try {
  current = { ...currentTarget(repo, { exclude: [dir] }), rulesDigest: rulesDigest(rules) }
} catch (error) {
  die(`리뷰 대상의 지금 상태를 읽지 못했다(--repo ${repo}): ${String(error.stderr || error.message).trim()}`)
}

let snapshot
try {
  snapshot = buildSnapshot({
    name: run, events, catalog, routed: routed.value, verdicts, verificationState,
    openQuestionsBySource, inputs, current, now: new Date().toISOString(),
  })
} catch (error) {
  die(`스냅숏을 만들지 못했다: ${error.message}`)
}

const path = join(timing, `${run}.snapshot.json`)
try {
  writeSnapshotAtomic(path, snapshot)
} catch (error) {
  die(`스냅숏을 쓰지 못했다: ${error.message}`)
}

// 방금 쓴 파일을 다시 읽어 그린다. 리포트에 붙는 블록이 저장된 JSON과 같은 것을 말한다.
const saved = parseSnapshot(readText(path, '스냅숏'))
if (saved.error) die(`쓴 스냅숏을 다시 읽지 못했다: ${saved.error}`)
for (const note of saved.value.notes) process.stderr.write(`참고: ${note}\n`)
process.stdout.write(`${renderSnapshotMarkdown(saved.value)}\n`)
