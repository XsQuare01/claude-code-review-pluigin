#!/usr/bin/env node
// 리뷰 범위를 가른다(C-5) — 리뷰 대상(`files`)·테스트와 mock(`excluded`)·React 규칙이 다루지 않는 언어(`outside`).
//
// `/code-review-full`은 preflight가 같은 규칙(`scripts/lib/review-scope.mjs`)으로 가른다. 나머지 워크플로우는 이
// 스크립트를 부른다 — 예전에는 오케스트레이터가 C-5의 이름 규칙을 손으로 적용했고, 다른 언어의 파일은 가르지 않았다.
//
// Usage:
//   review-scope.mjs [--repo .] --merge-base <sha>   merge-base부터 HEAD까지(review-base.mjs의 mergeBase)
//   review-scope.mjs [--repo .] --commit <sha>       그 커밋 하나(/code-review-commit) — 매니페스트도 그 커밋의 트리에서 읽는다
//
// 출력(JSON): files · excluded · outside · otherApps · packageRoots · line(리포트의 `실행 계획`에 옮길 한 줄)

import { execFileSync } from 'node:child_process'

import { changedFilesSince } from './lib/review-base.mjs'
import { manifestsAt, scopeLine, scopeOf } from './lib/review-scope.mjs'

const die = message => {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

const VALUE_FLAGS = new Set(['repo', 'merge-base', 'commit'])
const values = new Map()
{
  const argv = process.argv.slice(2)
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at]
    if (!arg.startsWith('--')) die(`unexpected argument ${JSON.stringify(arg)} — 값에 공백이 있으면 따옴표로 감싸라`)
    const name = arg.slice(2)
    if (!VALUE_FLAGS.has(name)) die(`unknown flag ${arg}`)
    if (values.has(name)) die(`--${name}이 두 번 왔다`)
    const value = argv[at + 1]
    if (value === undefined || value.startsWith('--')) die(`${arg} needs a value`)
    values.set(name, value)
    at += 1
  }
}
if (values.has('merge-base') === values.has('commit')) die('--merge-base와 --commit 중 하나를 준다 — 범위 리뷰는 review-base.mjs의 mergeBase, 커밋 리뷰는 그 커밋')

const repo = values.get('repo') ?? process.cwd()
const commit = values.get('commit')

let scope
try {
  const changed = commit === undefined
    ? changedFilesSince(repo, values.get('merge-base'))
    // `--root`: 부모가 없는 첫 커밋도 전부를 바꾼 것으로 낸다. `-z`: 한글·공백 이름을 인용하지 않는다
    : execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', commit], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    }).split('\0').filter(Boolean)
  scope = scopeOf(changed, { manifests: manifestsAt(repo, commit ?? 'HEAD') })
} catch (error) {
  die(`범위를 가르지 못했다: ${String(error.stderr || error.message).trim()}`)
}

process.stdout.write(`${JSON.stringify({ ...scope, line: scopeLine(scope) }, null, 2)}\n`)
