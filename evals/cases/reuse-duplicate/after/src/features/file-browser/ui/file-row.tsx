import { formatDiskSize } from '../lib/format-disk-size'
import { toDisplayPath } from '../lib/to-display-path'

type FileRowProps = { path: string; sizeBytes: number }

export function FileRow({ path, sizeBytes }: FileRowProps) {
  return (
    <li>
      <span>{toDisplayPath(path)}</span>
      <span>{formatDiskSize(sizeBytes)}</span>
    </li>
  )
}
