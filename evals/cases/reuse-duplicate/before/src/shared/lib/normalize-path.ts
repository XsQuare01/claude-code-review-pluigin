// 저장소 키와 화면 경로가 같은 규칙을 쓰도록 한 곳에 둔다.
export function normalizePath(raw: any): string {
  return String(raw)
    .split('/')
    .filter(part => part !== '')
    .join('/')
}
