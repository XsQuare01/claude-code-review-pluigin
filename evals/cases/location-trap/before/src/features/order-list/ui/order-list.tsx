import { useState } from 'react'
import type { Order } from '../../../entities/order'

interface OrderListProps {
  orders: Order[]
  onSelect: (id: string) => void
}

function formatTotal(order: Order): string {
  return `${order.total.toLocaleString()}원`
}

export function OrderList({ orders, onSelect }: OrderListProps) {
  const [query, setQuery] = useState('')

  const visible = orders.filter(order => order.customer.includes(query))

  return (
    <div>
      <input value={query} onChange={event => setQuery(event.target.value)} />
      <ul>
        {visible.map(order => (
          <li key={order.id} onClick={() => onSelect(order.id)}>
            {order.customer} — {formatTotal(order)}
          </li>
        ))}
      </ul>
    </div>
  )
}
