// 작업 대장 — 띄운 작업의 상태를 실행 기록에서 접어 내고, 다음에 무엇을 띄울지 정한다(C-12).
//
// 왜 있는가: 이 플러그인은 작업을 띄우는 쪽을 갖고 있지 않다. 띄우는 것은 오케스트레이터
// 모델이고, 무엇이 돌고 있는지는 그 모델의 기억에만 있었다. 2026-09-30의 한 실행은 검증자
// 하나가 끝나지 않아 17건에 37시간을 멈췄고, 무엇이 남았는지는 압축 요약에만 있었다.
// 띄우는 손은 가질 수 없지만, **무엇을 띄울지 정하는 자리**와 **결과를 받는 자리**는 스크립트가
// 가질 수 있다 — preflight가 시작 기록을 모델이 출력을 필요로 하는 자리로 옮긴 것과 같은 방법이다.
//
// 상태를 따로 저장하지 않는다. 실행 타임라인(C-9)의 줄을 접어 낸다. 같은 사실을 두 파일에 두면
// 둘이 어긋날 때 어느 쪽이 정본인지가 다시 문제가 되고, 타임라인에는 이미 `module.start`·
// `module.done`이 시도마다 남는다. 그래서 프로세스가 다시 떠도, 컨텍스트가 압축돼도, 같은 기록을
// 접으면 같은 상태가 나온다.
//
// 이 파일은 계산만 한다. 시계(`now`)를 인자로 받고 아무것도 쓰지 않는다 — 쓰는 일은
// `review-tasks.mjs`가 잠금 안에서 한다. 그래서 시각과 호스트를 가짜로 바꿔 전이를 검사할 수 있다.

export const STAGES = ['module', 'verify']

/**
 * 작업 하나의 상태.
 *
 * `queued`는 띄울 차례를 기다린다(재시도를 기다리는 것도 여기다). `running`은 띄웠고 끝을 받지
 * 않았다. 나머지 넷은 끝이다 — `succeeded`는 결과를 받았고, `failed`는 결과가 왔지만 쓸 수 없고,
 * `unavailable`은 호스트에서 결과를 얻지 못했고, `cancelled`는 한도나 사용자가 멈췄다.
 */
export const TASK_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'unavailable']
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'unavailable'])

/** 처음 한 번에 재시도 한 번. SKILL의 "fresh retry 최대 1회"·"교정 재시도 1회"와 같다. */
export const MAX_ATTEMPTS = 2
export const DEFAULT_INFLIGHT = 4
/** 끝을 받지 못한 채 이만큼 지나면 죽은 작업으로 본다. 모듈 하나가 평균 4~5분 걸린 실측의 네 배쯤이다. */
export const DEFAULT_STALE_AFTER_SEC = 1200

export const HALT_REASONS = ['max-duration', 'max-tasks', 'user']
export const CANCEL_REASONS = ['max-duration', 'user']

// 호스트에서 결과를 얻지 못한 실패다. 결과가 왔지만 계약을 어긴 것(`malformed-output`)과 가른다 —
// 앞의 것은 런타임이나 동시 실행이 원인이고, 뒤의 것은 응답이 원인이다.
const UNAVAILABLE = new Set([
  'no-start', 'task-not-found', 'inactivity-timeout', 'queue-expiry', 'empty-result',
  'skill-injection-invalid', 'provider-model-not-found', 'poll-timeout',
])

/** 실패 클래스가 끝 상태로 무엇이 되는가. */
export function failureFamily(failureClass) {
  if (failureClass === 'cancelled') return 'cancelled'
  if (UNAVAILABLE.has(failureClass)) return 'unavailable'
  return 'failed'
}

/**
 * `90`, `90s`, `30m`, `2h`를 초로 읽는다. 읽지 못하면 null이다.
 *
 * 0과 음수는 받지 않는다 — "상한 0"은 아무것도 띄우지 말라는 뜻인데, 그것은 실행을 시작하지
 * 않는 것으로 하는 편이 낫다.
 */
