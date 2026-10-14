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
//     --rules <RULES_DIR> --workflow full [--base <사용자가 정한 base>] [--host claude-code] [--repo .] \
//     [--correctness on|off] [--max-duration 30m] [--max-tasks 40] [--stale-after 20m] [--continues <runId>] \
//     [--previous <이전 스냅숏>] [--pr-json <gh pr view 출력>] [--no-pr]
//
//   --base      사용자가 리뷰 범위를 정했을 때만 준다. 주지 않으면 지금 브랜치의 열린 PR의 base를 쓰고
//               (다른 PR 위에 쌓인 PR이면 그 브랜치), PR이 없으면 main → master → origin/HEAD다(C-4)
//   --pr-json   gh를 쓸 수 없는 호스트에서 `gh pr view --json number,baseRefName,headRefName,state,url`의 출력
//   --no-pr     PR을 보지 않는다
//   --max-duration·--max-tasks  이 실행의 시간·호출 한도(C-12). 작업 대장(review-tasks.mjs)이 지킨다
//   --stale-after               끝을 받지 못한 시도를 죽은 것으로 볼 시간(기본 20m)
//   --continues                 대상이 바뀌어 이어 가지 못한 앞 실행의 ID
//   --previous                  비교할 이전 리뷰의 스냅숏(C-13). 같은 저장소의 것만 받는다
//   --dry-run  계산만 하고 타임라인에 쓰지 않는다
//
// 값에 공백이 있으면 감싼다. `--dir "C:\Users\...\바탕 화면\Docs"`

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { durationLimitScope, hostCapabilities } from './lib/hosts.mjs'
import { baseDrift, baseLine, changedFilesSince, dependencyFilesOf, reviewBaseOf } from './lib/review-base.mjs'
import { parseSnapshot } from './lib/review-snapshot.mjs'
import { currentTarget, newRunId, repoIdentity, rulesDigest, runOutputs } from './lib/run-identity.mjs'
import { runNameProblem } from './lib/run-name.mjs'
import { writeTextAtomic } from './lib/atomic-write.mjs'
import { scopeOf } from './lib/review-scope.mjs'
import { readJsonFile } from './lib/read-text.mjs'
import { DEFAULT_STALE_AFTER_SEC, parseDuration } from './lib/task-ledger.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TIMELINE = join(ROOT, 'scripts', 'review-timeline.mjs')

const die = message => {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

const VALUE_FLAGS = new Set(['dir', 'run', 'rules', 'workflow', 'base', 'host', 'repo', 'correctness', 'max-duration', 'max-tasks', 'stale-after', 'continues', 'previous', 'pr-json'])
const BOOL_FLAGS = new Set(['dry-run', 'no-pr'])
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
// 사용자가 정한 base. 없으면 아래에서 PR의 base나 기본값으로 정한다(C-4, `lib/review-base.mjs`).
const requestedBase = flag('base')
if (has('no-pr') && flag('pr-json') !== undefined) die('--no-pr와 --pr-json을 함께 줄 수 없다')
// host는 **harness 이름**이다(claude-code / opencode / …). 기존 기록이 한 번은
// OS를, 한 번은 harness를 적어 두 실행을 나란히 놓을 수 없었다. OS가 필요하면
// `--set os=win32`로 따로 싣는다.
const host = flag('host', 'unknown')
const repo = flag('repo', process.cwd())
// 선택 패스(catalog의 `optIn`)를 켰는지. 기본은 꺼짐이다 — correctness 패스는 검출 효과와
// 추가 비용을 확인하기 전까지 명시적으로 켜서 쓴다(#88). 켰는지를 여기서 기록해야, 결과가
// 없는 것이 "켜지 않았다"인지 "켰는데 실패했다"인지 뒤의 스크립트가 가를 수 있다.
const correctness = flag('correctness', 'off')
if (!['on', 'off'].includes(correctness)) die(`--correctness는 on 또는 off다 (받은 값: ${JSON.stringify(correctness)})`)

// 한도(C-12). 주지 않으면 한도가 없다 — 없는 한도를 기본값으로 지어 넣으면 사용자가 정하지 않은
// 이유로 리뷰가 멈춘다. 읽지 못하는 값은 거부한다: 잘못 읽은 한도는 한도가 없는 것보다 나쁘다.
const limitOf = (name, read, form) => {
  const raw = flag(name)
  if (raw === undefined) return null
  const value = read(raw)
  if (value === null) die(`--${name}는 ${form}이다 (받은 값: ${JSON.stringify(raw)})`)
  return value
}
const maxDurationSec = limitOf('max-duration', parseDuration, '양의 시간(90, 90s, 30m, 2h)')
const maxTasks = limitOf('max-tasks', raw => (/^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null), '양의 정수')
const staleAfterSec = limitOf('stale-after', parseDuration, '양의 시간(90, 90s, 30m, 2h)') ?? DEFAULT_STALE_AFTER_SEC
const continues = flag('continues')

// 비교할 이전 리뷰(C-13). 읽을 수 없는 스냅숏을 "이전 지적 0건"으로 읽으면 이전 지적이 전부 해결된
// 것처럼 보인다 — 읽지 못하면 시작하지 않는다. 해시를 남겨 두어, 비교하는 단계가 같은 파일을 읽는지 본다.
const previous = (() => {
  const path = flag('previous')
  if (path === undefined) return null
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    die(`--previous의 스냅숏을 읽지 못했다: ${path} — ${error.message}`)
  }
  const parsed = parseSnapshot(text)
  if (parsed.error) die(`--previous의 스냅숏을 쓸 수 없다: ${path} — ${parsed.error}`)
  return { path: resolve(path), sha256: createHash('sha256').update(text).digest('hex'), snapshot: parsed.value }
})()

