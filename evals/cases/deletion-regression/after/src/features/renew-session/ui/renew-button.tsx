import type { Session } from '../../../entities/session'

interface RenewButtonProps {
  session: Session | null
  onRenew: () => void
}

export function RenewButton({ session, onRenew }: RenewButtonProps) {
  if (session && session.expiresAt < Date.now()) {
    return null
  }

  return <button onClick={onRenew}>세션 연장</button>
}
