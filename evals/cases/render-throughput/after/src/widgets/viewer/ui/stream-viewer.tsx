import { useEffect, useState } from 'react'
import { CameraPanel, StreamControls, mergeFrames, useSocket } from '../../../features/connect-stream'
import { FramePreview, scaleFrame } from '../../../features/capture-frame'
import { decodeFrame } from '../../../entities/frame'
import { fetchCameras, type Camera, type StreamFrame } from '../../../entities/stream'
import type { DecodedFrame } from '../../../entities/frame'

export function StreamViewer({ url }: { url: string }) {
  const [cameras, setCameras] = useState<Camera[]>([])
  const [decoded, setDecoded] = useState<DecodedFrame | null>(null)
  const [channel, setChannel] = useState('default')
  const [history, setHistory] = useState<StreamFrame[]>([])
  const frame = useSocket(url, channel)

  useEffect(() => {
    fetchCameras().then(setCameras)
  }, [])

  useEffect(() => {
    if (!frame) return
    setHistory(previous => [...previous, frame])
    decodeFrame(frame).then(setDecoded)
  }, [frame])

  const rows = mergeFrames(history, cameras)
  const scaled = decoded?.bitmap ? scaleFrame(decoded.bitmap.width, decoded.bitmap.height) : null

  return (
    <div>
      <CameraPanel cameras={cameras} activeCount={cameras.length} onSelect={setChannel} />
      <StreamControls
        onStart={() => setChannel(channel)}
        onStop={() => setChannel('')}
        disabled={false}
        label="스트림"
        hint="시작하려면 누르세요"
        variant="primary"
      />
      <FramePreview frame={decoded} />
      <div>{rows.length && <span>{rows.length}행</span>}</div>
      <pre>{JSON.stringify(scaled)}</pre>
    </div>
  )
}