export function parseDuration(text) {
  const match = /^(\d+)(s|m|h)?$/.exec(String(text ?? '').trim())
  if (!match) return null
  const value = Number(match[1]) * { s: 1, m: 60, h: 3600 }[match[2] ?? 's']
  return value > 0 ? value : null
}

const attemptNumber = value => {
  if (value === undefined || value === null || value === '') return 0
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : null
}

const taskKey = (stage, task) => `${stage}:${task}`

const PHASE_STAGE = new Map([
  ['module.start', ['module', 'start']],
  ['module.done', ['module', 'done']],
  ['verify.start', ['verify', 'start']],
  ['verify.done', ['verify', 'done']],
  ['task.bind', [null, 'bind']],
])

/** 이 실행의 마지막 `crossverify.start` 위치. 검증 단계는 그 뒤의 기록만 본다 — 검증을 처음부터 다시 하면 앞 라운드는 끝난 일이다. */
export function verifyRoundStart(events) {
  let at = -1
  events.forEach((event, index) => {
    if (event?.phase === 'crossverify.start') at = index
  })
  return at
}

/**
 * 기록을 시도 단위로 접는다.
 *
 * 한 시도 안에서는 **나중 줄이 정본**이다 — append 전용 기록에서 정정은 같은 시도의 줄을 하나 더
 * 남기는 것이다(C-9). 시도를 넘어서는 번호가 큰 시도가 정본이다(`moduleOutcomes`와 같은 규칙).
 * 같은 시도가 두 번 시작되거나 끝난 것은 세어 둔다 — 그것이 대장이 막으려는 중복이다.
 */
export function foldAttempts(events) {
  const verifySince = verifyRoundStart(events)
  const tasks = new Map()
  const hosts = new Map()
  const ensure = (stage, task, attempt) => {
    const key = taskKey(stage, task)
    if (!tasks.has(key)) tasks.set(key, new Map())
    const attempts = tasks.get(key)
    if (!attempts.has(attempt)) {
      attempts.set(attempt, {
        stage, task, attempt, startedAt: null, claim: null, kind: null,
        hostTaskId: null, lastSeenAt: null, settled: null, starts: 0, settles: 0,
      })
    }
    return attempts.get(attempt)
  }
  events.forEach((event, index) => {
    const spec = PHASE_STAGE.get(event?.phase)
    if (!spec) return
    const [fixedStage, what] = spec
    const stage = fixedStage ?? event.stage
    if (!STAGES.includes(stage)) return
    if (stage === 'verify' && index < verifySince) return
    const task = stage === 'module' && what !== 'bind' ? event.module : event.task
    if (task === undefined || task === null || task === '') return
    const attempt = attemptNumber(event.attempt)
    if (attempt === null) return
    const record = ensure(stage, String(task), attempt)
    const at = Date.parse(event.at)
    if (what === 'start') {
      record.starts += 1
      if (record.startedAt === null) {
        record.startedAt = at
        record.lastSeenAt = at
        record.claim = event.claim ?? null
        record.kind = event.kind ?? null
      }
      return
    }
    if (what === 'bind') {
      if (event.taskId !== undefined && event.taskId !== null) {
        record.hostTaskId = String(event.taskId)
        hosts.set(record.hostTaskId, record)
      }
      if (Number.isFinite(at)) record.lastSeenAt = Math.max(record.lastSeenAt ?? at, at)
      return
    }
    record.settles += 1
    record.settled = {
      status: event.status,
      at,
      ...(event.failureClass !== undefined ? { failureClass: event.failureClass } : {}),
      ...(event.cancelReason !== undefined ? { cancelReason: event.cancelReason } : {}),
      ...(event.resultSha256 !== undefined ? { resultSha256: event.resultSha256 } : {}),
    }
    if (event.taskId !== undefined && event.taskId !== null && record.hostTaskId === null) {
      record.hostTaskId = String(event.taskId)
      hosts.set(record.hostTaskId, record)
    }
  })
  return { tasks, hosts }
}

