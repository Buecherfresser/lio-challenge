import { useEffect, useState } from "react"
import { feature, mesh } from "topojson-client"

// The world outline, loaded once and on demand: the atlas is bundled (no tile server) but kept out of the main chunk.

export interface World {
  land: GeoJSON.FeatureCollection | GeoJSON.Feature
  borders: GeoJSON.MultiLineString
  coast: GeoJSON.MultiLineString
}

let cached: World | null = null
let loading: Promise<World> | null = null

function loadWorld(): Promise<World> {
  loading ??= import("world-atlas/countries-110m.json").then(({ default: topo }) => {
    const countries = topo.objects.countries
    cached = {
      land: feature(topo, countries),
      borders: mesh(topo, countries, (a, b) => a !== b),
      coast: mesh(topo, countries, (a, b) => a === b),
    }
    return cached
  })
  return loading
}

export function useWorld(): World | null {
  const [world, setWorld] = useState(cached)
  useEffect(() => {
    if (world) return
    let alive = true
    loadWorld().then(
      (w) => alive && setWorld(w),
      () => undefined,
    )
    return () => {
      alive = false
    }
  }, [world])
  return world
}
