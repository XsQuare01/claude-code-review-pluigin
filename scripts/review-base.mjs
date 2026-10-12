#!/usr/bin/env node
// 리뷰 범위의 기준(base)과 merge-base를 정한다(C-4). preflight를 쓰지 않는 워크플로우(`/code-review`,
// fast, props, math, exception)가 범위를 정할 때 부른다. `/code-review-full`은 preflight가 같은 규칙으로 정한다.
//
// 왜 있는가: 기준을 오케스트레이터가 셸로 정하면 늘 main이었다. 다른 PR 위에 쌓은 PR은 base가 아래 PR의
// 브랜치인데, main을 기준으로 잡으면 아래 PR의 변경까지 리뷰한다. 규칙은 `lib/review-base.mjs`에 있다 —
// 사용자가 정한 범위 → 지금 브랜치의 열린 PR의 base(`origin/<base>` 먼저) → main·master·origin/HEAD.
//
// Usage:
//   review-base.mjs [--repo .] [--base <사용자가 정한 base>] [--pr-json <gh pr view 출력>] [--no-pr]
//
//   PR은 `gh pr view --json number,baseRefName,headRefName,state,url`(읽기만 한다)로 읽는다. gh를 쓸 수 없는
//   호스트에서는 그 명령의 출력을 담은 파일을 --pr-json으로 준다.
//
// 출력(stdout): JSON 하나 — `base`(쓴 ref), `baseSource`(user·pr·default), `mergeBase`, `changedFiles`,
// (PR이면) `pr`·`stacked`, `notes`, `line`(리포트 `리뷰 기준`에 옮길 한 줄). 정하지 못하면 종료 코드 2다.

import { baseLine, changedFilesSince, reviewBaseOf } from './lib/review-base.mjs'

const die = message => {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

const VALUE_FLAGS = new Set(['repo', 'base', 'pr-json'])
const BOOL_FLAGS = new Set(['no-pr'])
const values = new Map()
const switches = new Set()
{
  const argv = process.argv.slice(2)
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at]
    if (!arg.startsWith('--')) die(`unexpected argument ${JSON.stringify(arg)} — 값에 공백이 있으면 따옴표로 감싸라`)
    const name = arg.slice(2)
    if (BOOL_FLAGS.has(name)) {
      switches.add(name)
      continue
    }
    if (!VALUE_FLAGS.has(name)) die(`unknown flag ${arg}`)
    if (values.has(name)) die(`--${name}이 두 번 왔다`)
    const value = argv[at + 1]
    if (value === undefined || value.startsWith('--')) die(`${arg} needs a value`)
    values.set(name, value)
    at += 1
  }
}
if (switches.has('no-pr') && values.has('pr-json')) die('--no-pr와 --pr-json을 함께 줄 수 없다')

const repo = values.get('repo') ?? process.cwd()
const chosen = reviewBaseOf(repo, { requested: values.get('base'), prJson: values.get('pr-json'), noPr: switches.has('no-pr') })
if (chosen.error) die(chosen.error)

let changedFiles
try {
  changedFiles = changedFilesSince(repo, chosen.mergeBase).length
} catch (error) {
  die(`변경 파일 목록을 읽지 못했다: ${String(error.stderr || error.message).trim()}`)
}

process.stdout.write(`${JSON.stringify({
  base: chosen.ref,
  baseSource: chosen.source,
  mergeBase: chosen.mergeBase,
  changedFiles,
  ...(chosen.pr ? { pr: chosen.pr, stacked: chosen.stacked } : {}),
  notes: chosen.notes,
  line: baseLine(chosen),
}, null, 2)}\n`)
