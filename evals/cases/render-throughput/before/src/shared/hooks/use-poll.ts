import { useEffect, useState } from 'react'

export function usePoll(intervalMs: number) {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick(previous => previous + 1), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])

  return tick
}
