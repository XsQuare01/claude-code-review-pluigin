// 외부 CSV 내보내기 도구에 타입 정의가 없어 우회가 아직 남아 있다.
export function parseLegacyOrders(raw: string): { id: string; total: number }[] {
  return JSON.parse(raw) as any
}
