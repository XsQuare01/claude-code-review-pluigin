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
// 명령은 수정 옵션 없이 준다(C-6, 00-9) — 이 스크립트는 명령을 고치지 않는다. 출력은 호출마다
// `.timing/<run>.tool.<name>.<callId>.log`에 남기고, 표준 출력에는 callId·종료 코드·걸린 시간·로그 경로·끝부분
// 줄을 JSON으로 낸다. baseline은 그 트리를 `--repo`로 주고 같은 `--name`으로 돌린다 — 로그가 따로 남고
// `treeSha`로 갈린다. 실패 수와 baseline 대비는 그 로그로 리포트의 `도구 실행 결과`에 적는다. 시간 상한을
// 넘기면 도구가 띄운 프로세스까지 끊는다. 도구가 실패해도 이 스크립트는 0으로 끝난다 — 실패는 기록할
// 결과이지 이 스크립트의 실패가 아니다.
//
//   review-tool.mjs … --detach -- <명령>          띄우고 바로 돌아온다. 끝(`tool.done`)은 띄운 프로세스가 남긴다
//   review-tool.mjs --dir D --run R --wait [--timeout 3600]   이 실행에서 띄운 도구가 모두 끝나기를 기다린다
//
// 왜 `--detach`인가: 한 차례에 띄운 호출이 전부 끝나야 다음 차례로 넘어가는 호스트(OpenCode)에서 도구를 모듈
// 리뷰와 같은 차례에 돌리면, 모듈이 끝나도 가장 긴 도구가 끝날 때까지 다음 모듈을 띄우지 못한다. 2026-10-13의
// 두 실행에서 `npm test`가 그렇게 4분과 6.5분을 막았다. 띄워 두고 돌아오면 그 차례는 모듈만 기다린다.
//
// 결과는 호출마다 `.timing/<run>.tool.<name>.<callId>.json`에도 남는다 — `--wait`가 거기서 모은다.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, openSync, writeFileSync } from 'node:fs'
import { constants } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeTextAtomic } from './lib/atomic-write.mjs'
import { readJsonFile } from './lib/read-text.mjs'
import { logPhase, readEvents, requireStartedTimeline } from './lib/run-record.mjs'

const die = message => {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

const argv = process.argv.slice(2)
const separator = argv.indexOf('--')
const flags = separator === -1 ? argv : argv.slice(0, separator)
const command = separator === -1 ? [] : argv.slice(separator + 1)

// `call-id`는 `--detach`가 띄운 프로세스에 넘기는 값이다 — 부모가 이미 잡아 둔 로그와 `tool.start`를 이어 쓴다.
const VALUE_FLAGS = new Set(['dir', 'run', 'name', 'repo', 'timeout', 'attempt', 'call-id'])
const BOOL_FLAGS = new Set(['shell', 'detach', 'wait'])
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
const sidecar = requireStartedTimeline(dir, run)

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const resultPathOf = (tool, id) => join(dir, '.timing', `${run}.tool.${tool}.${id}.json`)
const alive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM' // 있지만 신호를 보낼 권한이 없다
  }
}

/**
 * 이 실행에서 시작한 도구가 모두 끝나기를 기다린다. 끝은 기록의 `tool.done`(같은 `callId`)이다.
 *
 * 끝을 남기지 못하고 사라진 도구는 기다리지 않는다 — 결과 파일의 `pid`가 살아 있지 않거나, 시작한 지 30초가
 * 지나도록 결과 파일이 생기지 않았으면 `lost`다. 그 도구는 다시 돌린다.
 */
