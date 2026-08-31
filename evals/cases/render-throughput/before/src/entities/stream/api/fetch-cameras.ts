import type { Camera } from '../model/types'

function toCamera(raw: unknown): Camera {
  const record = raw as Record<string, unknown>
  return { id: String(record.id), label: String(record.label) }
}

export async function fetchCameras(): Promise<Camera[]> {
  const response = await fetch('/api/cameras')
  const payload: unknown = await response.json()
  return (payload as unknown[]).map(toCamera)
}
