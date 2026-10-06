import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

// 실행이 **무엇을** 리뷰했는지를 값으로 남긴다(#88 PR 0).
//
// 지금까지 기록은 브랜치와 merge-base만 남겼다. 그것으로는 두 실행이 같은 대상을
// 봤는지 말할 수 없다 — 같은 HEAD에서 작업 트리만 바뀐 두 실행이 기록상 똑같다.
// 그런데 producer와 위치 대조는 작업 트리의 파일을 읽으므로, 두 실행은 다른 내용을
// 봤다. 이전 판정을 다음 실행에 이어 붙이는 기능(증분 재리뷰)이 그 둘을 같은 대상으로
// 치면, 바뀐 코드에 낡은 판정이 붙는다.
//
// 읽기만 한다. `git hash-object`는 `-w` 없이 부르고, 인덱스 갱신 같은 선택적 쓰기는
// `GIT_OPTIONAL_LOCKS=0`으로 막는다 — 리뷰는 대상 저장소를 고치지 않는다(C-6).

const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }

const git = (cwd, args, input) => execFileSync('git', args, {
  cwd,
  env: GIT_ENV,
  encoding: 'utf8',
  input,
  maxBuffer: 256 * 1024 * 1024,
  stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
})

const sha256 = text => createHash('sha256').update(text).digest('hex')

/** 실행마다 새로 만든다. 리포트 basename(`--run`)은 같은 날 같은 브랜치에서 겹칠 수 있다. */
export function newRunId() {
  return randomUUID()
}

/**
 * 원격 주소를 비교할 수 있는 모양으로 맞춘다. 없으면 `null`이다.
 *
 * **자격 증명을 뗀다.** `https://user:token@host/…`를 그대로 기록하면 토큰이 사이드카와
 * 스냅숏에 남는다. 같은 저장소를 https와 ssh로 받은 두 체크아웃이 같은 값이 되도록
 * scp 꼴(`git@host:path`)도 같은 모양으로 푼다. 호스트만 소문자로 바꾼다 — 경로의
 * 대소문자를 구분하는 호스트가 있다.
 */
export function normalizeRemote(url) {
  const text = String(url ?? '').trim()
  if (!text) return null
  let host
  let path
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(text)
  if (!text.includes('://') && scp) {
    host = scp[1]
    path = scp[2]
  } else {
    try {
      const parsed = new URL(text)
      host = parsed.hostname
      path = parsed.pathname
    } catch {
      // 로컬 경로 원격. 비교만 하면 되므로 그대로 둔다.
      return `path:${text}`
    }
  }
  if (!host) return `path:${text}`
  const cleaned = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
  return `${host.toLowerCase()}/${cleaned}`
}

/**
 * 저장소 식별 — 원격 주소와 root commit.
 *
 * 둘 다 남기는 이유: 원격은 이름이 바뀌거나 없을 수 있고(로컬 저장소), root commit은
 * fork끼리 같다. 어느 하나만으로는 "같은 저장소인가"에 답하지 못한다. root commit이
 * 여럿이면(이력을 합친 저장소) 정렬한 첫 값을 쓴다 — 같은 저장소면 같은 값이 나온다.
 */
export function repoIdentity(repo) {
  let remote = null
  try {
    remote = normalizeRemote(git(repo, ['remote', 'get-url', 'origin']))
  } catch {
    remote = null
  }
  const roots = git(repo, ['rev-list', '--max-parents=0', 'HEAD']).split('\n').map(line => line.trim()).filter(Boolean).sort()
  return { remote, root: roots[0] ?? null }
}

/**
 * 규칙 디렉터리의 내용을 한 값으로 만든다.
 *
 * 플러그인 버전만으로는 부족하다. C-1의 세 번째 경로(홈 사본)로 규칙이 풀리면 버전과
 * 규칙이 서로 다른 설치에서 온다 — 버전은 맞는데 규칙은 몇 달 전 것인 실행이 실제로
 * 있었다. 검증자 지시(`verifier-prompt.md`)와 결과 계약도 이 디렉터리에 있으므로
 * 프롬프트가 바뀌어도 이 값이 바뀐다. 줄 끝은 LF로 맞춘다 — autocrlf 체크아웃이
 * 같은 규칙을 다른 값으로 만들지 않게.
 */
