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
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildFixture, readBlobLines } from './lib/eval-fixture.mjs'
import { assertNoPathOverlap, grade, parseFindings } from './lib/eval-grade.mjs'
import { classifyExit, parseEnvelope } from './lib/eval-run.mjs'

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
// 돈이 드는 run을 하나도 시작하기 전에 fixture 작성 실수를 잡는다. 이 검사를
// 루프 안(gradeFindings 내부)에만 두면 실제 배치에서는 8분·3.5달러짜리 run을
// 이미 마친 뒤에야 던진다 — 같은 예외가 시작 시점에 던지면 아무 것도 잃지 않는다.
assertNoPathOverlap(expected)

const runs = numberFlag('runs', meta.runs ?? 1)
const timeoutMs = numberFlag('timeout-minutes', meta.timeoutMinutes ?? 15) * 60_000
// 상대 경로를 그대로 두면 두 개의 다른 기준 디렉터리에 대해 풀린다: 아래의
// execFileSync('git', …, {cwd: pluginDir})/readFileSync(join(pluginDir, …))는
// *이 프로세스의* cwd를 기준으로 풀고, runClaude가 spawn하는 claude 프로세스는
// cwd가 fixture 임시 디렉터리라 같은 상대 경로를 *거기서* 기준으로 다시 푼다.
// `--plugin-dir ../eval-arm-main`처럼 흔한 입력이 provenance는 워크트리를
// 가리키면서 claude에는 존재하지 않는 임시 경로를 넘기는 조합을 만든다 — 숫자는
// 그럴듯한데 엉뚱한 트리에 귀속된다. 여기서 한 번만 절대 경로로 고정해 두 소비자가
// 같은 값을 보게 한다.
const pluginDir = resolve(flag('plugin-dir', ROOT))
const label = flag('label', 'local')
if (!/^[\w.-]+$/.test(label)) die(`--label must match /^[\\w.-]+$/, got ${JSON.stringify(label)}`)

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
 * `claude`가 실제로 무엇으로 풀리는지 먼저 알아낸다.
 *
 * `shell: process.platform === 'win32'`로 늘 shell을 거쳐 스폰하면 `child.pid`는
 * `cmd.exe`의 pid가 된다 — 타임아웃이 `child.kill()`을 불러도 그건 shell만
 * 끝내고, 그 밑에서 실제로 일하던 프로세스는 계속 살아있을 수 있다. shell을
 * 거치는 것 자체가 이 harness가 갖겠다고 선언한 "타임아웃은 우리가 직접
 * 강제한다"는 약속과 충돌한다. shell 없이 바로 스폰하면 이 문제도, 인자
 * 배열을 shell 명령줄 문자열로 다시 합칠 때 생기는 DEP0190 경고도, `tmpdir()`
 * 경로(사용자명을 포함하므로 공백이 있는 사용자 프로필에서 실제로 깨진다)가
 * shell에서 잘못 토큰화되는 위험도 한 번에 없어진다.
 *
 * 다만 `.cmd`/`.bat`로 풀리는 설치(예: npm 전역 설치가 남기는 shim)는 Windows
 * `CreateProcess`가 배치 파일을 직접 실행할 방법이 없어서 shell 없이는 스폰
 * 자체가 `EINVAL`로 즉시 던진다 — 이 경우만 shell로 물러난다. 이 머신의 실제
 * 설치(`where claude` → `claude.exe`)는 그 경로를 타지 않는다.
 */
const resolveClaude = () => {
  const shellFallback = { command: 'claude', shell: process.platform === 'win32' }
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    const found = execFileSync(finder, ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).map(line => line.trim()).find(Boolean)
    if (!found) return shellFallback
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(found)
    return { command: found, shell: needsShell }
  } catch {
    // PATH에서 못 찾았을 뿐이다 — 원래 있던 동작(과 그 shell 위험)으로
    // 물러난다. 여기서 던지면 dry-run조차 못 하는 하드 크래시가 된다.
    return shellFallback
  }
}
// --dry-run never calls runClaude, so it never needs to resolve claude at
// all — skip the extra `where`/`which` subprocess on that path.
const CLAUDE = has('dry-run') ? null : resolveClaude()

/**
 * 타임아웃은 여기서 강제한다.
 *
 * claude 쪽 판단에 맡기지 않는다 — "끝나지 않았다"가 2.6.0을 잡았을 유일한
 * 항목이고, 그 항목만은 harness가 직접 들고 있어야 한다.
 */
