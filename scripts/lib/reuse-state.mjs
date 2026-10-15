// 기존 구현 검색(C-6C)의 상태를 실행 기록에서 읽는다.
//
// 왜 한 곳인가: 작업 대장은 이 값으로 05를 붙잡거나 풀고, 기록 검사(`review-timeline --check`)는 이 값으로 05가
// 너무 일찍 시작했는지 본다. 두 곳이 같은 기록을 다르게 읽으면 한쪽은 풀었는데 다른 쪽은 위반이라고 부른다 —
// 재개 흐름에서 조립 스크립트와 작업 대장이 `run.end`를 다르게 읽은 일이 있었다(PR #105 리뷰).
//
// 검색은 다른 모듈과 함께 돈다. 05만 그 결과를 기다린다. 결과가 실패로 끝나도, 검색 프로세스가 끝을 남기지 못하고
// 사라져도, 기다리는 시간이 상한에 닿아도 05를 푼다 — 05의 다른 구조 규칙은 검색과 상관없이 돌아야 하고, 기다림이
// 영원히 남으면 실행이 끝나지 않는다. 풀린 이유는 그대로 남아 리포트가 검색을 미완료로 적는다.

/** 검색 결과를 받는 모듈(catalog의 이름) */
export const REUSE_MODULE = '05-structure'

/** 검색 결과의 상태. `complete`는 계획한 검색을 다 했다는 뜻이지 같은 구현이 없다는 보장이 아니다. */
export const REUSE_STATUSES = ['complete', 'partial', 'failed', 'not-applicable']

/** 계획한 때부터 05가 검색을 기다리는 기본 상한(초). `reuse.planned`의 `waitSec`으로 바꾼다. */
export const DEFAULT_REUSE_WAIT_SEC = 1800

/** 검색 스크립트를 감싸 띄울 때 쓰는 review-tool의 `--name` */
export const REUSE_TOOL_NAME = 'reuse-search'

const indexOf = (events, event) => events.indexOf(event)

/**
 * 지금 시도(마지막 `reuse.planned`의 `searchId`)의 상태.
 *
 * - `required`: 시작(`run.start.reuseSearch`)이 검색을 예정했는가. 없으면 예전 기록이고 기다릴 것이 없다
 * - `state`: `unplanned`(계획 줄이 없다)·`planned`·`running`·`done`·`lost`(감싼 review-tool은 끝났는데 검색의 끝이
 *   없다)·`timed-out`
 * - `released`: 05를 띄워도 되는가. `releasedAt`은 풀린 시각(기록의 시각 또는 상한 시각)
 *
 * `now`는 시간 초과를 가를 시각(ms)이다. 기록 검사는 기록이 끝난 시각이 아니라 지금을 쓴다 — 끝내 끝나지 않은
 * 검색도 상한 시각에 풀린 것으로 본다.
 */
export function reuseState(events, { now = Date.now() } = {}) {
  const start = events.find(event => event?.phase === 'run.start')
  if (start?.reuseSearch !== 'planned') return { required: false, released: true, releasedAt: null, state: 'not-required' }
  const planned = events.filter(event => event?.phase === 'reuse.planned').at(-1) ?? null
  const searchId = typeof planned?.searchId === 'string' ? planned.searchId : null
  const after = planned ? events.slice(indexOf(events, planned) + 1) : []
  const ofThis = phase => (searchId ? after.filter(event => event?.phase === phase && event.searchId === searchId).at(-1) ?? null : null)
  const started = ofThis('reuse.start')
  const done = ofThis('reuse.done')
  const wrapperEnd = after.find(event => event?.phase === 'tool.done' && event.name === REUSE_TOOL_NAME) ?? null
  const waitSec = Number.isInteger(planned?.waitSec) && planned.waitSec > 0 ? planned.waitSec : DEFAULT_REUSE_WAIT_SEC
  // 계획 줄이 없으면 첫 디스패치부터 잰다 — 그것도 없으면 시작부터
  const firstDispatch = events.find(event => event?.phase === 'dispatch.start' || event?.phase === 'module.start')
  const clockFrom = Date.parse(planned?.at ?? firstDispatch?.at ?? start.at)
  const deadline = clockFrom + waitSec * 1000
  const base = { required: true, searchId, planned, started, done, wrapperEnd, waitSec, deadline: new Date(deadline).toISOString() }
  // 풀린 시각은 가장 먼저 온 사건이다 — 상한이 먼저 지났으면 대장은 그때 05를 풀었다. 늦게 온 끝이 그 시각을 미루지 않는다
  const releasedAt = event => (Date.parse(event.at) > deadline ? new Date(deadline).toISOString() : event.at)
  if (done) return { ...base, state: 'done', released: true, releasedAt: releasedAt(wrapperEnd && Date.parse(wrapperEnd.at) < Date.parse(done.at) ? wrapperEnd : done), status: done.status ?? null }
  if (wrapperEnd) return { ...base, state: 'lost', released: true, releasedAt: releasedAt(wrapperEnd), reason: '검색 프로세스가 끝(reuse.done)을 남기지 못하고 끝났다' }
  if (now >= deadline) return { ...base, state: 'timed-out', released: true, releasedAt: new Date(deadline).toISOString(), reason: `검색을 ${waitSec}초 기다렸다` }
  return { ...base, state: !planned ? 'unplanned' : started ? 'running' : 'planned', released: false }
}

/**
 * 어떤 줄(보통 05의 `module.start`)을 남긴 순간의 상태 — 그 줄 앞의 기록을 그 줄의 시각으로 읽는다.
 *
 * 작업 대장은 띄우기 직전의 기록으로 05를 풀었다. 그 뒤에 늦게 온 끝이나 다시 등록한 검색은 05가 무엇을 받고
 * 돌았는지를 바꾸지 않는다 — 기록 끝의 상태로 05를 판단하면 정상으로 돈 05를 위반으로 짚고, 05가 받지 못한 근거를
 * 받은 것처럼 쓴다.
 */
export function reuseStateBefore(events, event) {
  const at = events.indexOf(event)
  return reuseState(at === -1 ? events : events.slice(0, at), { now: Date.parse(event.at) })
}

/** 05가 마지막으로 띄워진 줄. 결과로 쓰는 것은 대개 마지막 시도다. 없으면 `null`. */
export function lastReuseModuleStart(events) {
  return events.filter(event => event?.phase === 'module.start' && event.module === REUSE_MODULE).at(-1) ?? null
}
