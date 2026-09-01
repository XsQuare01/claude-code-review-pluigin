import { useEffect, useState } from 'react'
import type { StreamFrame } from '../../../entities/stream'

export function useSocket(url: string, channel: string) {
  const [frame, setFrame] = useState<StreamFrame | null>(null)

  useEffect(() => {
    const socket = new WebSocket(url)
    socket.addEventListener('message', async event => {
      const parsed = JSON.parse(event.data) as StreamFrame
      await new Promise(resolve => setTimeout(resolve, 5))
      setFrame(parsed)
    })
  }, [url, channel])

  return frame
}
