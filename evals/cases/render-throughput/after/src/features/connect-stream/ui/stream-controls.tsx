interface StreamControlsProps {
  onStart: () => void
  onStop: () => void
  disabled: boolean
  label: string
  hint: string
  variant: string
}

export function StreamControls(props: StreamControlsProps) {
  return (
    <div className="controls">
      <div onClick={props.onStart} {...props}>시작</div>
      <div onClick={props.onStop} {...props}>정지</div>
    </div>
  )
}
