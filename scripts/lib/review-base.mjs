// 리뷰 범위의 기준(base)을 정한다(C-4). preflight와 다른 워크플로우(`review-base.mjs`)가 같은 규칙을 쓴다.
//
// PR의 diff는 "그 PR의 base 위에 이 브랜치가 더한 것"이다. 기준을 늘 main으로 잡으면, 다른 PR 위에 쌓은
// PR(base가 아래 PR의 브랜치)은 아래 PR의 변경까지 리뷰한다 — 이 저장소의 #96(base가 #95의 브랜치)이
// 그랬다. 그래서 지금 브랜치에 열린 PR이 있으면 그 PR의 base를 기준으로 쓴다.
//
// 순서:
// 1. 사용자가 정한 범위(`--base`) — 언제나 먼저다
// 2. 지금 브랜치의 열린 PR의 base. **원격 추적 브랜치(`origin/<base>`)를 먼저 본다** — PR이 비교하는 것은
//    원격의 base이고, 같은 이름의 로컬 브랜치는 뒤처져 있을 수 있다(2026-10-06 실행은 뒤처진 로컬 main을
//    기준으로 잡아, 이미 main에 들어간 다른 PR의 파일 34개까지 리뷰했다). 없으면 같은 이름의 로컬 브랜치다.
//    **둘 다 없으면 멈춘다** — 그 PR의 범위를 모르는데 main으로 물러서면 쌓인 PR을 다시 main 기준으로 리뷰한다
// 3. PR이 없거나 확인할 수 없으면 `main` → `master` → `origin/HEAD`(지금까지의 기본값)

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

export const DEFAULT_BRANCHES = ['main', 'master']

/**
 * 기준을 고른다. 입력은 모두 값이다 — git·gh를 부르는 일은 호출자가 한다.
 *
 * - `requested`: 사용자가 정한 base(없으면 undefined)
 * - `pr`: `{ value: { number, baseRefName, state, url } }` 또는 `{ problem: '왜 PR을 쓰지 못했는지' }`
 * - `refExists(ref)`: 그 ref가 커밋을 가리키면 참
 * - `originHead`: `origin/HEAD`가 가리키는 원격 브랜치(`origin/main` 꼴), 없으면 null
 *
 * 돌려주는 값: `{ ref, source: 'user'|'pr'|'default', pr?, stacked?, notes }` 또는 `{ error, notes }`.
 * `stacked`는 PR의 base가 저장소의 기본 브랜치가 아니라는 뜻이다(다른 PR 위에 쌓인 PR).
 */
