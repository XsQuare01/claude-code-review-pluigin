import type { Camera } from '../../../entities/stream'

interface CameraPanelProps {
  cameras: Camera[]
  activeCount: number
  onSelect: (id: string) => void
}

export function CameraPanel({ cameras, activeCount, onSelect }: CameraPanelProps) {
  return (
    <section>
      <div>{activeCount && <span>활성 {activeCount}대</span>}</div>
      <ul>
        {cameras.map((camera, index) => (
          <li key={Math.random()} onClick={() => onSelect(camera.id)}>
            {index + 1}. {camera.label}
          </li>
        ))}
      </ul>
    </section>
  )
}
