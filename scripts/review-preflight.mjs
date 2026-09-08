#!/usr/bin/env node
// 리뷰가 시작되기 전에, 시작됐다는 사실부터 남긴다.
//
// 왜 이 스크립트가 있는가: C-9는 첫 sub-agent보다 먼저 `run.start`를 남기라고
// 하지만, 그것은 **기억해야 하는 지시**였다. 2026-09-08의 한 실행(357개 파일,
// 3시간 28분)은 계약 문서를 읽고도 타임라인을 한 줄도 남기지 않았다. 컨텍스트
// 압축 때문이 아니다 — 첫 producer보다 55분 뒤에야 압축이 일어났다. 시작 단계에서
// 그냥 건너뛴 것이고, 그것을 막는 장치가 없었다.
//
// 그래서 기록을 **모델이 출력을 필요로 하는 자리**로 옮긴다. `리뷰 기준`과
// `실행 계획`에 적을 값(버전, 규칙 경로, 후보 모듈, 변경 규모)을 이 스크립트만
// 낼 수 있게 하면, 기록을 건너뛰는 경로가 사라진다. 기억해야 하는 단계는
// 건너뛰이고, 결과를 받아야 하는 단계는 건너뛰이지 않는다.
//
// 후보 수를 여기서 세는 두 번째 이유: 한 리포트가 후보를 20개가 아니라 21개로
// 적었다 — synthesis 전용 모듈(`10-principles.md`)을 후보로 세면서. 산술을 모델이
// 눈으로 세지 않는다는 이 저장소의 원칙이 모듈 수에도 그대로 적용된다.
//
// Usage:
//
//   review-preflight.mjs --dir <리포트 디렉터리> --run <리포트 basename> \
//     --rules <RULES_DIR> --workflow full [--base main] [--host claude-code] [--repo .]
//
//   --dry-run  계산만 하고 타임라인에 쓰지 않는다
//
// 값에 공백이 있으면 감싼다. `--dir "C:\Users\...\바탕 화면\Docs"`

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TIMELINE = join(ROOT, 'scripts', 'review-timeline.mjs')

const die = message => {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

const VALUE_FLAGS = new Set(['dir', 'run', 'rules', 'workflow', 'base', 'host', 'repo'])
const BOOL_FLAGS = new Set(['dry-run'])
{
  const argv = process.argv.slice(2)
  const seen = new Set()
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at]
    // 값에 공백이 있으면 셸이 거기서 쪼갠다. 남은 토큰을 조용히 무시하면 잘린
    // 값으로 계산하고 아무도 모른다 — review-timeline.mjs와 같은 이유로 시끄럽게 실패시킨다.
    if (!arg.startsWith('--')) die(`unexpected argument ${JSON.stringify(arg)} — 값에 공백이 있으면 따옴표로 감싸라`)
    const name = arg.slice(2)
    if (BOOL_FLAGS.has(name)) continue
    if (!VALUE_FLAGS.has(name)) die(`unknown flag ${arg}`)
    // 같은 플래그가 두 번 오면 거부한다. 값을 읽는 쪽은 첫 번째만 보므로,
    // 두 번째를 조용히 버리면 **넘긴 값과 쓰인 값이 다른데 아무도 모른다.**
    if (seen.has(name)) die(`--${name}이 두 번 왔다. 값을 읽는 쪽은 첫 번째만 본다`)
    seen.add(name)
    const value = argv[at + 1]
    if (value === undefined || value.startsWith('--')) die(`${arg} needs a value`)
    at += 1
  }
}

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const has = name => process.argv.includes(`--${name}`)

const dir = flag('dir')
const run = flag('run')
const rules = flag('rules')
const workflow = flag('workflow')
const base = flag('base', 'main')
// host는 **harness 이름**이다(claude-code / opencode / …). 기존 기록이 한 번은
// OS를, 한 번은 harness를 적어 두 실행을 나란히 놓을 수 없었다. OS가 필요하면
// `--set os=win32`로 따로 싣는다.
const host = flag('host', 'unknown')
const repo = flag('repo', process.cwd())

if (!dir || !run || !rules || !workflow) {
  die('usage: review-preflight.mjs --dir <리포트 디렉터리> --run <리포트 basename> --rules <RULES_DIR> --workflow <이름> [--base main] [--host 이름]')
}
if (/[\\/]/.test(run)) die(`--run must be a bare basename, got ${JSON.stringify(run)}`)
if (!existsSync(rules)) die(`--rules not found: ${rules}`)

// 이미 시작된 실행에 두 번째 시작을 얹지 않는다. 그러면 한 파일에 두 실행이
// 섞여, 어느 줄이 어느 실행인지 가릴 수 없다.
const sidecar = join(dir, '.timing', `${run}.jsonl`)
if (existsSync(sidecar) && /"phase":"run\.start"/.test(readFileSync(sidecar, 'utf8'))) {
  die(`이미 시작된 타임라인이다(${sidecar}). 새 실행은 다른 --run 이름으로 남겨라`)
}