/** 작업 하나의 시도들 — 번호 순. */
export function attemptsOf(fold, stage, task) {
  return [...(fold.tasks.get(taskKey(stage, task))?.values() ?? [])].sort((left, right) => left.attempt - right.attempt)
}

/**
 * 지금 적용되는 한도 구간. `run.start`가 첫 구간을 열고, `run.resume`이 새 구간을 연다.
 *
 * 시간 상한은 구간이 열린 때부터 잰다. 한도에 닿아 멈춘 실행을 다음 날 이어 갈 때 `run.start`부터
 * 재면 이어 가자마자 상한이 지나 있다. 호출 수도 구간 안에서 센다.
 */
export function segmentOf(events) {
  let index = events.findIndex(event => event?.phase === 'run.start')
  if (index === -1) return null
  let source = events[index]
  events.forEach((event, at) => {
    if (at > index && event?.phase === 'run.resume') {
      index = at
      source = event
    }
  })
  const positive = value => (Number.isInteger(value) && value > 0 ? value : null)
  return {
    index,
    startedAt: Date.parse(source.at),
    maxTasks: positive(source.maxTasks),
    maxDurationSec: positive(source.maxDurationSec),
    staleAfterSec: positive(source.staleAfterSec) ?? DEFAULT_STALE_AFTER_SEC,
  }
}

/**
 * 남은 호출 수와 시간.
 *
 * 호출은 **띄운 시도의 수**다 — 재시도·교정·승격도 하나씩이다. 띄운 뒤 결과를 못 받았어도
 * 호출은 이미 썼다.
 */
export function budgetOf(events, now) {
  const segment = segmentOf(events)
  if (!segment) return null
  const used = events.slice(segment.index).filter(event => event?.phase === 'module.start' || event?.phase === 'verify.start').length
  const deadline = segment.maxDurationSec === null ? null : segment.startedAt + segment.maxDurationSec * 1000
  return {
    maxTasks: segment.maxTasks,
    used,
    remaining: segment.maxTasks === null ? null : Math.max(0, segment.maxTasks - used),
    maxDurationSec: segment.maxDurationSec,
    deadline: deadline === null ? null : new Date(deadline).toISOString(),
    remainingSec: deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000)),
    expired: deadline !== null && now >= deadline,
    exhausted: segment.maxTasks !== null && used >= segment.maxTasks,
    staleAfterSec: segment.staleAfterSec,
  }
}

/** 이 구간에서 디스패치를 멈춘 기록. 없으면 null이다. */
export function haltOf(events) {
  const segment = segmentOf(events)
  if (!segment) return null
  const halts = events.slice(segment.index).filter(event => event?.phase === 'dispatch.halt')
  return halts.length ? halts[0] : null
}

/**
 * 작업 하나의 상태를 정한다.
 *
 * 마지막 시도가 실패했고 시도가 남았으면 다시 `queued`다 — 재시도는 같은 작업의 새 시도다.
 *
 * 취소된 작업은 **그 구간에서는** 다시 띄우지 않는다 — 한도나 사용자가 멈춘 것을 재시도로 되살리면
 * 한도가 무의미하다. 그러나 앞 구간에서 취소된 작업은 새 구간(`run.resume`)에서 다시 차례가 온다.
 * 그것을 끝으로 두면 "나중에 이어서"가 취소된 범위를 영영 검토하지 않는다. 같은 이유로 취소된
 * 시도는 재시도 횟수(`spent`)에 세지 않는다 — 작업이 스스로 실패한 것이 아니다.
 * `segmentStartedAt`은 지금 구간이 열린 시각(ms)이다.
 */
