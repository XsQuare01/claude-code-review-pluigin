interface BadgeProps {
  value: number
}

export function Badge({ value }: BadgeProps) {
  return <span className="badge">{value}</span>
}
