import type { Order } from '../model/types'

function toOrder(raw: unknown): Order {
  const record = raw as Record<string, unknown>
  return {
    id: String(record.id),
    customerId: String(record.customerId),
    customer: String(record.customer),
    total: Number(record.total),
  }
}

export async function fetchOrders(): Promise<Order[]> {
  const response = await fetch('/api/orders')
  const payload: unknown = await response.json()
  return (payload as unknown[]).map(toOrder)
}