export function rulesDigest(rulesDir) {
  const names = readdirSync(rulesDir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .sort()
  const lines = names.map(name => {
    const content = readFileSync(join(rulesDir, name), 'utf8').replace(/\r\n/g, '\n')
    return `${name}\0${sha256(content)}\n`
  })
  return `sha256:${sha256(lines.join(''))}`
}

/** `exclude`의 경로를 저장소 루트 기준 상대 경로(`/` 구분)로 바꾼다. 저장소 밖이면 버린다. */
const excludedPrefixes = (top, exclude) => exclude
  .map(path => relative(resolve(top), resolve(path)))
  .filter(rel => rel && !rel.startsWith('..') && !isAbsolute(rel))
  .map(rel => `${rel.split('\\').join('/').replace(/\/+$/, '')}/`)

/**
 * 리뷰 대상의 현재 상태 — HEAD와, HEAD에 대한 작업 트리 변경의 fingerprint.
 *
 * - **index는 보지 않는다.** 리뷰가 읽는 것은 작업 트리다. 스테이징만 하고 되돌린 변경은
 *   아무도 읽지 않으므로 대상을 바꾸지 않는다. 그래서 `git status`가 아니라 작업 트리 대
 *   HEAD(`git diff HEAD`)와 추적하지 않는 파일(`ls-files --others --exclude-standard`)을 본다
 * - 내용은 git이 저장할 때와 같은 blob id로 센다(`hash-object`가 clean 필터를 적용한다).
 *   같은 내용이면 운영체제와 줄 끝 설정이 달라도 같은 값이다
 * - mode를 함께 넣는다. 실행 비트만 바뀐 파일도 다른 대상이다
 * - `exclude`의 디렉터리(리포트 디렉터리)는 뺀다. 기본 저장 위치는 대상 저장소 안이고,
 *   실행이 거기 쓰는 기록 때문에 대상이 바뀐 것으로 보이면 안 된다
 * - 서브모듈은 내용을 열지 않고 diff가 준 commit id로만 센다
 *
 * 변경이 없으면 `clean`, 있으면 `sha256:<hex>`다.
 */
export function currentTarget(repo, { exclude = [] } = {}) {
  const top = git(repo, ['rev-parse', '--show-toplevel']).trim()
  const head = git(top, ['rev-parse', 'HEAD']).trim()
  const skip = excludedPrefixes(top, exclude)
  const keep = path => !skip.some(prefix => path.startsWith(prefix))

  const entries = new Map()
  const toHash = []

  // `--raw -z`: ":<old mode> <new mode> <old id> <new id> <status>" NUL "<path>" NUL
  const raw = git(top, ['diff', 'HEAD', '--raw', '-z', '--no-renames', '--no-abbrev', '--ignore-submodules=none']).split('\0')
  for (let at = 0; at + 1 < raw.length; at += 2) {
    const header = raw[at]
    const path = raw[at + 1]
    if (!header.startsWith(':') || !keep(path)) continue
    const [, newMode, , newId, status] = header.slice(1).split(/\s+/)
    if (status === 'D') {
      entries.set(path, { mode: '-', id: 'deleted' })
    } else if (newMode === '160000') {
      entries.set(path, { mode: newMode, id: /^0+$/.test(newId) ? 'submodule-modified' : newId })
    } else {
      entries.set(path, { mode: newMode, id: null })
      toHash.push(path)
    }
  }

  const untracked = git(top, ['ls-files', '--others', '--exclude-standard', '-z', '--full-name']).split('\0').filter(Boolean)
  for (const path of untracked) {
    if (!keep(path)) continue
    entries.set(path, { mode: 'untracked', id: null })
    toHash.push(path)
  }

  // `--stdin-paths`는 줄 단위라 줄바꿈이 든 경로는 따로 센다.
  const batch = toHash.filter(path => !path.includes('\n'))
  if (batch.length) {
    const ids = git(top, ['hash-object', '--stdin-paths'], `${batch.join('\n')}\n`).split('\n').filter(Boolean)
    if (ids.length !== batch.length) throw new Error(`hash-object가 ${batch.length}개 경로에 ${ids.length}개 id를 냈다`)
    batch.forEach((path, index) => { entries.get(path).id = ids[index] })
  }
  for (const path of toHash.filter(path => path.includes('\n'))) {
    entries.get(path).id = git(top, ['hash-object', '--', path]).trim()
  }

  if (!entries.size) return { head, worktree: 'clean', dirtyFiles: 0 }
  // 코드 포인트 순 정렬 — 지역 설정에 따라 순서가 바뀌면 같은 트리가 다른 값이 된다.
  const lines = [...entries.keys()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map(path => `${entries.get(path).mode}\t${entries.get(path).id}\t${path}\n`)
  return { head, worktree: `sha256:${sha256(lines.join(''))}`, dirtyFiles: entries.size }
}
