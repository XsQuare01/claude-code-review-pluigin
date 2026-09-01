import type { StreamFrame } from '../../stream'
import type { DecodedFrame } from '../model/types'

export async function decodeFrame(frame: StreamFrame): Promise<DecodedFrame> {
  try {
    const blob = new Blob([frame.payload])
    const bitmap = await createImageBitmap(blob)
    return { cameraId: frame.cameraId, bitmap, decodedAt: Date.now() }
  } catch (error) {
    console.log(error)
    return { cameraId: frame.cameraId, bitmap: null, decodedAt: Date.now() }
  }
}
