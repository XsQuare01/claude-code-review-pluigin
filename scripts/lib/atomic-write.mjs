import * as nodeFs from 'node:fs'
import { randomBytes } from 'node:crypto'

// 기록 파일을 반쪽으로 남기지 않는 쓰기.
//
// 결과 스냅숏(C-10)과 재현 근거(C-11)가 같은 방식으로 쓴다. 그 자리에 바로 쓰면 쓰다 멈춘
// 순간 앞의 정상 파일이 사라지고 반쪽 파일이 남는다. 그 반쪽을 다음 실행이 읽으면
// "지적 0건"이나 "근거 없음"으로 읽힌다.

/**
 * 임시 파일에 쓰고, 다시 읽어 같은지(그리고 `verify`가 문제를 말하지 않는지) 본 뒤 이름을
 * 바꿔 교체한다.
 *
 * 디스크가 차서 일부만 쓰인 경우는 쓰기 호출이 성공해도 일어난다 — 그래서 다시 읽는다.
 * 어느 단계에서 실패하든 임시 파일을 지우고 던지며, 앞의 파일은 그대로다. `verify`는
 * 다시 읽은 글을 받아 문제가 있으면 그 설명을, 없으면 거짓 값을 돌려준다. `fs`는 테스트가
 * 쓰기 실패를 흉내 낼 때 바꿔 끼운다.
 */
export function writeTextAtomic(path, text, { verify = () => null, fs = nodeFs } = {}) {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx' })
    const written = fs.readFileSync(temporary, 'utf8')
    const problem = written === text ? verify(written) : `쓴 내용과 다르다(${written.length}/${text.length}자)`
    if (problem) throw new Error(`임시 파일을 다시 읽었더니 ${problem} — 교체하지 않는다`)
    fs.renameSync(temporary, path)
  } catch (error) {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    } catch {
      // 임시 파일을 못 지운 것은 원래 실패를 가리지 않는다
    }
    throw error
  }
}
