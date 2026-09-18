import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 실행 기록(C-9)에 줄을 남기는 두 가지 일 — 관문 확인과 append.
//
// 두 스크립트가 같은 일을 한다. `prepare-verification.mjs`는 렌더 전 필수 관문이고
// `tally-verdicts.mjs`는 교차검증 결과를 세는 자리인데, 둘 다 "타임라인이 시작됐는지
// 확인하고, 자기가 한 일을 한 줄 남긴다". 각자 복사해 두면 한쪽만 고쳐지고, 기록을
// 남기는 도구에서 그것은 기록의 신뢰를 깎는다.

const TIMELINE = join(dirname(fileURLToPath(import.meta.url)), '..', 'review-timeline.mjs')

const HOW = 'node <RULES_DIR>/../scripts/review-preflight.mjs --dir <리포트 디렉터리> --run <리포트 basename> --rules <RULES_DIR> --workflow <이름>'

/**
 * 타임라인이 시작되지 않았으면 거부한다.
 *
 * C-9는 첫 sub-agent보다 먼저 `run.start`를 남기라고 한다. 그것을 서술형 의무로
 * 두었더니 한 실행이 사이드카를 0줄 남겼다 — 그래서 기록이 **필요한 자리**에서
 * 확인한다. 없으면 진행하지 않는다.
 */
export function requireStartedTimeline(dir, run) {
  if (!dir || !run) {
    process.stderr.write(`--dir와 --run이 필요하다. 실행 타임라인(C-9) 없이 진행하지 않는다.\n먼저: ${HOW}\n`)
    process.exit(2)
  }
  if (/[\/]/.test(run)) {
    process.stderr.write(`--run must be a bare basename, got ${JSON.stringify(run)}\n`)
    process.exit(2)
  }
  const sidecar = join(dir, '.timing', `${run}.jsonl`)
  if (!existsSync(sidecar) || !/"phase":"run\.start"/.test(readFileSync(sidecar, 'utf8'))) {
    process.stderr.write(`실행 타임라인에 run.start가 없다: ${sidecar}\n먼저: ${HOW}\n`)
    process.exit(2)
  }
  return sidecar
}

/**
 * 사이드카에서 그 단계의 **마지막** 줄을 읽는다.
 *
 * 앞의 것을 집으면 다시 적힌 값을 놓친다 — append-only 기록에서 정정은 앞 줄을
 * 고치는 대신 새 줄로 오므로 나중 것이 정본이다. 깨진 줄은 건너뛴다. 없으면
 * `null`이고, 그것은 "그 단계가 없었다"는 뜻이지 0이 아니다.
 */
export function lastPhase(sidecar, phase) {
  if (!existsSync(sidecar)) return null
  let found = null
  for (const line of readFileSync(sidecar, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event?.phase === phase) found = event
  }
  return found
}

/**
 * 한 줄 남긴다. 중첩 값은 `--data`로 넘긴다.
 *
 * `--set`으로 중첩 값을 밀어 넣으면 `counts=total=5,verify=2`가 문자열 하나로 남아
 * 다시 꺼낼 수 없다 — 실제로 그렇게 기록된 실행이 있다. 여기서는 셸을 거치지 않고
 * 인자 배열로 넘기므로 JSON이 깨질 자리가 없다.
 *
 * 기록 실패는 작업 실패가 아니다 (C-9). 경고만 하고 결과는 그대로 낸다.
 */
export function logPhase(dir, run, phase, data) {
  try {
    execFileSync(process.execPath, [
      TIMELINE, '--dir', dir, '--run', run, '--phase', phase,
      '--data', JSON.stringify(data),
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (error) {
    process.stderr.write(`경고: ${phase}를 남기지 못했다 — ${String(error.stderr || error.message).trim()}\n`)
  }
}
