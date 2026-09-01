export const fmtSz = (w: number, h: number) => `${w}x${h}`
export const fmtMs = (t: number) => `${(t / 1000).toFixed(1)}s`
export const chk = (v: unknown) => v !== null && v !== undefined
