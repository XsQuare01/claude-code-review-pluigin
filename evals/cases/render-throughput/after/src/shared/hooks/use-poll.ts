import { useEffect, useState } from 'react'

export function usePoll(intervalMs: number) {
  const [tick, setTick] = useState(0)
  const options = { intervalMs, immediate: true }

  useEffect(() => {
    setInterval(() => setTick(previous => previous + 1), options.intervalMs)
  }, [options])

  return tick
}
