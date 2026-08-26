import { assertSession, type Session } from '../../../entities/session'

interface RenewButtonProps {
  session: Session | null
  onRenew: () => void
  onExpire: () => void
}

export function RenewButton({ session, onRenew, onExpire }: RenewButtonProps) {
  const active = assertSession(session)

  if (active.expiresAt < Date.now()) {
    onExpire()
    return null
  }

  return <button onClick={onRenew}>세션 연장</button>
}