function waitForTools(limitSec) {
  const STARTUP_GRACE_MS = 30000
  const deadline = Date.now() + limitSec * 1000
  for (;;) {
    const events = readEvents(sidecar)
    const ended = new Set(events.filter(event => event?.phase === 'tool.done' && typeof event.callId === 'string').map(event => event.callId))
    const done = []
    const running = []
    const lost = []
    for (const start of events.filter(event => event?.phase === 'tool.start' && typeof event.callId === 'string' && typeof event.name === 'string')) {
      const call = { name: start.name, callId: start.callId }
      let result = null
      try {
        result = readJsonFile(resultPathOf(start.name, start.callId))
      } catch {
        // 아직 없거나 쓰는 중이다
      }
      if (ended.has(start.callId)) {
        done.push(result?.status === 'done' ? result.output : { ...call, note: '결과 파일이 없다 — 로그를 본다' })
      } else if (result?.status === 'running' && Number.isInteger(result.pid)) {
        if (alive(result.pid)) running.push(call)
        else lost.push({ ...call, reason: `프로세스(pid ${result.pid})가 끝을 남기지 못하고 사라졌다` })
      } else if (Date.now() - Date.parse(start.at) < STARTUP_GRACE_MS) {
        running.push(call)
      } else {
        lost.push({ ...call, reason: '시작은 기록됐지만 도는 흔적(결과 파일)이 없다' })
      }
    }
    if (!running.length || Date.now() > deadline) return { done, running, lost, timedOut: running.length > 0 }
    sleep(1000)
  }
}

