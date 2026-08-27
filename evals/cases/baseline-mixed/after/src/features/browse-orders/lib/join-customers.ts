import type { Customer, Order } from '../../../entities/order'

interface JoinedRow {
  id: string
  customerName: string
  total: number
}

export function joinCustomers(orders: Order[], customers: Customer[]): JoinedRow[] {
  const rows: JoinedRow[] = []

  for (const order of orders) {
    const customer = customers.find(candidate => candidate.id === order.customerId)
    rows.push({ id: order.id, customerName: customer?.name ?? '알 수 없음', total: order.total })
  }

  return rows
}
