import { formatBytes } from '../../../shared/lib'

export function UploadLimit({ maxBytes }: { maxBytes: number }) {
  return <p>최대 {formatBytes(maxBytes)}</p>
}
