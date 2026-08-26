import { useEffect, useState } from 'react'

export function Clock() {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  return <time>{new Date(now).toISOString()}</time>
}
