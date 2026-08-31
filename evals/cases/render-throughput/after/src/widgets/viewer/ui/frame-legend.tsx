import { fmtSz, fmtMs } from '../../../shared/lib/fmt'

export function FrameLegend({ w, h, t }: { w: number; h: number; t: number }) {
  console.log(`[legend] ${w} ${h} ${t}`)
  return <small>{fmtSz(w, h)} · {fmtMs(t)}</small>
}
