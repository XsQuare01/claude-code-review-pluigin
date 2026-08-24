#!/usr/bin/env node
// /code-review를 실제로 실행해 채점한다.
//
// 문서 validator와 단위 테스트는 리뷰를 실행하지 않는다. 2.6.0이 사용자
// 프로젝트에서 처음 실행되어 30분 타임아웃으로 발견된 이유가 그것이다.
// 이 스크립트는 그 첫 실행을 여기로 옮긴다.
//
// Usage:
//   node scripts/eval-review.mjs --case location-trap --dry-run
//   node scripts/eval-review.mjs --case location-trap --plugin-dir . --label main --runs 1

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildFixture, readBlobLines } from './lib/eval-fixture.mjs'
import { grade, parseFindings } from './lib/eval-grade.mjs'
import { classifyExit } from './lib/eval-run.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const die = message => {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  if (at === -1) return fallback
  const value = process.argv[at + 1]
  // 값이 없거나 다음 플래그를 값으로 삼키면(`--runs --dry-run`처럼) 조용히
  // 틀린 값으로 넘어가는 대신 바로 사유를 낸다 — 이 CLI 자체가 "조용히 틀린
  // 결과"를 잡으려고 만든 것이므로, 인자 파싱도 그 원칙을 따라야 한다.
  if (value === undefined || value.startsWith('--')) die(`--${name} needs a value`)
  return value
}
const has = name => process.argv.includes(`--${name}`)

const numberFlag = (name, fallback) => {
  const raw = flag(name, fallback)
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) die(`--${name} must be a positive number, got ${JSON.stringify(raw)}`)
  return value
}

const caseName = flag('case')
if (!caseName) die('usage: node scripts/eval-review.mjs --case <name> [--dry-run]')

const caseDir = join(ROOT, 'evals', 'cases', caseName)
if (!existsSync(caseDir)) die(`case not found: ${caseName} (looked in evals/cases/${caseName})`)

const meta = JSON.parse(readFileSync(join(caseDir, 'case.json'), 'utf8'))
const expected = JSON.parse(readFileSync(join(caseDir, 'expected.json'), 'utf8'))

const runs = numberFlag('runs', meta.runs ?? 1)
const timeoutMs = numberFlag('timeout-minutes', meta.timeoutMinutes ?? 15) * 60_000
const pluginDir = flag('plugin-dir', ROOT)
const label = flag('label', 'local')

