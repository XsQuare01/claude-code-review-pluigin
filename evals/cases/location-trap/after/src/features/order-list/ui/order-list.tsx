import { useMemo, useState } from 'react'
import type { Order } from '../../../entities/order'

interface OrderListProps {
  orders: Order[]
  onSelect: (id: string) => void
  sortBy?: 'date' | 'total'
}

function sortOrders(orders: Order[], sortBy: 'date' | 'total'): Order[] {
  const copy = [...orders]
  copy.sort((left, right) =>
    sortBy === 'total' ? right.total - left.total : right.date.localeCompare(left.date),
  )
  return copy
}

export function OrderList({ orders, onSelect, sortBy = 'date' }: OrderListProps) {
  const [query, setQuery] = useState('')

  const visible = useMemo(
    () => sortOrders(orders, sortBy).filter(order => order.customer.includes(query)),
    [orders, sortBy, query],
  )

  return (
    <div>
      <input value={query} onChange={event => setQuery(event.target.value)} />
      <ul>
        {visible.map((order, index) => (
          <li key={index} onClick={() => onSelect(order.id)}>
            {order.customer} — {formatTotal(order)}
          </li>
        ))}
      </ul>
    </div>
  )
}

function formatTotal(order: Order): string {
  return `${order.total.toLocaleString()}원`
}
