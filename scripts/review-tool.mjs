#!/usr/bin/env node
// lint·typecheck·test 같은 도구를 돌리고, 시작과 끝을 스크립트가 직접 남긴다(C-6·C-9).
//
// 왜 있는가: 도구의 시작·끝을 오케스트레이터가 남기면, 그 시각은 도구가 돈 시각이 아니라 오케스트레이터가
// 깨어난 시각이다. 2026-10-12 실행(OpenCode)은 세 도구의 `tool.start`를 같은 초에, `tool.done`을 6분 뒤 같은
// 초에 남겨 세 도구가 모두 416초로 기록됐다 — 어느 도구가 얼마나 걸렸는지 기록에 없다. 이 스크립트가 돌리기
// 직전과 끝난 직후에 남기므로, 몇 개를 함께 불러도 도구마다 실제 시각이 남는다.
//
// Usage:
//   review-tool.mjs --dir D --run R --name <lint|typecheck|test|…> [--repo .] [--timeout 1800] [--attempt N] -- <명령> [인자…]
//   review-tool.mjs … --shell -- "<셸 명령 문자열 하나>"     (Windows의 npm처럼 셸이 필요한 명령)
//
// 명령은 수정 옵션 없이 준다(C-6, 00-9) — 이 스크립트는 명령을 고치지 않는다. 출력은
// `.timing/<run>.tool.<name>.log`에 남기고, 표준 출력에는 종료 코드·걸린 시간·로그 경로·끝부분 줄을 JSON으로
// 낸다. 실패 수와 baseline 대비는 그 로그로 리포트의 `도구 실행 결과`에 적는다. 도구가 실패해도 이 스크립트는
// 0으로 끝난다 — 실패는 기록할 결과이지 이 스크립트의 실패가 아니다.

import { execFileSync, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { logPhase, requireStartedTimeline } from './lib/run-record.mjs'

const die = message => {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

const argv = process.argv.slice(2)
const separator = argv.indexOf('--')
const flags = separator === -1 ? argv : argv.slice(0, separator)
const command = separator === -1 ? [] : argv.slice(separator + 1)

const VALUE_FLAGS = new Set(['dir', 'run', 'name', 'repo', 'timeout', 'attempt'])
const BOOL_FLAGS = new Set(['shell'])
const values = new Map()
for (let at = 0; at < flags.length; at += 1) {
  const arg = flags[at]
  if (!arg.startsWith('--')) die(`unexpected argument ${JSON.stringify(arg)} — 값에 공백이 있으면 따옴표로 감싸고, 명령은 -- 뒤에 둔다`)
  const name = arg.slice(2)
  if (values.has(name)) die(`--${name}이 두 번 왔다`)
  if (BOOL_FLAGS.has(name)) {
    values.set(name, true)
    continue
  }
  if (!VALUE_FLAGS.has(name)) die(`unknown flag ${arg}`)
  const value = flags[at + 1]
  if (value === undefined || value.startsWith('--')) die(`${arg} needs a value`)
  values.set(name, value)
  at += 1
}

const dir = values.get('dir')
const run = values.get('run')
requireStartedTimeline(dir, run)
const name = values.get('name')
if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) die('--name <도구 이름>이 필요하다(lint·typecheck·test·build처럼 소문자와 -)')
if (!command.length) die('돌릴 명령을 -- 뒤에 준다')
const shell = values.get('shell') === true
if (shell && command.length !== 1) {
  die(`--shell은 셸 명령 문자열 하나를 받는다(받은 인자 ${command.length}개) — 인자 배열을 이어 붙이면 인자 안의 공백이 다시 쪼개진다`)
}
const timeoutSec = Number(values.get('timeout') ?? 1800)
if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) die('--timeout은 양수(초)다')
const attempt = values.has('attempt') ? Number(values.get('attempt')) : 1
if (!Number.isInteger(attempt) || attempt < 1) die('--attempt는 1 이상의 정수다')
const repo = values.get('repo') ?? process.cwd()

// 어느 트리에서 잰 결과인지(C-9 `treeSha`). 재지 못하면 돌리지 않는다 — 출처 없는 수치가 된다.
let treeSha
try {
  treeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
} catch (error) {
  die(`도구를 돌릴 트리를 읽지 못했다(--repo ${repo}): ${String(error.stderr || error.message).trim()}`)
}

const extra = attempt > 1 ? { attempt } : {}
logPhase(dir, run, 'tool.start', { name, ...extra })
const startedAt = Date.now()
const result = shell
  ? spawnSync(command[0], { cwd: repo, shell: true, timeout: timeoutSec * 1000, maxBuffer: 256 * 1024 * 1024 })
  : spawnSync(command[0], command.slice(1), { cwd: repo, timeout: timeoutSec * 1000, maxBuffer: 256 * 1024 * 1024 })
const durationSec = Math.round((Date.now() - startedAt) / 100) / 10
const timedOut = result.error?.code === 'ETIMEDOUT'
const spawnError = result.error && !timedOut ? `${result.error.code ?? ''} ${result.error.message}`.trim() : null
const exit = typeof result.status === 'number' ? result.status : null
logPhase(dir, run, 'tool.done', { name, exit, treeSha, ...extra })

const stdout = result.stdout ?? Buffer.alloc(0)
const stderr = result.stderr ?? Buffer.alloc(0)
const logPath = join(dir, '.timing', `${run}.tool.${name}${attempt > 1 ? `.a${attempt}` : ''}.log`)
const header = [
  shell ? `$ ${command[0]}` : `$ ${JSON.stringify(command)}`,
  `# cwd ${repo} · HEAD ${treeSha}`,
  `# exit ${exit} · signal ${result.signal ?? 'none'} · timedOut ${timedOut} · ${durationSec}s${spawnError ? ` · spawnError ${spawnError}` : ''}`,
  '--- stdout ---',
  '',
].join('\n')
writeFileSync(logPath, Buffer.concat([Buffer.from(header, 'utf8'), stdout, Buffer.from('\n--- stderr ---\n', 'utf8'), stderr]))

const tail = `${stdout.toString('utf8')}\n${stderr.toString('utf8')}`.split(/\r?\n/).filter(line => line.trim() !== '').slice(-30)
process.stdout.write(`${JSON.stringify({
  name, exit, timedOut, signal: result.signal ?? null, ...(spawnError ? { spawnError } : {}), durationSec, treeSha, log: logPath, tail,
}, null, 2)}\n`)
