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

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildFixture, readBlobLines } from './lib/eval-fixture.mjs'
import { grade } from './lib/eval-grade.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const die = message => {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const has = name => process.argv.includes(`--${name}`)

const caseName = flag('case')
if (!caseName) die('usage: node scripts/eval-review.mjs --case <name> [--dry-run]')

const caseDir = join(ROOT, 'evals', 'cases', caseName)
if (!existsSync(caseDir)) die(`case not found: ${caseName} (looked in evals/cases/${caseName})`)

const meta = JSON.parse(readFileSync(join(caseDir, 'case.json'), 'utf8'))
const expected = JSON.parse(readFileSync(join(caseDir, 'expected.json'), 'utf8'))

const runs = Number(flag('runs', meta.runs ?? 1))
const timeoutMs = Number(flag('timeout-minutes', meta.timeoutMinutes ?? 15)) * 60_000
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
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
  child.on('close', (code, signal) => {
    clearTimeout(timer)
    resolve({
      completed: signal === 'SIGKILL' ? 'timeout' : code === 0 ? true : 'failed',
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

const results = []
for (let index = 0; index < runs; index += 1) {
  const fixture = makeFixture()
  const execution = await runClaude(fixture.root, meta.command)
  const reportPath = newestReport(fixture.root)
  const reportText = reportPath ? readFileSync(reportPath, 'utf8') : ''

  // 채점에 필요한 경로만 읽는다: 기대값이 가리키는 경로 + 리포트가 언급한 경로.
  const mentioned = new Set([
    ...(expected.mustFind ?? []).map(target => target.path),
    ...(expected.mustNotFlag ?? []).map(target => target.path),
    ...meta.changedFiles.added, ...meta.changedFiles.removed, ...meta.changedFiles.modified,
  ])
  for (const match of reportText.matchAll(/([\w./-]+\.(?:tsx?|jsx?|mjs|json|md)):\d+/g)) mentioned.add(match[1])

  const blobLines = readBlobLines(fixture.root, fixture.mergeBase, [...mentioned])
  const scored = execution.completed === true ? grade(reportText, expected, blobLines) : null

  results.push({
    run: index + 1,
    completed: execution.completed,
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
writeFileSync(outPath, JSON.stringify({ case: caseName, label, pluginDir, runs, results }, null, 2), 'utf8')

process.stdout.write(`\nwrote ${outPath}\n`)
for (const result of results) {
  if (!result.recall) continue
  process.stdout.write(
    `  run ${result.run}: recall ${result.recall.found}/${result.recall.of}` +
    ` fp ${result.falsePositives.count} unclassified ${result.unclassified}` +
    ` inRange ${result.locationsInRange.ok}/${result.locationsInRange.of}` +
    ` onTarget ${result.locationsOnTarget.ok}/${result.locationsOnTarget.of}` +
    ` scriptRan ${result.scriptRan.ran} skeleton ${result.skeletonOk.ok}\n`,
  )
}
