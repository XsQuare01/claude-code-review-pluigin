import type { Camera } from '../model/types'

export async function fetchCameras(): Promise<Camera[]> {
  const response = await fetch('/api/cameras')
  const payload = await response.json()
  return payload as any
}