export function taskState(attempts, { now, staleAfterSec = DEFAULT_STALE_AFTER_SEC, segmentStartedAt = -Infinity } = {}) {
  if (!attempts.length) return { state: 'queued', attempts: 0, spent: 0, nextAttempt: 1 }
  const last = attempts.at(-1)
  const spent = attempts.filter(one => one.settled?.failureClass !== 'cancelled').length
  const base = { attempts: attempts.length, spent, attempt: last.attempt, ...(last.hostTaskId !== null ? { hostTaskId: last.hostTaskId } : {}) }
  if (!last.settled) {
    const seen = last.lastSeenAt ?? last.startedAt
    const quietSec = seen === null || !Number.isFinite(seen) ? null : Math.max(0, Math.round((now - seen) / 1000))
    return {
      ...base,
      state: 'running',
      startedAt: last.startedAt === null ? null : new Date(last.startedAt).toISOString(),
      quietSec,
      stale: quietSec !== null && quietSec > staleAfterSec,
    }
  }
  const { status, failureClass } = last.settled
  if (status === 'ok') return { ...base, state: 'succeeded' }
  // ok도 failed도 아닌 status는 성공인지 알 수 없다. 재시도로 덮지 않고 끝으로 둔다 — 기록을 바로잡을 일이다.
  if (status !== 'failed') return { ...base, state: 'failed', failureClass: 'status-outside-list' }
  const family = failureFamily(failureClass)
  const settled = { ...(failureClass !== undefined ? { failureClass } : {}), ...(last.settled.cancelReason !== undefined ? { cancelReason: last.settled.cancelReason } : {}) }
  if (family === 'cancelled') {
    if (last.settled.at < segmentStartedAt && spent < MAX_ATTEMPTS) {
      return { ...base, state: 'queued', nextAttempt: last.attempt + 1, retryOf: { attempt: last.attempt, failureClass: 'cancelled' } }
    }
    return { ...base, ...settled, state: 'cancelled' }
  }
  if (spent < MAX_ATTEMPTS) {
    return { ...base, state: 'queued', nextAttempt: last.attempt + 1, retryOf: { attempt: last.attempt, ...(failureClass !== undefined ? { failureClass } : {}) } }
  }
  return { ...base, ...settled, state: family }
}

/**
 * 계획의 작업마다 상태. 계획 순서를 지킨다.
 *
 * `preexisting`은 대장을 거치지 않고 이미 결과가 있는 작업이다(대장이 생기기 전의 절차로 받은 판정
 * 파일). 그 결과를 버리고 다시 띄우지 않는다 — 시도 기록이 없을 때만 그렇게 본다.
 */
export function planStates({ stage, plan, fold, now, staleAfterSec, segmentStartedAt }) {
  return plan.map(entry => {
    const attempts = attemptsOf(fold, stage, entry.task)
    if (!attempts.length && entry.preexisting) return { ...entry, state: 'succeeded', attempts: 0, spent: 0 }
    return { ...entry, ...taskState(attempts, { now, staleAfterSec, segmentStartedAt }) }
  })
}

export const isTerminal = state => TERMINAL.has(state)

/**
 * 다음에 할 일을 정한다. 아무것도 쓰지 않는다 — 결정만 낸다.
 *
 * 순서가 의미를 갖는다.
 * 1. **시간 상한이 지났으면** 돌고 있는 시도를 모두 취소 대상으로 내고, 새로 띄우지 않는다.
 * 2. 그렇지 않으면 끝을 받지 못한 채 `staleAfterSec`를 넘긴 시도를 **죽은 것으로 끝낸다**
 *    (`inactivity-timeout`). 그 시도의 결과가 나중에 와도 받지 않고, 시도가 남았으면 새 시도를 띄운다.
 *    2026-09-30의 37시간은 끝나지 않는 작업 하나를 아무도 끝내지 않아서 생겼다.
 * 3. 빈 슬롯만큼 `queued`를 계획 순서대로 띄운다. 돌고 있는 작업은 다시 띄우지 않는다 — 그것이
 *    사용자 메시지·중복 알림·재시작에도 같은 시도가 두 번 뜨지 않는 이유다.
 * 4. 호출 상한에 닿으면 거기서 멈춘다.
 *
 * `halt`는 이번 결정이 디스패치를 멈췄을 때만 이유를 담는다. 이미 멈춘 기록(`halted`)이 있으면
 * 다시 띄우지 않는다.
 */
