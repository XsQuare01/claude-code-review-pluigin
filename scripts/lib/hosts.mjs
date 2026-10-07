// 호스트가 무엇을 해 줄 수 있는지 — 작업 대장(C-12)이 한도를 어디까지 지킬 수 있는지가 여기서 갈린다.
//
// 이 플러그인은 작업을 띄우지 않는다. 띄우고, 기다리고, 멈추는 것은 호스트(harness)다. 그래서
// "시간 상한 30분"이 무엇을 보장하는지는 호스트에 달려 있다 — 돌고 있는 작업을 멈출 수 없는
// 호스트에서 상한은 새 작업을 막을 뿐이고, 작업 하나가 끝날 때 오케스트레이터를 깨우지 않는
// 호스트에서는 상한이 지났다는 사실을 누구도 그 자리에서 알아채지 못한다. 그것을 말하지 않고
// "상한 30분"이라고만 적으면 지킬 수 없는 약속이 된다(#88 PR 3).
//
// **확인한 것만 참으로 둔다.** 확인하지 못한 능력은 없는 것으로 다룬다 — 있다고 가정했다가
// 틀리면 한도가 지켜졌다고 거짓말을 하게 되고, 없다고 가정했다가 틀리면 조금 덜 쓸 뿐이다.

/**
 * - `perTaskNotification`: 작업 하나가 끝날 때마다 오케스트레이터를 깨운다
 * - `cancel`: 돌고 있는 작업을 멈출 수 있다
 * - `taskDeadline`: 작업마다 시간 상한을 걸 수 있다(호스트가 대신 끊는다)
 * - `wakeAt`: 정한 시각에 오케스트레이터를 깨울 수 있다
 */
export const CAPABILITIES = ['perTaskNotification', 'cancel', 'taskDeadline', 'wakeAt']

const HOSTS = new Map([
  // background 작업은 끝날 때마다 알림이 오고, 작업을 멈추는 도구(TaskStop)가 있다. 작업마다
  // 시간 상한을 거는 인자는 없고, 오케스트레이터가 스스로 정한 시각에 깨어날 방법도 없다.
  ['claude-code', {
    perTaskNotification: true,
    cancel: true,
    taskDeadline: false,
    wakeAt: false,
    basis: 'background 작업 완료 알림과 작업 중지 도구',
  }],
  // oh-my-openagent는 개별 완료 알림에 "전부 끝나면 알린다"를 붙이고 부모를 깨우지 않는다 —
  // 2026-10-02 세션 기록에서 확인했다. 작업을 멈추는 길은 확인하지 못했다.
  ['opencode', {
    perTaskNotification: false,
    cancel: false,
    taskDeadline: false,
    wakeAt: false,
    basis: 'oh-my-openagent 세션 기록(2026-10-02) — 띄운 작업이 전부 끝나야 깨운다. 작업 중지는 확인하지 못했다',
  }],
])

const UNKNOWN = { perTaskNotification: false, cancel: false, taskDeadline: false, wakeAt: false, basis: '알려지지 않은 호스트 — 아무 능력도 가정하지 않는다' }

/** 호스트 이름(`run.start.host`)의 능력. 모르는 이름은 아무 능력도 없는 것으로 본다. */
export function hostCapabilities(name) {
  const known = HOSTS.get(String(name ?? ''))
  return { name: String(name ?? 'unknown'), known: known !== undefined, ...(known ?? UNKNOWN) }
}

/**
 * 시간 상한이 이 호스트에서 무엇을 보장하는가. 상태 출력과 스냅숏이 같은 문장을 쓴다.
 *
 * 상한은 오케스트레이터가 대장을 부를 때(`next`·`status`) 검사된다. 그 사이에 상한이 지나도
 * 깨워 줄 호스트가 없으면 아무도 모른다 — 그래서 "강제 상한이 아니다"를 기본 문장으로 둔다.
 */
export function durationLimitScope(host) {
  const parts = ['시간 상한은 오케스트레이터가 대장을 부를 때 검사한다 — 상한이 지나도 깨워 줄 것이 없으면 다음 호출까지 모른다']
  if (host.taskDeadline) parts[0] = '시간 상한은 호스트가 작업마다 끊는다'
  parts.push(host.cancel
    ? '상한이 지나면 돌고 있는 작업을 멈추고 그 결과를 받지 않는다'
    : '이 호스트는 돌고 있는 작업을 멈추지 못한다 — 상한이 지나면 그 결과를 받지 않을 뿐, 작업은 끝날 때까지 돌 수 있다')
  if (!host.perTaskNotification) parts.push('작업 하나가 끝나도 깨우지 않는 호스트다 — 띄운 작업이 전부 끝나야 다음 결정을 한다')
  return parts.join('. ')
}
