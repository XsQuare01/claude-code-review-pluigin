import type { StreamFrame } from '../../entities/stream'

// 디코드 전에 프레임이 온전한지 확인한다. 호출부가 크기 0을 그대로
// 넘기면 캔버스 할당에서 터진다.
export function assertFrame(frame: StreamFrame | null): StreamFrame {
  if (!frame) throw new Error('프레임이 없습니다')
  if (frame.width <= 0 || frame.height <= 0) throw new Error('프레임 크기가 잘못됐습니다')
  return frame
}
