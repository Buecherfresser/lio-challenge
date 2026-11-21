import { type GeoProjection, geoNaturalEarth1, geoPath } from "d3-geo"
import type { Coord } from "./coords.ts"

// The map frame: a Natural Earth projection fitted to the region that holds the data.

export interface Box {
  west: number
  east: number
  south: number
  north: number
}

/** The region of the planning sketch: North America to Korea, the equator to Scandinavia. */
export const DEFAULT_BOX: Box = { west: -125, east: 150, south: -8, north: 66 }

/** The default box, grown to hold every point with some padding. */
export function boxFor(points: Coord[], pad = 6, base: Box = DEFAULT_BOX): Box {
  const box = { ...base }
  for (const [lon, lat] of points) {
    box.west = Math.min(box.west, lon - pad)
    box.east = Math.max(box.east, lon + pad)
    box.south = Math.min(box.south, lat - pad)
    box.north = Math.max(box.north, lat + pad)
  }
  return {
    west: Math.max(-180, box.west),
    east: Math.min(180, box.east),
    south: Math.max(-70, box.south),
    north: Math.min(84, box.north),
  }
}

export interface Frame {
  projection: GeoProjection
  /** SVG viewBox: x, y, width, height. */
  viewBox: [number, number, number, number]
  /** Projects to a share of the frame, 0..1 from the top left (for HTML markers over the SVG). */
  relative: (p: Coord) => [number, number] | null
}

export function frameFor(box: Box, width = 1000): Frame {
  // Sample the box edges: under Natural Earth the parallels and meridians curve.
  const edge: Coord[] = []
  for (let lon = box.west; lon <= box.east; lon += 5) edge.push([lon, box.south], [lon, box.north])
  for (let lat = box.south; lat <= box.north; lat += 5) edge.push([box.west, lat], [box.east, lat])
  edge.push([box.east, box.south], [box.east, box.north])
  const outline = { type: "MultiPoint" as const, coordinates: edge }
  const projection = geoNaturalEarth1()
    .rotate([-(box.west + box.east) / 2, 0])
    .precision(0.3)
    .fitWidth(width, outline)
  const [[x0, y0], [x1, y1]] = geoPath(projection).bounds(outline)
  const w = x1 - x0
  const h = y1 - y0
  return {
    projection,
    viewBox: [x0, y0, w, h],
    relative: (p) => {
      const xy = projection(p)
      return xy ? [(xy[0] - x0) / w, (xy[1] - y0) / h] : null
    },
  }
}
