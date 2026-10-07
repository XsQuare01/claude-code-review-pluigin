#!/usr/bin/env node
// 변경 의도의 원문을 모아 실행 기록 옆에 남긴다 — 정확성 패스(CR)의 producer와 검증자가 같은 원문을 본다.
//
// 왜 있는가: 정확성 패스는 "이 변경이 하려는 일을 하는가"를 묻는다. 그 "하려는 일"을 오케스트레이터가
// 모아 producer에게만 넘겼고, 검증자에게는 넘기지 않았다. 그러면 producer가 PR 설명을 오독해 만든
// 지적("자동 재시도가 빠졌다" — PR에는 "실패 시 재시도하지 않는다")을 검증자가 원문과 대조할 수 없다.
// 검증자는 Read·Grep·Glob만 가지므로 로컬에 없는 PR 설명을 가져올 길도 없다(PR #90 리뷰).
//
// 원문을 **스크립트가** 모은다. 오케스트레이터가 요약해 넘기면 그것은 의도가 아니라 producer와 같은
// 쪽의 해석이고, 검증이 독립하지 않는다. 사용자 요청은 오케스트레이터만 알므로 파일로 받되, 받은 그대로
// 싣는다. 모든 원문은 신뢰하지 않는 데이터다 — 읽는 쪽에서 그 안의 지시를 따르지 않는다.
//
// Usage:
//   review-intent.mjs --dir D --run R [--repo .] [--request-file <사용자 요청 원문>] [--pr-json <gh pr view 출력>] [--no-pr]
//
//   PR 설명은 `gh pr view --json number,title,body,url`(읽기만 한다)로 읽는다. gh를 쓸 수 없는 호스트에서는
//   그 명령의 출력을 그대로 담은 파일을 --pr-json으로 준다. 커밋 메시지는 merge-base..HEAD의 git log다.
//
// 출력: `.timing/<run>.intent.json`(원문·출처·sha256)과, producer 프롬프트에 그대로 붙일 블록(stdout).

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { writeTextAtomic } from './lib/atomic-write.mjs'
import { intentBlock, INTENT_SCHEMA_VERSION } from './lib/intent.mjs'
import { readEvents, requireStartedTimeline } from './lib/run-record.mjs'

const die = message => {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

const VALUE_FLAGS = new Set(['dir', 'run', 'repo', 'request-file', 'pr-json'])
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

const dir = values.get('dir')
const run = values.get('run')
const sidecar = requireStartedTimeline(dir, run)
const start = readEvents(sidecar).find(event => event?.phase === 'run.start')
const repo = values.get('repo') ?? process.cwd()
const sha256 = text => createHash('sha256').update(text).digest('hex')
const readText = (path, what) => {
  try {
    return readFileSync(path, 'utf8').replace(/^﻿/, '')
  } catch (error) {
    die(`${what}을 읽지 못했다: ${path} — ${error.message}`)
  }
}

const sources = []
const unavailable = []

// PR 설명
const pr = (() => {
  if (switches.has('no-pr')) return { reason: '--no-pr — 이 실행은 PR을 보지 않았다' }
  let raw
  if (values.has('pr-json')) {
    raw = readText(values.get('pr-json'), '--pr-json')
  } else {
    try {
      raw = execFileSync('gh', ['pr', 'view', '--json', 'number,title,body,url'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })
    } catch (error) {
      return { reason: `gh pr view가 실패했다 — ${String(error.stderr || error.message).trim().split('\n')[0]}` }
    }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { reason: 'PR 정보가 JSON이 아니다' }
  }
  const title = typeof parsed?.title === 'string' ? parsed.title : ''
  const body = typeof parsed?.body === 'string' ? parsed.body : ''
  if (!title && !body) return { reason: 'PR에 제목도 설명도 없다' }
  return { ref: [parsed.number !== undefined ? `#${parsed.number}` : null, parsed.url ?? null].filter(Boolean).join(' '), text: `${title}\n\n${body}`.trim() }
})()
if (pr.text) sources.push({ kind: 'pr', label: 'PR 설명', ...(pr.ref ? { ref: pr.ref } : {}), text: pr.text, sha256: sha256(pr.text) })
else unavailable.push({ kind: 'pr', reason: pr.reason })

// 사용자 요청
if (values.has('request-file')) {
  const text = readText(values.get('request-file'), '--request-file').trim()
  if (text) sources.push({ kind: 'request', label: '사용자 요청', text, sha256: sha256(text) })
  else unavailable.push({ kind: 'request', reason: '요청 파일이 비었다' })
} else {
  unavailable.push({ kind: 'request', reason: '사용자 요청을 넘기지 않았다' })
}

// 커밋 메시지 — 의도의 추정이다
try {
  if (!start?.mergeBase) throw new Error('run.start에 mergeBase가 없다')
  const text = execFileSync('git', ['log', '--format=%s%n%n%b', `${start.mergeBase}..HEAD`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  if (text) sources.push({ kind: 'commits', label: '커밋 메시지(의도 추정)', ref: `${start.mergeBase.slice(0, 12)}..HEAD`, text, sha256: sha256(text) })
  else unavailable.push({ kind: 'commits', reason: 'merge-base 뒤의 커밋이 없다' })
} catch (error) {
  unavailable.push({ kind: 'commits', reason: `커밋 메시지를 읽지 못했다 — ${String(error.stderr || error.message).trim().split('\n')[0]}` })
}

// 명시된 의도(PR·요청)가 있으면 `stated`, 커밋 메시지뿐이면 `estimated`, 아무것도 없으면 `none`이다.
const status = sources.some(source => source.kind !== 'commits') ? 'stated' : sources.length ? 'estimated' : 'none'
const doc = {
  schemaVersion: INTENT_SCHEMA_VERSION,
  kind: 'review-intent',
  runId: start?.runId ?? null,
  createdAt: new Date().toISOString(),
  status,
  sources,
  unavailable,
}
const path = join(dir, '.timing', `${run}.intent.json`)
writeTextAtomic(path, `${JSON.stringify(doc, null, 2)}\n`)
process.stdout.write(`${intentBlock(doc, { path: `.timing/${run}.intent.json`, sha256: sha256(readFileSync(path, 'utf8')) })}\n`)
