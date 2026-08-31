export function Spinner({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="spinner" onClick={onCancel}>
      <span>...</span>
    </div>
  )
}
