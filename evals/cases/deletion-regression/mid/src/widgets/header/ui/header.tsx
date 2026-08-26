import { useState } from 'react'

import type { Session } from '../../../entities/session'
import { RenewButton } from '../../../features/renew-session'

interface HeaderProps {
  session: Session | null
}

export function Header({ session }: HeaderProps) {
  const [expired, setExpired] = useState(false)

  return (
    <header>
      {expired ? <span>세션이 만료되었습니다</span> : null}
      <RenewButton session={session} onRenew={() => {}} onExpire={() => setExpired(true)} />
    </header>
  )
}