export function decideNext({ stage, plan, fold, events, now, inflight = DEFAULT_INFLIGHT }) {
  const budget = budgetOf(events, now)
  if (!budget) throw new Error('타임라인에 run.start가 없다 — 대장은 시작된 실행에서만 쓴다')
  const halted = haltOf(events)
  const states = planStates({ stage, plan, fold, now, staleAfterSec: budget.staleAfterSec, segmentStartedAt: segmentOf(events).startedAt })
  const running = states.filter(entry => entry.state === 'running')

  const cancel = []
  const expire = []
  if (budget.expired) {
    for (const entry of running) cancel.push({ task: entry.task, attempt: entry.attempt, ...(entry.hostTaskId ? { hostTaskId: entry.hostTaskId } : {}) })
  } else {
    for (const entry of running.filter(one => one.stale)) {
      expire.push({ task: entry.task, attempt: entry.attempt, quietSec: entry.quietSec, ...(entry.hostTaskId ? { hostTaskId: entry.hostTaskId } : {}) })
    }
  }

  // 끝낸 시도를 반영한 상태로 다시 본다. 죽은 시도가 남긴 자리는 빈 슬롯이고, 시도가 남은 작업은
  // 재시도 차례가 된다.
  const after = states.map(entry => {
    if (cancel.some(one => one.task === entry.task)) return { ...entry, state: 'cancelled', cancelReason: 'max-duration' }
    if (!expire.some(one => one.task === entry.task)) return entry
    return entry.spent < MAX_ATTEMPTS
      ? { ...entry, state: 'queued', nextAttempt: entry.attempt + 1, retryOf: { attempt: entry.attempt, failureClass: 'inactivity-timeout' } }
      : { ...entry, state: 'unavailable', failureClass: 'inactivity-timeout' }
  })
  const stillRunning = after.filter(entry => entry.state === 'running')
  const queued = after.filter(entry => entry.state === 'queued')

  const dispatch = []
  let halt = null
  if (budget.expired) {
    if (queued.length || cancel.length) halt = 'max-duration'
  } else if (!halted) {
    let slots = Math.max(0, inflight - stillRunning.length)
    let remaining = budget.remaining
    for (const entry of queued) {
      if (!slots) break
      if (remaining !== null && remaining <= 0) {
        halt = 'max-tasks'
        break
      }
      dispatch.push({ task: entry.task, attempt: entry.nextAttempt, ...(entry.retryOf ? { retryOf: entry.retryOf } : {}) })
      slots -= 1
      if (remaining !== null) remaining -= 1
    }
  }

  const stopped = Boolean(halted) || halt !== null
  const waiting = queued.filter(entry => !dispatch.some(one => one.task === entry.task))
  // 단계가 끝났다는 것은 더 기다릴 것이 없다는 뜻이다. 멈춘 실행에서는 띄우지 못한 작업이 남아도
  // 끝이다 — 그 작업은 미검토 범위로 남는다.
  const complete = !stillRunning.length && !dispatch.length && (stopped || !waiting.length)
  return {
    stage,
    budget,
    dispatch,
    expire,
    cancel,
    halt,
    halted: halted ? { reason: halted.reason, at: halted.at } : null,
    states: after,
    running: stillRunning,
    waiting,
    complete,
  }
}

/** 시도를 가리키는 이름. 기록과 호스트 작업 설명에 같은 값을 쓴다. */
export const claimOf = (runId, stage, task, attempt) => `${runId}/${stage}/${task}#${attempt}`

/** 시도 하나를 끝내는 줄. 모듈은 `module.done`, 검증은 `verify.done`이다. 값이 없는 필드는 싣지 않는다. */
export function settleRecord(stage, task, attempt, fields) {
  const clean = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null))
  return stage === 'module'
    ? { phase: 'module.done', data: { module: task, attempt, ...clean } }
    : { phase: 'verify.done', data: { task, attempt, ...clean } }
}

