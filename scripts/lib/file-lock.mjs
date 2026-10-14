import { closeSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs'

// 여러 프로세스가 같은 파일에 차례로 쓰게 하는 잠금.
//
// 왜 있는가: 실행 기록(C-9)의 순번(`seq`)은 지금까지 쓴 줄 수로 정한다. 함께 띄운 모듈의 `module.start`, 함께
// 띄운 도구의 `tool.start`처럼 두 프로세스가 같은 순간 읽고 쓰면 같은 번호가 두 줄에 붙는다 — 2026-10-06과
// 2026-10-13 실행의 기록에 그런 줄이 있다. 도구를 띄워 두고 끝을 그 프로세스가 직접 남기게 하면 그런 순간이 더
// 잦아진다. 잠금 파일을 배타적으로 만들어(`wx`) 잡고, 쓰고, 지운다.

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * `lockPath`를 잡은 채 `fn`을 부르고 그 값을 돌려준다. 다른 프로세스가 잡고 있으면 기다린다.
 *
 * 잡은 프로세스가 죽으면 잠금 파일이 남는다. 기록 한 줄은 밀리초 단위의 일이므로 `staleMs`보다 오래된 잠금은
 * 버린다. `timeoutMs` 안에 잡지 못하면 던진다 — 기다리다 순서를 어기고 쓰지 않는다.
 */
export function withFileLock(lockPath, fn, { timeoutMs = 15000, staleMs = 30000, pollMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs
  let fd
  for (;;) {
    try {
      fd = openSync(lockPath, 'wx')
      break
    } catch (error) {
      // Windows는 지우는 중인 파일을 다시 만들 때 EPERM을 낸다 — 잠금이 풀리는 순간이다.
      if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error
      let age = null
      try {
        age = Date.now() - statSync(lockPath).mtimeMs
      } catch {
        continue // 그새 풀렸다
      }
      if (age > staleMs) {
        try {
          unlinkSync(lockPath)
        } catch {
          // 다른 프로세스가 먼저 치웠다
        }
        continue
      }
      if (Date.now() > deadline) throw new Error(`잠금을 ${timeoutMs}ms 안에 얻지 못했다: ${lockPath}`)
      sleep(pollMs)
    }
  }
  try {
    writeSync(fd, String(process.pid))
    return fn()
  } finally {
    closeSync(fd)
    try {
      unlinkSync(lockPath)
    } catch {
      // 이미 없다
    }
  }
}
