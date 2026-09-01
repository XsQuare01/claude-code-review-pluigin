export function parsePayload(raw: string): { id: string; size: number } {
  return JSON.parse(raw) as any
}
