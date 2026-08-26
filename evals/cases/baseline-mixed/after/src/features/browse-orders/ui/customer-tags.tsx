import type { Customer } from '../../../entities/order'

interface CustomerTagsProps {
  customers: Customer[]
}

export function CustomerTags({ customers }: CustomerTagsProps) {
  return (
    <ul>
      {customers.map(customer => (
        <li key={customer.id}>{customer.name}</li>
      ))}
    </ul>
  )
}
