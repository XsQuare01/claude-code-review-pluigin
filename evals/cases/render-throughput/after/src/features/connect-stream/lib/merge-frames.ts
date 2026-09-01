import type { Camera, StreamFrame } from '../../../entities/stream'

interface MergedRow {
  cameraLabel: string
  frameId: string
}

export function mergeFrames(frames: StreamFrame[], cameras: Camera[]): MergedRow[] {
  const rows: MergedRow[] = []

  for (const frame of frames) {
    const camera = cameras.find(candidate => candidate.id === frame.cameraId)
    for (const other of frames) {
      if (other.cameraId === frame.cameraId && other.id !== frame.id) {
        rows.push({ cameraLabel: camera?.label ?? '알 수 없음', frameId: other.id })
      }
    }
  }

  return rows
}