const newestReport = root => {
  const dir = join(root, 'review-reports')
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
    .filter(name => name.endsWith('.md'))
    .map(name => ({ path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
    .sort((left, right) => right.at - left.at)
  return files[0]?.path ?? null
}

/**
 * 타임아웃은 여기서 강제한다.
 *
 * claude 쪽 판단에 맡기지 않는다 — "끝나지 않았다"가 2.6.0을 잡았을 유일한
 * 항목이고, 그 항목만은 harness가 직접 들고 있어야 한다.
 */
const runClaude = (fixtureRoot, command) => new Promise(resolve => {
  const args = [
    '-p', command,
    '--plugin-dir', pluginDir,
    '--add-dir', fixtureRoot,
    '--permission-mode', 'acceptEdits',
    '--output-format', 'json',
  ]
  const started = Date.now()
  const child = spawn('claude', args, { cwd: fixtureRoot, shell: process.platform === 'win32' })
  let stdout = ''
  let stderr = ''
  // harness가 직접 kill했는지를 여기서 플래그로 남긴다. Windows에는 POSIX
  // 시그널이 없어서, .kill('SIGKILL')로 죽은 프로세스도 close 이벤트의
  // signal이 null로 온다 — signal로 분류하면 이 저장소가 실제로 돌아가는
  // 플랫폼에서 타임아웃을 절대 못 잡는다. classifyExit()가 이 플래그로만
  // 판단하는 이유가 그것이다.
  let killedByTimeout = false
  let settled = false
  const finish = result => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    resolve(result)
  }
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  // spawn 자체가 실패하면(바이너리를 못 찾는 등) close 이벤트는 절대 오지
  // 않는다. 여기서 받지 않으면 처리되지 않은 예외로 프로세스 전체가 죽고,
  // writeFileSync가 for 루프가 끝난 뒤에만 돌기 때문에 이미 끝낸 run들의
  // 결과까지 다 같이 사라진다 — 그래서 이 run만 failed로 접고 배치를 잇는다.
  child.on('error', err => {
    finish({
      completed: 'failed',
      exitCode: null,
      durationSec: Math.round((Date.now() - started) / 1000),
      stdout,
      stderr: `${stderr}${err.message}`.slice(-4000),
    })
  })
  const timer = setTimeout(() => { killedByTimeout = true; child.kill('SIGKILL') }, timeoutMs)
  child.on('close', (code, signal) => {
    finish({
      completed: classifyExit({ killedByTimeout, code, signal }),
      exitCode: code,
      durationSec: Math.round((Date.now() - started) / 1000),
      stdout,
      stderr: stderr.slice(-4000),
    })
  })
})

// 실행이 끝나도 이 임시 fixture 디렉터리를 지우지 않는다. 실패한 run을
// 사후에 직접 열어봐야 할 때, 결과 파일의 `fixtureRoot`가 실제로 뭔가를
// 가리키고 있어야 한다 — 여기서 지우면 그 경로가 유령이 된다.
const makeFixture = () => {
  const target = join(mkdtempSync(join(tmpdir(), `eval-${caseName}-`)), 'repo')
  return buildFixture(caseDir, target)
}

if (has('dry-run')) {
  const fixture = makeFixture()
  process.stdout.write(JSON.stringify({
    case: caseName,
    root: fixture.root,
    mergeBase: fixture.mergeBase,
    head: fixture.head,
    changed: fixture.changed,
  }, null, 2) + '\n')
  process.exit(0)
}

// 결과 파일이 스스로 무엇이 만들었는지 말하게 한다. pluginDir는 경로일 뿐이고
// 그 안의 내용은 시간이 지나면 바뀐다 — git ref와 plugin.json의 version,
// 그리고 이 배치를 시작한 시각을 같이 적어야 나중에 어떤 상태가 이 숫자를
// 냈는지 알 수 있다. 저장소가 아니거나 plugin.json이 없으면 배치를 실패시키지
// 않고 null을 남긴다 — 이 정보는 채점에 필요한 입력이 아니라 부가 정보라서,
// 없다고 채점 자체를 막을 이유가 없다.
const pluginRef = (() => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: pluginDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
})()
const pluginVersion = (() => {
  try {
    return JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
})()
const startedAt = new Date().toISOString()

const results = []
for (let index = 0; index < runs; index += 1) {
  const fixture = makeFixture()
  const execution = await runClaude(fixture.root, meta.command)
  const reportPath = newestReport(fixture.root)
  const reportText = reportPath ? readFileSync(reportPath, 'utf8') : ''

  // 채점에 필요한 경로만 읽는다: 기대값이 가리키는 경로 + 리포트가 실제로
  // 언급한 경로. 언급한 경로는 채점이 쓰는 것과 같은 파서(parseFindings)로
  // 뽑는다 — 정규식으로 따로 긁으면 공백/괄호/비ASCII가 든 경로를 놓치고,
  // 그 경로는 grader에서 "path not in fixture"라는 조용히 틀린 결과로 나온다.
  const findings = parseFindings(reportText)
  const mentioned = new Set([
    ...(expected.mustFind ?? []).map(target => target.path),
    ...(expected.mustNotFlag ?? []).map(target => target.path),
    ...meta.changedFiles.added, ...meta.changedFiles.removed, ...meta.changedFiles.modified,
    ...findings.map(finding => finding.location.path).filter(Boolean),
  ])

  const blobLines = readBlobLines(fixture.root, fixture.mergeBase, [...mentioned])
  // completed와 reportFound를 둘 다 요구한다. claude가 exit 0으로 끝났는데
  // 리포트를 안 남기면 grade('', ...)가 "찾은 게 0개"라는 멀쩡해 보이는 결과를
  // 내놓는데, 이는 타임아웃과 똑같은 부류의 실패다 — 정직한 미완료 대신
  // 오해를 주는 0.
  const scored = execution.completed === true && reportPath ? grade(reportText, expected, blobLines) : null

  results.push({
    run: index + 1,
    completed: execution.completed,
    exitCode: execution.exitCode,
    durationSec: execution.durationSec,
    reportFound: Boolean(reportPath),
    fixtureRoot: fixture.root,
    stderrTail: execution.completed === true ? undefined : execution.stderr,
    ...(scored ?? {}),
  })
  process.stdout.write(`run ${index + 1}/${runs}: completed=${execution.completed} ${execution.durationSec}s report=${Boolean(reportPath)}\n`)
}

const outDir = join(ROOT, 'evals', 'results')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, `${caseName}-${label}.json`)
writeFileSync(outPath, JSON.stringify({
  case: caseName,
  label,
  pluginDir,
  pluginRef,
  pluginVersion,
  timestamp: startedAt,
  runs,
  results,
}, null, 2), 'utf8')

process.stdout.write(`\nwrote ${outPath}\n`)
for (const result of results) {
  if (result.recall) {
    process.stdout.write(
      `  run ${result.run}: recall ${result.recall.found}/${result.recall.of}` +
      ` fp ${result.falsePositives.count} unclassified ${result.unclassified}` +
      ` inRange ${result.locationsInRange.ok}/${result.locationsInRange.of}` +
      ` onTarget ${result.locationsOnTarget.ok}/${result.locationsOnTarget.of}` +
      ` scriptRan ${result.scriptRan.ran} skeleton ${result.skeletonOk.ok}\n`,
    )
  } else {
    // 조용히 넘어가지 않는다 — 채점이 없다는 사실과 그 이유를 그대로 낸다.
    process.stdout.write(`  run ${result.run}: not graded (completed=${result.completed} reportFound=${result.reportFound})\n`)
  }
}