if (!dir || !run || !rules || !workflow) {
  die('usage: review-preflight.mjs --dir <리포트 디렉터리> --run <리포트 basename> --rules <RULES_DIR> --workflow <이름> [--base <base>] [--host 이름]')
}
const runProblem = runNameProblem(run)
if (runProblem) die(runProblem)
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
    return readJsonFile(path).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()

const catalog = (() => {
  const path = join(rules, 'catalog.json')
  if (!existsSync(path)) die(`catalog.json not found in --rules: ${path}`)
  try {
    return readJsonFile(path)
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
const optedIn = module => (module.optIn ?? []).includes(workflow)
const specialists = forWorkflow.filter(module => module.role === 'specialist' && !optedIn(module))
const optional = forWorkflow.filter(module => module.role === 'specialist' && optedIn(module))
if (correctness === 'on' && !optional.some(module => module.id === 'correctness')) {
  die(`--correctness on은 correctness 선택 패스가 있는 워크플로우에서만 쓴다 — ${JSON.stringify(workflow)}에는 없다`)
}

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

// 리뷰 범위의 기준. 사용자가 정한 범위 → 지금 브랜치의 열린 PR의 base → main·master·origin/HEAD 순이다.
// 다른 PR 위에 쌓은 PR을 main 기준으로 리뷰하면 아래 PR의 변경까지 리뷰한다(C-4).
const chosenBase = reviewBaseOf(repo, { requested: requestedBase, prJson: flag('pr-json'), noPr: has('no-pr') })
if (chosenBase.error) die(chosenBase.error)
const base = chosenBase.ref
const mergeBase = chosenBase.mergeBase

// 실행 이름은 C-7의 리포트 이름을 따른다 — `code-review-{workflow}-{브랜치}-{날짜}`. 2026-10-12 실행은
// `full-code-review-2026-10-12`로 시작해 워크플로우 접두와 브랜치가 빠졌다. 같은 날 다른 브랜치의 리뷰와
// 이름이 겹치고, 리포트만 가진 사람은 어느 브랜치의 리뷰인지 이름으로 알 수 없다.
{
  const prefix = `code-review-${workflow}-`
  if (!run.startsWith(prefix)) {
    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const slug = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
    die(`--run은 C-7의 리포트 이름(code-review-{workflow}-{브랜치}-{날짜})을 따른다 — ${JSON.stringify(run)}는 ${JSON.stringify(prefix)}로 시작하지 않는다. 예: ${prefix}${slug}-${today}`)
  }
}

const changed = (() => {
  try {
    return changedFilesSince(repo, mergeBase)
  } catch (error) {
    die(`변경 파일 목록을 읽지 못했다: ${String(error.stderr || error.message).trim()}`)
  }
})()

// 지적 대상으로 삼는 파일(C-5). 이름 규칙으로 빼는 테스트·mock 파일은 여기서 센다 — `scope.done`의 수다.
const scope = scopeOf(changed)

// base가 merge-base 뒤로 앞서 나가 같은 파일을 바꿨는지(C-6). 리뷰 diff에는 보이지 않지만, 도구는 base를 따라잡지
// 않은 HEAD에서 돈다 — 실패가 이 변경이 아니라 따라잡지 않은 데서 올 수 있다. 어느 쪽인지는 합친 트리에서 다시 재야
// 가린다(C-6). 재지 못하면 알리기만 하고 계속한다.
const baseMoved = baseDrift(repo, base, mergeBase, changed)
// 목록은 기록에 20개까지만 싣는다. `--summary` 표가 `run.start` 한 줄에 이 값을 그대로 펼친다.
const OVERLAP_RECORDED = 20
// 의존성 매니페스트를 바꾼 변경이면 baseline은 그 트리에 따로 설치한 의존성으로 잰다(C-6).
const dependencyFiles = dependencyFilesOf(changed)

// 리포트를 어디에 쓰는가(C-7). **대상 저장소의 루트면 시작하지 않는다.** 2026-10-12에 세 실행 중 둘이 루트에
// 썼다 — 리포트와 `.timing`이 미추적 파일로 남아 함께 커밋될 수 있고, 한 실행은 그 파일들이 작업 트리 변경으로
// 세져 "검토 도중 대상이 바뀌었다"는 거짓 경보를 판정에 옮겼다. 사용자는 문서 폴더를 따로 정해 두고 있었다.
// 아무것도 쓰기 전에 멈추므로, 자리를 다시 정해 같은 명령을 부르면 된다. 루트가 아닌 저장소 안의 자리는
// 막지 않고 알리기만 한다 — 프로젝트가 그 자리를 정했을 수 있다.
const placement = (() => {
  const top = git(['rev-parse', '--show-toplevel'])
  if (typeof top !== 'string') return null
  const rel = relative(resolve(top), resolve(dir))
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  if (rel === '') {
    die([
      `--dir이 대상 저장소의 루트다(${top}) — 시작하지 않는다(C-7). 리포트와 .timing이 미추적 파일로 남아 함께 커밋될 수 있다.`,
      '리포트 자리는 이 순서로 정한다:',
      '  1. 사용자가 이번 요청에서 정한 곳',
      '  2. 사용자·프로젝트 지시 파일(전역 포함 CLAUDE.md·AGENTS.md)에 적힌 문서 저장 위치',
      `  3. 둘 다 없으면 ${join(top, 'review-reports')}`,
      '리포트와 .timing은 같은 디렉터리에 둔다 — 나중에 리포트만 옮기면 기록과 리포트가 서로를 못 찾는다.',
    ].join('\n'))
  }
  const ignored = typeof git(['check-ignore', '-q', join(resolve(dir), '.timing', `${run}.jsonl`)]) === 'string'
  if (ignored) return null
  return `리포트 디렉터리(${rel})가 대상 저장소 안에 있고 무시 목록에 없다 — 리포트와 .timing이 미추적 파일로 남는다. 커밋하지 않게 주의한다. 사용자·프로젝트 지시에 문서 저장 위치가 있으면 그쪽이 먼저다(C-7)`
})()

// 무엇을 리뷰하는지를 값으로 남긴다(#88 PR 0). 브랜치와 merge-base만으로는 두 실행이
// 같은 대상을 봤는지 말할 수 없다 — 같은 HEAD에서 작업 트리만 바뀐 두 실행이 기록상
// 똑같았다. 그런데 producer와 위치 대조는 작업 트리의 파일을 읽는다. 계산하지 못하면
// 시작하지 않는다 — 대상이 기록되지 않은 실행의 결과는 다른 실행과 이을 수 없다.
const identity = (() => {
  try {
    // 리포트 디렉터리는 뺀다. 기본 저장 위치는 대상 저장소 안이고, 이 실행이 거기 쓰는
    // 기록이 대상을 바꾼 것으로 보이면 안 된다.
    const target = currentTarget(repo, { exclude: runOutputs(dir, run) })
    const { remote, root } = repoIdentity(repo)
    return { runId: newRunId(), ...target, remote, root, rulesDigest: rulesDigest(rules) }
  } catch (error) {
    die(`리뷰 대상을 식별하지 못했다: ${String(error.stderr || error.message).trim()}`)
  }
})()

// 다른 저장소의 리뷰와는 비교하지 않는다. 같은 경로·같은 규칙이라도 다른 코드다.
if (previous) {
  const before = previous.snapshot.target
  if (before.repoRoot !== identity.root) {
    die(`--previous의 스냅숏은 다른 저장소의 리뷰다(root commit ${before.repoRoot} ≠ ${identity.root}) — 비교하지 않는다`)
  }
  if (previous.snapshot.run.workflow !== workflow) {
    die(`--previous의 스냅숏은 ${previous.snapshot.run.workflow} 워크플로우의 것이다 — 같은 워크플로우의 리뷰와만 비교한다`)
  }
}

const logged = (() => {
  if (has('dry-run')) return { ok: true, skipped: true }
  // `--set`이 아니라 `--data`로 넘긴다. `--set`은 숫자로 되돌아오는 값을 숫자로 바꾸므로
  // `--base 1234` 같은 값의 타입이 넘긴 것과 달라질 수 있다. 셸을 거치지 않는 인자 배열이라
  // JSON이 깨질 자리는 없다.
  const data = {
    host,
    rules,
    version,
    branch,
    changedFiles: changed.length,
    candidates: candidates.length,
    workflow,
    mergeBase,
    runId: identity.runId,
    base,
    baseSource: chosenBase.source,
    ...(chosenBase.pr ? { prNumber: chosenBase.pr.number, prBase: chosenBase.pr.baseRefName } : {}),
    head: identity.head,
    worktree: identity.worktree,
    dirtyFiles: identity.dirtyFiles,
    ...(baseMoved ? { baseAhead: baseMoved.ahead } : {}),
    ...(baseMoved?.overlap.length ? { baseOverlapCount: baseMoved.overlap.length, baseOverlap: baseMoved.overlap.slice(0, OVERLAP_RECORDED) } : {}),
    ...(dependencyFiles.length ? { dependencyFiles } : {}),
    // 원격이 없으면 필드를 비워 둔다. 없는 값을 지어 넣지 않는다.
    ...(identity.remote ? { repo: identity.remote } : {}),
    repoRoot: identity.root,
    rulesDigest: identity.rulesDigest,
    // 선택 패스가 있는 워크플로우만 남긴다. 없는 워크플로우에 `off`를 적으면 "끌 수 있었는데
    // 껐다"로 읽힌다.
    ...(optional.some(module => module.id === 'correctness') ? { correctness } : {}),
    ...(maxTasks !== null ? { maxTasks } : {}),
    ...(maxDurationSec !== null ? { maxDurationSec } : {}),
    staleAfterSec,
    ...(continues !== undefined ? { continues } : {}),
    ...(previous ? { previousSnapshot: previous.path, previousRunId: previous.snapshot.run.runId, previousSha256: previous.sha256 } : {}),
  }
  const args = [TIMELINE, '--dir', dir, '--run', run, '--phase', 'run.start', '--data', JSON.stringify(data)]
  try {
    execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    return { ok: false, error: String(error.stderr || error.message).trim() }
  }
  // 범위도 여기서 남긴다(C-5·C-9). 목록은 producer 프롬프트에 그대로 쓰도록 파일로 둔다.
  try {
    writeTextAtomic(join(dir, '.timing', `${run}.scope.json`), `${JSON.stringify({
      schemaVersion: 1, runId: identity.runId, mergeBase, head: identity.head, files: scope.files, excluded: scope.excluded,
    }, null, 2)}\n`)
    execFileSync(process.execPath, [TIMELINE, '--dir', dir, '--run', run, '--phase', 'scope.done', '--data',
      JSON.stringify({ files: scope.files.length, excluded: scope.excluded.length })], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    return { ok: false, error: `run.start는 남겼지만 범위를 남기지 못했다 — ${String(error.stderr || error.message).trim()}` }
  }
  return { ok: true, skipped: false }
})()

/** `base 앞섬` 줄. 같은 파일을 바꿨으면 도구 결과를 어떻게 읽어야 하는지까지 적는다. */
function baseMovedLine(moved) {
  if (!moved) return '재지 못했다 — base와 merge-base 사이의 커밋을 읽지 못했다'
  if (moved.ahead === 0) return '없음 — HEAD가 base를 따라잡았다'
  if (!moved.overlap.length) return `${base}이 merge-base 뒤로 ${moved.ahead}커밋 앞서 있다 — 이 브랜치가 바꾼 파일은 건드리지 않았다`
  const shown = moved.overlap.slice(0, 5).join(', ')
  return `${base}이 merge-base 뒤로 ${moved.ahead}커밋 앞서 있고, 이 브랜치와 같은 파일 ${moved.overlap.length}개를 바꿨다: ${shown}${moved.overlap.length > 5 ? ` 외 ${moved.overlap.length - 5}개` : ''} — lint·typecheck·test는 base를 따라잡지 않은 HEAD에서 돈다. 실패가 그 때문인지는 이 브랜치를 base에 합친 트리에서 다시 재 가린다. 파일이 겹친다는 것만으로 이 변경의 실패가 아니라고 하지 않는다(C-6)`
}

const out = [
  `플러그인      ${version}`,
  `규칙 경로     ${rules}`,
  `워크플로우    ${workflow}`,
  `브랜치        ${branch}`,
  `base          ${baseLine(chosenBase)}`,
  `merge-base    ${mergeBase}`,
  `base 앞섬     ${baseMovedLine(baseMoved)}`,
  `HEAD          ${identity.head}`,
  `작업 트리     ${identity.worktree === 'clean' ? 'clean' : `커밋하지 않은 변경 ${identity.dirtyFiles}개 (${identity.worktree})`}`,
  `실행 ID       ${identity.runId}`,
  `변경 파일     ${changed.length}개`,
  `리뷰 파일     ${scope.files.length}개 (제외 ${scope.excluded.length}개 — 테스트·mock, C-5)${logged.ok && !logged.skipped ? ` · 목록 .timing/${run}.scope.json` : ''}`,
  ...(dependencyFiles.length ? [`의존성 변경   ${dependencyFiles.join(', ')} — baseline은 그 트리에 그 트리의 의존성을 설치해 잰다. 지금 트리의 의존성을 같이 쓰면 baseline도 같은 실패를 내 "신규 0"으로 잘못 나온다(C-6)`] : []),
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
for (const module of optional) {
  const state = module.id === 'correctness' ? correctness : 'off'
  out.push(`선택 패스     ${module.id} ${state === 'on' ? '켜짐' : `꺼짐 — --${module.id} on일 때만 돈다`}`)
}
{
  const capabilities = hostCapabilities(host)
  const minutes = sec => (sec % 60 === 0 ? `${sec / 60}분` : `${sec}초`)
  out.push('')
  out.push(`한도          ${maxTasks === null && maxDurationSec === null ? '없음' : [maxTasks !== null ? `호출 ${maxTasks}개` : null, maxDurationSec !== null ? `시간 ${minutes(maxDurationSec)}` : null].filter(Boolean).join(' · ')} — 응답 없이 ${minutes(staleAfterSec)}이 지난 시도는 죽은 것으로 본다`)
  out.push(`호스트        ${capabilities.name}${capabilities.known ? '' : ' (알려지지 않은 호스트 — 아무 능력도 가정하지 않는다)'}: 작업별 완료 알림 ${capabilities.perTaskNotification ? '있음' : '없음'} · 작업 중지 ${capabilities.cancel ? '가능' : '불가'}`)
  if (maxDurationSec !== null) out.push(`              ${durationLimitScope(capabilities)}`)
  if (continues !== undefined) out.push(`이어 받음     앞 실행 ${continues} — 대상이 바뀌어 새 실행으로 시작했다`)
  if (previous) {
    const before = previous.snapshot
    out.push(`이전 리뷰     ${before.run.runId} (HEAD ${before.target.head.slice(0, 12)} · ${before.createdAt}) — 지적 ${before.findings.length}개와 이번 결과를 비교한다`)
    if (before.status !== 'complete') out.push(`              이전 리뷰는 ${before.status === 'partial' ? '부분 완료' : '실패'}였다 — 그때 검토하지 않은 모듈의 지적은 비교에서 신규로 쓰지 않는다`)
  }
}
if (placement) {
  out.push('')
  out.push(`리포트 위치   ${placement}`)
}
if (identity.worktree !== 'clean') {
  out.push('')
  out.push('작업 트리에 커밋하지 않은 변경이 있다. 리뷰 diff(merge-base..HEAD)에는 들어가지 않지만, 파일을 읽는 단계(위치 확인·추가 Read)는 그 내용을 본다. `리뷰 기준`에 이 사실을 적는다.')
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
