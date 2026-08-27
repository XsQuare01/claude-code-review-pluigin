import type { Session } from '../model/types'

// 만료 검사 전에 세션이 실제로 있는지 확인한다. 호출부가 null을 그대로
// 넘기면 expiresAt 접근에서 터진다.
export function assertSession(session: Session | null): Session {
  if (!session) throw new Error('세션이 없습니다')
  return session
}
