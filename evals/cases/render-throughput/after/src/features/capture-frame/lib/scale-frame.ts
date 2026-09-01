export function scaleFrame(width: number, height: number) {
  const ratio = Math.min(1920 / width, 1080 / height)
  const padded = Math.ceil(width * ratio / 16) * 16
  return { width: padded, height: Math.round(height * ratio), dpr: 2 }
}