/** 플러그인 버전은 **스크립트가 사는 곳**에서 읽는다. */
//
// RULES_DIR은 홈 사본으로 해석될 수 있고(C-1의 3번 경로), 그때 버전과 규칙이
// 서로 다른 설치에서 온다. 둘을 각각 기록해야 그 어긋남이 사이드카에 보인다.
const version = (() => {
  const path = join(ROOT, '.claude-plugin', 'plugin.json')
  if (!existsSync(path)) return 'unknown'
  try {
    return JSON.parse(readFileSync(path, 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()

const catalog = (() => {
  const path = join(rules, 'catalog.json')
  if (!existsSync(path)) die(`catalog.json not found in --rules: ${path}`)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    die(`catalog.json is not valid JSON: ${error.message}`)
  }
})()

const modules = catalog.modules ?? []
const forWorkflow = modules.filter(module => (module.workflows ?? []).includes(workflow))
if (!forWorkflow.length) die(`--workflow ${JSON.stringify(workflow)}에 해당하는 모듈이 catalog.json에 없다`)

// 후보에서 빠지는 둘을 **이유와 함께** 낸다. 빠진 사실만 남기면 나중에
// "안 돌았다"와 "후보가 아니었다"를 구분할 수 없다 (C-8).
const commonContext = forWorkflow.filter(module => module.role === 'common-context')
const deferred = forWorkflow.filter(module =>
  module.role === 'module' && module.phaseByWorkflow?.[workflow] === 'post-verification-synthesis')
const candidates = forWorkflow.filter(module =>
  module.role === 'module' && module.phaseByWorkflow?.[workflow] !== 'post-verification-synthesis')
const specialists = forWorkflow.filter(module => module.role === 'specialist')

const git = args => {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    return { error: String(error.stderr || error.message).trim() }
  }
}

const branch = (() => {
  const out = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  return typeof out === 'string' ? out : 'unknown'
})()

const mergeBase = (() => {
  const out = git(['merge-base', base, 'HEAD'])
  if (typeof out === 'string' && out) return out
  die(`base ${JSON.stringify(base)}를 HEAD와 맞춰볼 수 없다 — 존재하는 ref를 --base로 넘겨라\n${typeof out === 'object' ? out.error : ''}`)
})()

const changed = (() => {
  const out = git(['diff', '--name-only', `${mergeBase}...HEAD`])
  if (typeof out !== 'string') die(`변경 파일 목록을 읽지 못했다: ${out.error}`)
  return out ? out.split('\n').filter(Boolean) : []
})()

const logged = (() => {
  if (has('dry-run')) return { ok: true, skipped: true }
  const args = [
    TIMELINE, '--dir', dir, '--run', run, '--phase', 'run.start',
    '--set', `host=${host}`,
    '--set', `rules=${rules}`,
    '--set', `version=${version}`,
    '--set', `branch=${branch}`,
    '--set', `changedFiles=${changed.length}`,
    '--set', `candidates=${candidates.length}`,
    '--set', `workflow=${workflow}`,
    '--set', `mergeBase=${mergeBase}`,
  ]
  try {
    execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, skipped: false }
  } catch (error) {
    return { ok: false, error: String(error.stderr || error.message).trim() }
  }
})()

const out = [
  `플러그인      ${version}`,
  `규칙 경로     ${rules}`,
  `워크플로우    ${workflow}`,
  `브랜치        ${branch}`,
  `base          ${base}`,
  `merge-base    ${mergeBase}`,
  `변경 파일     ${changed.length}개`,
  '',
  `후보 모듈     ${candidates.length}개  ${candidates.map(module => module.id).join(' ')}`,
]
if (commonContext.length) {
  out.push(`후보 아님     ${commonContext.map(module => module.id).join(' ')} — 공통 컨텍스트 전용(독립 pass로 실행하지 않는다)`)
}
if (deferred.length) {
  out.push(`후보 아님     ${deferred.map(module => module.id).join(' ')} — post-verification-synthesis(검증 이후 한 번만 실행)`)
}
if (specialists.length) {
  out.push(`특수 패스     ${specialists.map(module => module.id).join(' ')} — 후보 수에 넣지 않는다`)
}
out.push('')
out.push(logged.skipped
  ? '타임라인      --dry-run, 쓰지 않았다'
  : logged.ok
    ? `타임라인      run.start 기록 (${sidecar})`
    : `타임라인      **기록 실패** — ${logged.error}`)
if (!logged.ok) {
  out.push('')
  out.push('기록 실패는 리뷰 실패가 아니다. 리뷰는 계속하되, 리포트의 `실행 타임라인` 섹션에 남기지 못했다는 사실을 적어라 (C-9).')
}

process.stdout.write(out.join('\n') + '\n')
process.exit(logged.ok ? 0 : 1)
