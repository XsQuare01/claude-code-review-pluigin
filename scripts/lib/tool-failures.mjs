import { execFileSync } from 'node:child_process'
import { isAbsolute, relative, resolve } from 'node:path'

// 도구가 실패한 **자리**를 출력에서 읽고, 그 자리가 이 변경의 파일인지·저장소가 추적하는 파일인지 가른다(C-6).
//
// 왜 있는가: 2026-10-13 실행은 lint 실패(오류 12·경고 25)와 테스트 실패 3건을 "baseline 미측정이라 단정하지
// 않는다"로만 남겼다. lint 실패는 전부 .gitignore에 든 `tmp/` 아래 파일이었고, 테스트 3건은 이 변경이 건드리지
// 않은 파일이었다(둘은 시간 초과). 로그에 다 있던 사실인데 리포트에 없었다. baseline을 잰 실행은 지금까지 한
// 번도 없다 — 비싼 측정을 하기 전에 싼 사실부터 낸다.
//
// 이 모듈은 **사실만** 낸다. 변경 밖 파일의 실패도 이 변경이 만들 수 있다(바꾼 함수를 가져다 쓰는 다른 파일의
// 테스트). 추적되지 않는 파일만 저장소의 상태가 아니라고 말할 수 있다. 판정은 SKILL과 계약이 정한다.

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g
const SOURCE = String.raw`[^\s()]+?\.(?:[cm]?[jt]sx?|vue|svelte)`
const ESLINT_HEADER = new RegExp(String.raw`^(${SOURCE})\s*$`)
const ESLINT_PROBLEM = /^\s+\d+:\d+\s+(error|warning)\s/
const TSC_PAREN = new RegExp(String.raw`^(${SOURCE})\(\d+,\d+\): error TS\d+`)
const TSC_PRETTY = new RegExp(String.raw`^(${SOURCE}):\d+:\d+ - error TS\d+`)
const TEST_FAIL = new RegExp(String.raw`^\s*FAIL\s+(?:\|[^|]+\|\s+)?(${SOURCE})(?=\s|$)`)
const TEST_TIMEOUT = /Test timed out in \d+\s*ms|Exceeded timeout of \d+\s*ms/

/**
 * 출력 텍스트에서 실패 자리를 읽는다. 아는 모양은 ESLint stylish, tsc(`file(l,c): error TS…`와 `--pretty`),
 * vitest·jest의 `FAIL` 줄과 시간 초과다. 돌려주는 값은 `Map<출력에 적힌 경로, { errors, warnings, failed, timeouts }>`.
 */
export function failureLocations(text) {
  const files = new Map()
  const entry = path => {
    if (!files.has(path)) files.set(path, { errors: 0, warnings: 0, failed: 0, timeouts: 0 })
    return files.get(path)
  }
  let eslintFile = null
  let testFile = null
  for (const raw of String(text).replace(ANSI, '').split(/\r?\n/)) {
    const header = raw.match(ESLINT_HEADER)
    if (header) {
      eslintFile = header[1]
      continue
    }
    const problem = raw.match(ESLINT_PROBLEM)
    if (problem && eslintFile) {
      entry(eslintFile)[problem[1] === 'error' ? 'errors' : 'warnings'] += 1
      continue
    }
    if (raw.trim() === '') eslintFile = null
    const tsc = raw.match(TSC_PAREN) ?? raw.match(TSC_PRETTY)
    if (tsc) {
      entry(tsc[1]).errors += 1
      continue
    }
    const failed = raw.match(TEST_FAIL)
    if (failed) {
      testFile = failed[1]
      entry(testFile).failed += 1
      continue
    }
    if (testFile && TEST_TIMEOUT.test(raw)) entry(testFile).timeouts += 1
  }
  return files
}

const posix = path => path.replace(/\\/g, '/')

/**
 * 실패 자리를 저장소 기준 경로로 바꾸고 가른다.
 *
 * - `inChange`: 이 변경이 바꾼 파일(`changed` — 리뷰 대상과, 테스트·mock처럼 대상에서 뺀 파일 모두)
 * - `outsideChange`: 저장소가 추적하지만 이 변경이 바꾸지 않은 파일
 * - `untracked`: 저장소가 추적하지 않는 파일(.gitignore에 든 것, 커밋하지 않은 새 파일, 저장소 밖)
 *
 * `changed`가 `null`이면 변경 목록을 모르는 것이고, 추적하는 파일은 모두 `outsideChange`가 아니라 `tracked`로 낸다.
 */
export function classifyFailures(files, { repo, changed, limit = 20 }) {
  // 아는 모양의 자리가 하나도 없다 — 출력을 직접 읽어야 한다
  if (!files.size) return { parsed: false }
  let root
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return { parsed: true, error: '저장소 루트를 읽지 못했다' }
  }
  const located = []
  for (const [shown, counts] of files) {
    const absolute = isAbsolute(shown) ? shown : resolve(repo, shown)
    const rel = posix(relative(root, absolute))
    located.push({ path: rel.startsWith('../') || isAbsolute(rel) ? posix(absolute) : rel, inside: !rel.startsWith('../') && !isAbsolute(rel), counts })
  }
  const inside = located.filter(one => one.inside).map(one => one.path)
  let tracked = new Set()
  if (inside.length) {
    try {
      const out = execFileSync('git', ['ls-files', '-z', '--', ...inside], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      tracked = new Set(out.split('\0').filter(Boolean))
    } catch {
      return { parsed: true, error: '추적 여부를 읽지 못했다(git ls-files)' }
    }
  }
  const sameFile = process.platform === 'win32' ? path => path.toLowerCase() : path => path
  const changedSet = changed ? new Set([...changed].map(path => sameFile(posix(path)))) : null
  const groups = changedSet ? { inChange: [], outsideChange: [], untracked: [] } : { tracked: [], untracked: [] }
  let timeouts = 0
  for (const one of located) {
    timeouts += one.counts.timeouts
    const isTracked = one.inside && tracked.has(one.path)
    if (!isTracked) groups.untracked.push(one.path)
    else if (!changedSet) groups.tracked.push(one.path)
    else if (changedSet.has(sameFile(one.path))) groups.inChange.push(one.path)
    else groups.outsideChange.push(one.path)
  }
  const result = { parsed: located.length > 0, files: located.length }
  for (const [name, paths] of Object.entries(groups)) {
    result[name] = paths.sort().slice(0, limit)
    if (paths.length > limit) result[`${name}Count`] = paths.length
  }
  if (timeouts) result.timeouts = timeouts
  result.timedOutFiles = located.filter(one => one.counts.timeouts > 0).map(one => one.path).sort().slice(0, limit)
  if (!result.timedOutFiles.length) delete result.timedOutFiles
  return result
}

/** 기록(`tool.done`)에 남길 요약 — 무리의 크기만. 경로 목록은 로그와 도구 출력에 있다. */
export function failureCounts(classified) {
  if (!classified?.parsed || classified.error) return null
  const size = name => classified[`${name}Count`] ?? classified[name]?.length ?? 0
  return Object.fromEntries(['inChange', 'outsideChange', 'tracked', 'untracked'].filter(name => name in classified).map(name => [name, size(name)]))
}
