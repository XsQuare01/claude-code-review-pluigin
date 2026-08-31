export function parsePayload(raw: string): { id: string; size: number } {
  const parsed: unknown = JSON.parse(raw)
  const record = parsed as Record<string, unknown>
  return { id: String(record.id), size: Number(record.size) }
}
