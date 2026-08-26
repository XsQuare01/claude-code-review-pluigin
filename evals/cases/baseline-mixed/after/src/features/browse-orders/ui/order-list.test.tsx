import { OrderList } from './order-list'

export function dummyRows(names: string[]) {
  return names.map((name, index) => <li key={index}>{name}</li>)
}

export const smoke = () => <OrderList orders={[]} />