/**
 * 결정을 기록할 줄로 바꾼다 — 대장 CLI와 테스트의 가짜 호스트가 같은 함수를 쓴다.
 *
 * 순서: 죽은 시도와 취소한 시도를 끝내고, 멈췄으면 그 사실을, 처음 띄우면 디스패치의 시작을, 그다음
 * 시도마다 시작을 남긴다. 모듈 단계가 끝났으면 디스패치의 끝을 남긴다(수치는 `review-timeline.mjs`가
 * 센다). 띄우기 **전에** 시작을 남기므로, 다음 결정은 그 시도가 돌고 있다고 본다.
 */
export function decisionRecords({ stage, decision, plan, fold, events, runId, inflight = DEFAULT_INFLIGHT }) {
  const records = []
  for (const one of decision.expire) {
    records.push(settleRecord(stage, one.task, one.attempt, {
      status: 'failed', failureClass: 'inactivity-timeout', taskId: one.hostTaskId,
      note: `끝 알림 없이 ${one.quietSec}초가 지나 대장이 끝냈다(staleAfterSec ${decision.budget.staleAfterSec}). 이 시도의 결과가 나중에 와도 받지 않는다`,
    }))
  }
  for (const one of decision.cancel) {
    records.push(settleRecord(stage, one.task, one.attempt, { status: 'failed', failureClass: 'cancelled', cancelReason: 'max-duration', taskId: one.hostTaskId }))
  }
  if (decision.halt && !haltOf(events)) {
    // 돌고 있는 수에는 이번에 띄운 시도도 든다 — 멈춘 뒤에도 그 시도의 결과는 받는다.
    records.push({ phase: 'dispatch.halt', data: { reason: decision.halt, stage, queuedTasks: decision.waiting.map(entry => entry.task), running: decision.running.length + decision.dispatch.length } })
  }
  const segment = segmentOf(events)
  const phases = events.slice(segment.index).map(event => event?.phase)
  const lastStart = phases.lastIndexOf('dispatch.start')
  const lastEnd = phases.lastIndexOf('dispatch.end')
  if (stage === 'module' && decision.dispatch.length && lastStart === -1) {
    records.push({ phase: 'dispatch.start', data: { modules: plan.length, inflight } })
  }
  const kinds = new Map(plan.map(entry => [entry.task, entry.kind]))
  for (const one of decision.dispatch) {
    const claim = claimOf(runId, stage, one.task, one.attempt)
    const previous = attemptsOf(fold, stage, one.task).at(-1)
    records.push(stage === 'module'
      ? { phase: 'module.start', data: { module: one.task, attempt: one.attempt, claim, ...(previous?.hostTaskId ? { retryOf: previous.hostTaskId } : {}) } }
      : { phase: 'verify.start', data: { task: one.task, attempt: one.attempt, kind: kinds.get(one.task), claim } })
  }
  if (stage === 'module' && decision.complete && lastStart !== -1 && lastEnd < lastStart) {
    // 수치는 review-timeline.mjs가 번호 모듈의 module.done에서 센다. 셀 줄이 없으면(특수 패스만 돈
    // 실행) 0을 넘긴다 — 빈 줄로 남기면 필수 필드가 빠진 기록이 된다.
    const numbered = events.some(event => event?.phase === 'module.done' && /^\d\d-/.test(String(event.module ?? '')))
    records.push({ phase: 'dispatch.end', data: numbered ? {} : { terminalOk: 0, terminalFailed: 0, attemptsTotal: 0, attemptsFailed: 0 } })
  }
  return records
}

/**
 * 끝 알림을 받을지 정한다.
 *
 * - `accept`: 지금 돌고 있는 그 시도의 끝이다
 * - `duplicate`: 이미 같은 끝을 받았다. 다시 쓰지 않는다 — 중복 알림을 두 번 세지 않는다
 * - `late`: 이미 끝난(취소됐거나 죽은 것으로 끝낸) 시도이거나 새 시도에 밀린 시도다. 받지 않는다 —
 *   늦게 온 응답이 새 시도의 결과를 덮지 않게
 * - `unknown`: 이 실행이 띄운 작업이 아니다(다른 실행의 호스트 작업 ID, 계획에 없는 이름)
 *
 * 호스트 작업 ID로 찾으면 오케스트레이터의 기억 대신 호스트의 알림이 어느 시도인지 말한다.
 *
 * 같은 응답을 두 번 받은 것은 내용 해시로 가린다. 계약을 어겨 실패로 끝난 응답도 그 해시를
 * 남기므로, 같은 알림을 다시 처리하면 "늦었다"가 아니라 "이미 받았다"가 된다.
 */
