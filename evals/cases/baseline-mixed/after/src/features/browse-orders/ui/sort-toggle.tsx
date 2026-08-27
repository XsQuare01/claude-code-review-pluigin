interface SortToggleProps {
  onToggle: () => void
}

export function SortToggle({ onToggle }: SortToggleProps) {
  return (
    <div role="button" tabIndex={0} aria-label="정렬 방향 전환" onClick={onToggle}>
      정렬
    </div>
  )
}