// 띄워 둔 도구를 기다린다. 리포트의 `도구 실행 결과`를 쓰기 전에 부른다.
if (values.get('wait') === true) {
  if (command.length || values.has('name') || values.has('detach')) die('--wait는 --dir·--run(·--timeout)만 받는다 — 이 실행에서 시작한 도구가 모두 끝나기를 기다린다')
  const limitSec = Number(values.get('timeout') ?? 3600)
  if (!Number.isFinite(limitSec) || limitSec <= 0) die('--timeout은 양수(초)다')
  const outcome = waitForTools(limitSec)
  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`)
  if (outcome.lost.length) process.stderr.write(`끝을 남기지 못한 도구가 있다: ${outcome.lost.map(call => `${call.name}(${call.callId})`).join(', ')} — 그 도구는 --detach 없이 다시 돌린다\n`)
  if (outcome.timedOut) process.stderr.write(`${limitSec}초 안에 끝나지 않은 도구가 있다: ${outcome.running.map(call => `${call.name}(${call.callId})`).join(', ')}\n`)
  process.exit(outcome.lost.length || outcome.timedOut ? 1 : 0)
}

const name = values.get('name')
if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) die('--name <도구 이름>이 필요하다(lint·typecheck·test·build처럼 소문자와 -)')
if (!command.length) die('돌릴 명령을 -- 뒤에 준다')
const shell = values.get('shell') === true
if (shell && command.length !== 1) {
  die(`--shell은 셸 명령 문자열 하나를 받는다(받은 인자 ${command.length}개) — 인자 배열을 이어 붙이면 인자 안의 공백이 다시 쪼개진다`)
}
const timeoutSec = Number(values.get('timeout') ?? 1800)
if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) die('--timeout은 양수(초)다')
// 타이머의 상한(2^31-1ms)을 넘기면 Node는 1ms로 바꿔 버린다 — 도구가 시작하자마자 끊긴다.
if (timeoutSec * 1000 > 2 ** 31 - 1) die('--timeout은 2147483초(약 24일)보다 짧아야 한다')
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

// 시간 상한을 넘기면 **도구가 띄운 프로세스까지** 끊는다. 직접 띄운 프로세스만 끊으면(`spawnSync`의 timeout이
// 그렇다) `npm test`의 셸이나 러너만 죽고 그 아래 실제 도구는 계속 돈다 — Windows에서 `--shell --timeout 1`로
// 띄운 도구가 4초 뒤에도 파일을 만들었다. 끊었다고 기록한 도구가 다음 시도와 겹쳐 돌면 두 시도의 출력과
// 자원이 섞인다.
// - Windows: `taskkill /T /F`로 그 프로세스와 그 아래를 함께 끊는다
// - 그 밖: 도구를 제 프로세스 그룹으로 띄우고 그룹 전체에 신호를 보낸다(SIGTERM, 그래도 남으면 SIGKILL).
//   그룹을 따로 두면 호스트가 이 스크립트의 그룹에 보낸 종료 신호가 도구에 닿지 않으므로, 이 스크립트가 받은
//   종료 신호를 도구의 그룹에 넘긴다. 그때는 `tool.done`을 남기지 않는다 — 시작만 남은 도구가 "돌렸고 끝내지
//   못했다"는 기록이다(C-9)
// 신호를 무시한 프로세스가 출력 파이프를 붙잡고 있으면 끝(close)이 오지 않는다 — 기다림에도 상한을 둔다.
const WINDOWS = process.platform === 'win32'
const KILL_GRACE_MS = 5000
const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP']

const runTool = () => new Promise(resolve => {
  const options = { cwd: repo, windowsHide: true, detached: !WINDOWS, stdio: ['ignore', 'pipe', 'pipe'] }
  const child = shell ? spawn(command[0], { ...options, shell: true }) : spawn(command[0], command.slice(1), options)
  const stdout = []
  const stderr = []
  child.stdout.on('data', chunk => stdout.push(chunk))
  child.stderr.on('data', chunk => stderr.push(chunk))
  let timedOut = false
  let spawnError = null
  let settled = false
  const timers = []
  const later = (fn, ms) => timers.push(setTimeout(fn, ms))
  const killTree = signal => {
    if (child.pid === undefined) return
    if (WINDOWS) {
      // 이미 끝난 pid에는 다시 보내지 않는다 — 그 번호를 다른 프로세스가 받았을 수 있다.
      if (child.exitCode === null && child.signalCode === null) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      }
      return
    }
    try {
      process.kill(-child.pid, signal)
    } catch {
      // 그룹이 이미 비었다
    }
  }
  const onSignal = signal => {
    killTree(signal)
    process.exit(128 + (constants.signals[signal] ?? 0))
  }
  const finish = (code, signal) => {
    if (settled) return
    settled = true
    timers.forEach(clearTimeout)
    for (const signal of FORWARDED) process.off(signal, onSignal)
    resolve({ code, signal, timedOut, spawnError, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
  }
  for (const signal of FORWARDED) process.on(signal, onSignal)
  child.on('error', error => {
    spawnError = `${error.code ?? ''} ${error.message}`.trim()
    if (child.pid === undefined) finish(null, null) // 띄우지도 못했다
  })
  child.on('close', (code, signal) => finish(code, signal))
  later(() => {
    timedOut = true
    killTree('SIGTERM')
    later(() => {
      killTree('SIGKILL')
      later(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        child.unref()
        finish(child.exitCode, child.signalCode)
      }, KILL_GRACE_MS)
    }, KILL_GRACE_MS)
  }, timeoutSec * 1000)
})

// 로그는 **호출마다** 따로 둔다. 도구 이름과 시도 번호로만 지었더니 baseline 트리와 현재 트리에서 같은 `lint`를
// 돌린 두 호출이 같은 파일을 써, 나중 호출이 baseline 로그를 지웠다 — C-6의 "기존 실패 대비 신규 실패"를 다시 볼
// 근거가 없어진다. 돌리기 전에 파일을 배타적으로 만들어 이름을 잡아 두므로 함께 돈 호출끼리도 겹치지 않는다.
// 그 이름의 `callId`를 `tool.start`·`tool.done`에도 적어, 기록의 한 쌍과 로그 하나가 이어진다.
const childCall = values.get('call-id')
if (childCall !== undefined && !/^[0-9a-f]{8}$/.test(childCall)) die('--call-id는 --detach가 넘기는 값이다')
const { callId, logPath } = (() => {
  if (childCall !== undefined) {
    const path = join(dir, '.timing', `${run}.tool.${name}.${childCall}.log`)
    if (!existsSync(path)) die(`--call-id ${childCall}의 로그 자리가 없다(${path}) — --detach가 잡아 둔 자리에서만 이어 쓴다`)
    return { callId: childCall, logPath: path }
  }
  for (;;) {
    const id = randomBytes(4).toString('hex')
    const path = join(dir, '.timing', `${run}.tool.${name}.${id}.log`)
    try {
      closeSync(openSync(path, 'wx'))
      return { callId: id, logPath: path }
    } catch (error) {
      if (error.code !== 'EEXIST') die(`도구 로그를 만들지 못했다(${path}): ${error.message}`)
    }
  }
})()

const extra = attempt > 1 ? { attempt } : {}
const resultPath = resultPathOf(name, callId)

// 띄우고 돌아온다. `tool.start`는 띄우기 전에 여기서 남긴다 — 띄운 프로세스가 아주 빨리 끝나도 끝이 시작보다
// 앞에 오지 않는다. 끝(`tool.done`)과 로그·결과 파일은 띄운 프로세스가 남긴다.
if (values.get('detach') === true) {
  if (childCall !== undefined) die('--detach와 --call-id는 함께 쓰지 않는다')
  logPhase(dir, run, 'tool.start', { name, callId, detached: true, ...extra })
  const forwarded = flags.filter(arg => arg !== '--detach')
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...forwarded, '--call-id', callId, '--', ...command], {
    cwd: process.cwd(), detached: true, stdio: 'ignore', windowsHide: true,
  })
  if (child.pid === undefined) {
    logPhase(dir, run, 'tool.done', { name, exit: null, treeSha, callId, ...extra })
    die(`${name}을 띄우지 못했다`)
  }
  child.unref()
  process.stdout.write(`${JSON.stringify({ name, callId, detached: true, pid: child.pid, log: logPath, result: resultPath }, null, 2)}\n`)
  process.exit(0)
}

if (childCall === undefined) logPhase(dir, run, 'tool.start', { name, callId, ...extra })
// 도는 동안의 결과 파일 — `--wait`가 이 pid로 살아 있는지 본다.
writeTextAtomic(resultPath, `${JSON.stringify({ status: 'running', name, callId, pid: process.pid })}\n`)
const startedAt = Date.now()
const result = await runTool()
const durationSec = Math.round((Date.now() - startedAt) / 100) / 10
const { timedOut, spawnError } = result
// 끊은 도구에는 제 종료 코드가 없다 — Windows에서 끊긴 프로세스가 내는 1은 taskkill의 것이다.
const exit = !timedOut && typeof result.code === 'number' ? result.code : null
logPhase(dir, run, 'tool.done', { name, exit, treeSha, callId, ...extra })

const { stdout, stderr } = result

const header = [
  shell ? `$ ${command[0]}` : `$ ${JSON.stringify(command)}`,
  `# cwd ${repo} · HEAD ${treeSha}`,
  `# exit ${exit} · signal ${result.signal ?? 'none'} · timedOut ${timedOut} · ${durationSec}s${spawnError ? ` · spawnError ${spawnError}` : ''}`,
  '--- stdout ---',
  '',
].join('\n')
writeFileSync(logPath, Buffer.concat([Buffer.from(header, 'utf8'), stdout, Buffer.from('\n--- stderr ---\n', 'utf8'), stderr]))

const tail = `${stdout.toString('utf8')}\n${stderr.toString('utf8')}`.split(/\r?\n/).filter(line => line.trim() !== '').slice(-30)
const output = {
  name, callId, exit, timedOut, signal: result.signal ?? null, ...(spawnError ? { spawnError } : {}), durationSec, treeSha, log: logPath, tail,
}
writeTextAtomic(resultPath, `${JSON.stringify({ status: 'done', output })}\n`)
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
