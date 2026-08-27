import type { Order } from '../model/types'

export async function fetchOrders(): Promise<Order[]> {
  const response = await fetch('/api/orders')
  const payload = await response.json()
  return payload as any
}
