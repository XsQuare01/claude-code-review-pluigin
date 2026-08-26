// 임시 진단 로거. 만료 판정이 어긋나는 원인을 찾는 동안만 둔다.
export function logExpiry(session: { expiresAt: number }) {
  const remaining = session.expiresAt - Date.now()

  if (remaining < 300000) {
    console.log(`[session] ${remaining}ms 남음`)
  }
}