export function resolveReviewBase({ requested, pr = null, refExists, originHead = null }) {
  if (typeof requested === 'string' && requested !== '') return { ref: requested, source: 'user', notes: [] }
  const notes = []
  if (pr?.problem) notes.push(pr.problem)
  const value = pr?.value
  if (value) {
    const { number, baseRefName, state, url } = value
    if (typeof baseRefName !== 'string' || baseRefName === '') {
      notes.push(`PR #${number}의 base 이름을 읽지 못했다`)
    } else if (state !== undefined && state !== 'OPEN') {
      notes.push(`PR #${number}은 ${state} 상태라 그 base를 기준으로 쓰지 않는다`)
    } else {
      const ref = [`origin/${baseRefName}`, baseRefName].find(candidate => refExists(candidate))
      if (!ref) {
        return {
          error: `PR #${number}의 base \`${baseRefName}\`를 이 저장소에서 찾을 수 없다 — \`git fetch origin ${baseRefName}\`으로 받은 뒤 다시 돌리거나, 리뷰 범위를 --base로 준다. main으로 물러서지 않는다 — 쌓인 PR이면 아래 PR의 변경까지 리뷰하게 된다`,
          notes,
        }
      }
      const defaultName = typeof originHead === 'string' ? originHead.replace(/^origin\//, '') : null
      const stacked = defaultName ? baseRefName !== defaultName : !DEFAULT_BRANCHES.includes(baseRefName)
      return { ref, source: 'pr', pr: { number, baseRefName, ...(url ? { url } : {}) }, stacked, notes }
    }
  }
  const fallback = DEFAULT_BRANCHES.find(candidate => refExists(candidate)) ?? (originHead && refExists(originHead) ? originHead : null)
  if (!fallback) return { error: 'base를 정할 수 없다 — main·master·origin/HEAD가 없다. 리뷰 범위를 사용자에게 묻고 --base로 준다', notes }
  return { ref: fallback, source: 'default', notes }
}

/** `git`을 그 저장소에서 부른다. 실패하면 null이다. */
const gitIn = repo => args => {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/**
 * 지금 브랜치의 PR을 읽는다. `gh pr view`(읽기만 한다)를 부르거나, gh를 쓸 수 없는 호스트에서는 그 출력을
 * 담은 파일(`prJson`)을 읽는다. `noPr`이면 보지 않는다.
 */
export function readCurrentPr(repo, { prJson, noPr = false } = {}) {
  if (noPr) return { problem: 'PR을 보지 않았다(--no-pr)' }
  let raw
  if (prJson !== undefined) {
    try {
      raw = readFileSync(prJson, 'utf8')
    } catch (error) {
      return { problem: `--pr-json을 읽지 못했다: ${prJson} — ${error.message}` }
    }
  } else {
    try {
      raw = execFileSync('gh', ['pr', 'view', '--json', 'number,baseRefName,headRefName,state,url'], {
        cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
      })
    } catch (error) {
      const first = String(error.stderr || error.message).trim().split('\n')[0]
      return { problem: /no pull requests? found/i.test(first) ? '이 브랜치에 PR이 없다' : `gh pr view가 실패했다 — ${first}` }
    }
  }
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { problem: 'PR 정보가 객체가 아니다' }
    return { value }
  } catch (error) {
    return { problem: `PR 정보가 JSON이 아니다 — ${error.message}` }
  }
}

/**
 * 저장소에서 기준을 정하고 merge-base까지 잰다. preflight와 `review-base.mjs`가 같은 값을 낸다.
 * 돌려주는 값은 `resolveReviewBase`의 것에 `mergeBase`를 더한 것이다(못 재면 `error`).
 */
export function reviewBaseOf(repo, { requested, prJson, noPr = false } = {}) {
  const git = gitIn(repo)
  const refExists = ref => git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null
  const originHead = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  // 사용자가 범위를 정했으면 PR을 읽지 않는다 — 쓰지 않을 값을 위해 gh를 부르지 않는다.
  const pr = typeof requested === 'string' && requested !== '' ? null : readCurrentPr(repo, { prJson, noPr })
  const chosen = resolveReviewBase({ requested, pr, refExists, originHead })
  if (chosen.error) return chosen
  const mergeBase = git(['merge-base', chosen.ref, 'HEAD'])
  if (!mergeBase) return { ...chosen, error: `base ${JSON.stringify(chosen.ref)}를 HEAD와 맞춰볼 수 없다 — 존재하는 ref를 --base로 넘겨라` }
  return { ...chosen, mergeBase }
}

/** 사람이 읽는 한 줄. preflight와 `review-base.mjs`가 같은 문장을 쓴다. */
export function baseLine(chosen) {
  if (chosen.source === 'user') return `${chosen.ref} (사용자가 정한 범위)`
  if (chosen.source === 'pr') {
    return chosen.stacked
      ? `${chosen.ref} (PR #${chosen.pr.number}의 base — 기본 브랜치가 아니라 \`${chosen.pr.baseRefName}\` 위에 쌓인 PR이다. 그 위에 더한 변경만 리뷰한다)`
      : `${chosen.ref} (PR #${chosen.pr.number}의 base)`
  }
  return `${chosen.ref} (기본값${chosen.notes.length ? ` — ${chosen.notes.join(' · ')}` : ''})`
}
