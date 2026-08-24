// claude 프로세스의 종료를 분류하는 순수 함수.
//
// fs도 git도 spawn도 쓰지 않는다. 호출자가 관찰한 값만 받아서 셈한다 — 그래야
// 이 분류 규칙을 실제 프로세스 하나 띄우지 않고 검증할 수 있다.
//
// 신호가 아니라 harness가 직접 kill을 호출했는지로 판단한다. Windows에는 POSIX
// 시그널이 없어서, harness가 타임아웃으로 .kill('SIGKILL')한 프로세스도 close
// 이벤트의 signal이 null로 보고된다 — `signal === 'SIGKILL'`로 분류하면 이
// 저장소가 실제로 돌아가는 플랫폼에서 타임아웃을 절대 못 잡는다.
// killedByTimeout 플래그는 signal보다 항상 나은 정보다: 어느 플랫폼에서도
// harness 자신이 무엇을 했는지는 harness가 직접 안다. signal은 그래서 이
// 함수의 분류에는 쓰이지 않는다 — 호출부가 관찰한 그대로 넘겨도 되게 받아만
// 두는 자리다.
export const classifyExit = ({ killedByTimeout, code, signal }) => {
  if (killedByTimeout) return 'timeout'
  if (code === 0) return true
  return 'failed'
}