export function settleDecision({ fold, stage, task, attempt, hostTaskId, status, resultSha256 }) {
  let record = null
  if (hostTaskId !== undefined && hostTaskId !== null) {
    record = fold.hosts.get(String(hostTaskId)) ?? null
    if (!record) return { verdict: 'unknown', reason: `호스트 작업 ${hostTaskId}는 이 실행의 대장에 묶이지 않았다` }
    if (stage !== undefined && record.stage !== stage) return { verdict: 'unknown', reason: `호스트 작업 ${hostTaskId}는 ${record.stage} 단계의 작업이다` }
    if (task !== undefined && record.task !== task) return { verdict: 'unknown', reason: `호스트 작업 ${hostTaskId}는 ${record.task}의 시도다(받은 이름 ${task})` }
    if (attempt !== undefined && record.attempt !== attempt) {
      return { verdict: 'late', record, reason: `호스트 작업 ${hostTaskId}는 시도 ${record.attempt}의 것이다(받은 번호 ${attempt})` }
    }
  } else {
    const attempts = attemptsOf(fold, stage, task)
    if (!attempts.length) return { verdict: 'unknown', reason: `${task}는 이 실행에서 띄운 적이 없다` }
    record = attempts.find(one => one.attempt === attempt) ?? null
    if (!record) return { verdict: 'unknown', reason: `${task}의 시도 ${attempt}는 띄운 적이 없다` }
  }
  const latest = attemptsOf(fold, record.stage, record.task).at(-1)
  if (record.settled) {
    const ended = record.settled.failureClass === 'cancelled' || record.settled.failureClass === 'inactivity-timeout'
    const sameContent = resultSha256 !== undefined && record.settled.resultSha256 === resultSha256
    if (sameContent || (!ended && record.settled.status === status)) return { verdict: 'duplicate', record }
    const why = record.settled.failureClass === 'cancelled'
      ? '취소된 시도다'
      : record.settled.failureClass === 'inactivity-timeout'
        ? '응답이 없어 대장이 끝낸 시도다'
        : `이미 ${record.settled.status}로 끝난 시도다`
    return { verdict: 'late', record, reason: why }
  }
  if (latest !== record) return { verdict: 'late', record, reason: `시도 ${latest.attempt}가 이미 떴다` }
  if (record.startedAt === null) return { verdict: 'unknown', reason: `${record.task}의 시도 ${record.attempt}는 시작 기록이 없다` }
  return { verdict: 'accept', record }
}

/**
 * 검증 단계의 계획 — 띄울 수 있는 검증 작업과 그 순서.
 *
 * bundle·isolated 작업이 먼저 오고, 승격 작업은 **bundle이 `needs-context`로 돌린 후보에만** 생긴다.
 * 그 판정은 bundle의 판정 파일에 있으므로 `needsContextByTask`(작업 → 후보 ID들)로 받는다.
 */
export function verifyPlan(routed, needsContextByTask = new Map()) {
  const plan = (routed?.verifierTasks ?? []).map(task => ({
    task: task.taskId, kind: task.route, prompt: task.prompt, verdict: task.verdict, candidateIds: task.candidateIds,
  }))
  for (const task of routed?.verifierTasks ?? []) {
    if (task.route !== 'bundle') continue
    for (const candidateId of needsContextByTask.get(task.taskId) ?? []) {
      const promotion = routed?.promotions?.[candidateId]
      if (!promotion) continue
      plan.push({ task: promotion.taskId, kind: 'promotion', prompt: promotion.prompt, verdict: promotion.verdict, candidateIds: [candidateId] })
    }
  }
  return plan
}
