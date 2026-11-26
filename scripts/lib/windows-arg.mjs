// 인자 배열을 Windows 명령줄 문자열로 옮긴다 — 문자열 하나로만 인자를 받는 실행(PowerShell `Start-Process`의
// `-ArgumentList`)에 인자 배열을 그대로 넘기려고 쓴다.
//
// 받는 쪽(Node·MSVCRT)이 명령줄을 인자로 가르는 규칙의 역이다(libuv `quote_cmd_arg`와 같다). 공백·따옴표가 없으면
// 그대로 두고, 있으면 따옴표로 감싼다. 감쌀 때 따옴표 앞의 역슬래시는 두 배에 하나를 더해 따옴표를 `\"`로 적고,
// 감싼 인자 끝의 역슬래시는 두 배로 적는다 — 그래야 닫는 따옴표가 글자로 읽히지 않는다.

export function windowsArg(arg) {
  if (arg === '') return '""'
  if (!/[\s"]/.test(arg)) return arg
  let quoted = '"'
  let slashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      slashes += 1
      continue
    }
    quoted += ch === '"' ? `${'\\'.repeat(slashes * 2 + 1)}"` : `${'\\'.repeat(slashes)}${ch}`
    slashes = 0
  }
  return `${quoted}${'\\'.repeat(slashes * 2)}"`
}

export const windowsCommandLine = args => args.map(windowsArg).join(' ')
