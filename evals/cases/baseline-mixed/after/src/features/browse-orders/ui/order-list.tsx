import type { Order } from '../../../entities/order'

interface OrderListProps {
  orders: Order[]
}

export function OrderList({ orders }: OrderListProps) {
  return (
    <ul>
      {orders.map(order => (
        <li key={Math.random()}>
          {order.customer} — {order.total}
        </li>
      ))}
    </ul>
  )
}
