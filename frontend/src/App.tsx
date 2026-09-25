import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

// Centro por defecto: Ciudad Bolívar, Bogotá (misma zona del GTFS_BBOX del backend).
const CIUDAD_BOLIVAR: [number, number] = [-74.16, 4.55]

function App() {
  const token = import.meta.env.VITE_MAPBOX_TOKEN
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!token || !containerRef.current) return

    mapboxgl.accessToken = token
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: CIUDAD_BOLIVAR,
      zoom: 12,
    })

    return () => map.remove()
  }, [token])

  if (!token) {
    return (
      <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
        <h1>Falta VITE_MAPBOX_TOKEN</h1>
        <p>
          Copia <code>frontend/.env.example</code> a <code>frontend/.env</code>{' '}
          y pega tu token público de Mapbox.
        </p>
      </div>
    )
  }

  return <div ref={containerRef} style={{ width: '100vw', height: '100vh' }} />
}

export default App