const runClaude = (fixtureRoot, command) => new Promise(resolve => {
  // pluginDir도 allowed 디렉터리로 넣는다. --plugin-dir는 플러그인을 로드만
  // 하고, 스킬이 자기 규칙 모듈(00-rule.md, 번호 모듈들)과
  // prepare-verification.mjs를 읽으려면 그 경로 자체가 이 세션의 허용 작업
  // 디렉터리 안에 있어야 한다. fixture만 허용하면 스킬이 자기 규칙을 Glob도
  // Read도 못 해서, 리뷰가 조용히 규칙 없는 판단으로 줄어든다 — 실제로 첫
  // 실행에서 "규칙 미확인"만 나온 이유가 이것이었다.
  const args = [
    '-p', command,
    '--plugin-dir', pluginDir,
    '--add-dir', fixtureRoot,
    '--add-dir', pluginDir,
    '--permission-mode', 'acceptEdits',
    '--output-format', 'json',
  ]
  const started = Date.now()
  const child = spawn(CLAUDE.command, args, { cwd: fixtureRoot, shell: CLAUDE.shell })
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
  // --output-format json이 stdout에 남기는 결과 봉투. error/close 두 종료
  // 경로가 같은 값을 쓰도록 한 번만 계산하는 자리에 둔다. stdoutTail은
  // 진단용으로 항상 남긴다 — 성공한 run도 예외가 아니다. 이전 리뷰가 이
  // stdout이 파싱도 저장도 안 된 채로 버려진다고 짚었고, 그게 리포트가
  // 없는 run이 블랙박스가 되는 이유였다.
  const envelopeOf = () => parseEnvelope(stdout)
  // spawn 자체가 실패하면(바이너리를 못 찾는 등) close 이벤트는 절대 오지
  // 않는다. 여기서 받지 않으면 처리되지 않은 예외로 프로세스 전체가 죽고,
  // writeFileSync가 for 루프가 끝난 뒤에만 돌기 때문에 이미 끝낸 run들의
  // 결과까지 다 같이 사라진다 — 그래서 이 run만 failed로 접고 배치를 잇는다.
  child.on('error', err => {
    finish({
      completed: 'failed',
      exitCode: null,
      durationSec: Math.round((Date.now() - started) / 1000),
      envelope: envelopeOf(),
      stdoutTail: stdout.slice(-4000),
      stderr: `${stderr}${err.message}`.slice(-4000),
    })
  })
  const timer = setTimeout(() => {
    killedByTimeout = true
    child.kill('SIGKILL')
    // shell 경로로 물러난 경우에만 여기 온다 — 그때는 child.pid가 cmd.exe의
    // pid이고 SIGKILL은 그 shell만 끝낸다. /T로 그 pid가 뿌리인 프로세스
    // 트리 전체를 끝내, shell로 물러나면서 다시 열린 고아 프로세스 위험을
    // 닫는다.
    if (CLAUDE.shell && process.platform === 'win32' && child.pid) {
      try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
    }
  }, timeoutMs)
  child.on('close', (code, signal) => {
    finish({
      completed: classifyExit({ killedByTimeout, code, signal }),
      exitCode: code,
      durationSec: Math.round((Date.now() - started) / 1000),
      envelope: envelopeOf(),
      stdoutTail: stdout.slice(-4000),
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

const outDir = join(ROOT, 'evals', 'results')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, `${caseName}-${label}.json`)
// run 1이 8분·3.5달러를 치르고 끝난 뒤 run 3에서 던지면(readFileSync,
// readBlobLines, grade — 모두 의도적으로 loud하게 던진다), 결과 파일을 루프가
// 끝난 뒤 한 번만 쓰면 이미 낸 돈에 해당하는 run 1·2 결과까지 예외와 함께
// 사라진다. 매 run 뒤 같은 경로에 다시 쓰면 이후에 던지는 예외가 이전
// run들의 결과를 지우지 못한다 — 이 던지는 호출들을 try/catch로 감싸지
// 않고 그대로 던지게 두는 채로 이 문제를 해결한다.
const writeResults = () => writeFileSync(outPath, JSON.stringify({
  case: caseName,
  label,
  pluginDir,
  pluginRef,
  pluginVersion,
  timestamp: startedAt,
  runs,
  results,
}, null, 2), 'utf8')

const results = []
for (let index = 0; index < runs; index += 1) {
  const fixture = makeFixture()
  const execution = await runClaude(fixture.root, meta.command)
  const reportPath = newestReport(fixture.root)
  const envelope = execution.envelope

  // 파일이 먼저다 — review-reports/에 저장하라는 C-7 계약이 그렇게 요구하고,
  // 워크플로우가 그 계약을 실제로 지켰는지가 측정해야 할 신호이기 때문이다.
  // 파일이 없을 때만 stdout 봉투의 result로 접는다. reportSource를 reportFound와
  // 분리해서 남긴다: reportFound는 "디스크에 파일이 있었다"만 뜻하고,
  // reportSource는 "리포트를 어디서 얻었나(file/stdout/둘 다 없음)"를 뜻한다 —
  // 하나로 합치면 "계약대로 파일에 썼다"와 "stdout에서 겨우 건졌다"가
  // 구분되지 않는다.
  const reportSource = reportPath ? 'file' : envelope?.result ? 'stdout' : null
  const reportText = reportSource === 'file' ? readFileSync(reportPath, 'utf8')
    : reportSource === 'stdout' ? envelope.result
    : ''

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
  // completed와 reportSource를 둘 다 요구한다 — 파일이든 stdout이든 실제
  // 리포트 텍스트가 있어야 채점한다. 둘 다 없으면 grade('', ...)가 "찾은 게
  // 0개"라는 멀쩡해 보이는 결과를 내놓는데, 이는 타임아웃과 똑같은 부류의
  // 실패다 — 정직한 미완료 대신 오해를 주는 0.
  const scored = execution.completed === true && reportSource ? grade(reportText, expected, blobLines) : null

  // 리뷰가 fixture를 실제로 건드렸는지 본다. `--permission-mode acceptEdits`가
  // 편집 권한을 주고, `readBlobLines`는 살아있는 파일을 working tree에서
  // 읽는다 — 오늘의 SKILL은 자동 수정을 금지하지만 그 계약이 깨지는 순간을
  // 잡는 것이 이 harness의 목적이므로, "안 건드렸다"를 가정이 아니라 축으로
  // 남긴다. 빈 배열이 기대값이고, 비어 있지 않으면 그 자체로 이 run에 대한
  // finding이다. `review-reports/`는 CLAUDE_MD가 지정한 정상적인 쓰기
  // 대상이라 diff 확인 결과에서 제외한다.
  const fixtureDirty = (() => {
    try {
      return execFileSync('git', ['status', '--porcelain'], { cwd: fixture.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split(/\r?\n/)
        .filter(Boolean)
        .filter(line => !line.slice(3).startsWith('review-reports/'))
    } catch {
      // git status 자체가 실패했다는 것은 fixture 자체가 깨졌다는 뜻이고,
      // 그건 이 axis가 아니라 다른 곳(readBlobLines 등)에서 이미 던졌을
      // 문제다. 여기서는 "확인 못 했다"는 정직한 null로 남긴다.
      return null
    }
  })()

  results.push({
    run: index + 1,
    completed: execution.completed,
    exitCode: execution.exitCode,
    durationSec: execution.durationSec,
    reportFound: Boolean(reportPath),
    reportSource,
    fixtureRoot: fixture.root,
    fixtureDirty,
    // 봉투에서 나오는 진단 정보. permissionDenials가 특히 중요하다 — 리뷰가
    // 리포트를 쓰려다가 --permission-mode acceptEdits에 막혔다면 여기 남는다.
    numTurns: envelope?.num_turns,
    isError: envelope?.is_error,
    stopReason: envelope?.stop_reason,
    permissionDenials: envelope?.permission_denials,
    totalCostUsd: envelope?.total_cost_usd,
    stdoutTail: execution.stdoutTail,
    stderrTail: execution.completed === true ? undefined : execution.stderr,
    ...(scored ?? {}),
  })
  writeResults()
  process.stdout.write(`run ${index + 1}/${runs}: completed=${execution.completed} ${execution.durationSec}s report=${reportSource ?? 'none'}\n`)
}

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
    process.stdout.write(`  run ${result.run}: not graded (completed=${result.completed} reportSource=${result.reportSource})\n`)
  }
}
