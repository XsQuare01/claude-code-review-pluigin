import { useEffect, useState } from 'react'

export function useViewport() {
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return width
}
