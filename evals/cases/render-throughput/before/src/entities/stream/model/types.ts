export interface StreamFrame {
  id: string
  cameraId: string
  width: number
  height: number
  payload: Uint8Array
}

export interface Camera {
  id: string
  label: string
}
