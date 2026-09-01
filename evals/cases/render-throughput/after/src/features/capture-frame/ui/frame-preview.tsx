import { useEffect, useMemo, useState } from 'react'
import type { DecodedFrame } from '../../../entities/frame'

export function FramePreview({ frame }: { frame: DecodedFrame | null }) {
  const [size, setSize] = useState({ w: 0, h: 0 })
  const style = { width: size.w, height: size.h }

  const label = useMemo(() => `${size.w}x${size.h}`, [style])

  useEffect(() => {
    if (frame?.bitmap) setSize({ w: frame.bitmap.width, h: frame.bitmap.height })
  }, [frame, style])

  return <figure style={style}>{label}</figure>
}
