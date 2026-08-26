import { Badge } from '../../../shared/ui/badge'

interface SummaryProps {
  count: number
}

export function Summary({ count }: SummaryProps) {
  return <div>{count && <Badge value={count} />}</div>
}
