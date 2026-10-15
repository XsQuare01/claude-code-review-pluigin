// 디스크 사용량은 저장소 제공자의 청구서와 같은 SI 단위(1000)로 보여 준다.
// 업로드 한도 표시(shared/lib/format-bytes, 1024 단위)와 일부러 다르다 — 청구서의 숫자와 맞아야 한다.
const SI_UNITS = ['B', 'kB', 'MB', 'GB']

export function formatDiskSize(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < SI_UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  return `${Math.round(value)} ${SI_UNITS[unit]}`
}
