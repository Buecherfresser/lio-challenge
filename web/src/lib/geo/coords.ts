import { geoDistance, geoInterpolate } from "d3-geo"

// Geographic helpers for the supply map. Coordinates are [lon, lat] in degrees, as d3 expects.

export type Coord = [lon: number, lat: number]

/** Longest piece of a densified line, in radians (about 0.75°, 80 km). */
export const STEP = (0.75 * Math.PI) / 180

export const toCoord = (p: { lon: number; lat: number }): Coord => [p.lon, p.lat]

export const sameCoord = (a: Coord, b: Coord) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6

/** Drops repeated points that follow each other. */
export function dedupe(points: Coord[]): Coord[] {
  const out: Coord[] = []
  for (const p of points) if (!out.length || !sameCoord(out[out.length - 1], p)) out.push(p)
  return out
}

/** Great-circle segments through the points, cut into pieces of at most `step` radians. */
export function densifyGreatCircle(points: Coord[], step = STEP): Coord[] {
  const pts = dedupe(points)
  if (pts.length < 2) return pts
  const out: Coord[] = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const n = Math.max(1, Math.ceil(geoDistance(a, b) / step))
    const at = geoInterpolate(a, b)
    for (let k = 1; k <= n; k++) out.push(k === n ? b : (at(k / n) as Coord))
  }
  return out
}

/** Straight segments in lon/lat (straight on the map), cut into pieces of at most `step` radians. */
export function densifyLinear(points: Coord[], step = STEP): Coord[] {
  const pts = dedupe(points)
  if (pts.length < 2) return pts
  const out: Coord[] = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]
    const [x1, y1] = pts[i]
    const n = Math.max(1, Math.ceil(geoDistance(pts[i - 1], pts[i]) / step))
    for (let k = 1; k <= n; k++) out.push(k === n ? pts[i] : [x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n])
  }
  return out
}

/** Joins paths end to start, without doubling the shared point. */
export function joinPaths(...paths: Coord[][]): Coord[] {
  return dedupe(paths.flat())
}

/** Distance from the start to every vertex, in radians. */
export function cumulative(path: Coord[]): number[] {
  const out = [0]
  for (let i = 1; i < path.length; i++) out.push(out[i - 1] + geoDistance(path[i - 1], path[i]))
  return out
}

export const pathLength = (path: Coord[]) => cumulative(path).at(-1) ?? 0

export interface PathPoint {
  point: Coord
  /** Index of the vertex before the point: the point lies between path[index] and path[index + 1]. */
  index: number
  fraction: number
}

/** The point at a share (0..1) of the path length. */
export function pointAlong(path: Coord[], fraction: number): PathPoint {
  const f = Math.min(1, Math.max(0, fraction))
  if (path.length < 2) return { point: path[0] ?? [0, 0], index: 0, fraction: f }
  const cum = cumulative(path)
  const target = f * cum[cum.length - 1]
  let i = 0
  while (i < cum.length - 2 && cum[i + 1] < target) i++
  const span = cum[i + 1] - cum[i]
  const t = span > 0 ? (target - cum[i]) / span : 0
  const point = geoInterpolate(path[i], path[i + 1])(t) as Coord
  return { point, index: i, fraction: f }
}

/** The point on the path closest to `p` (projected onto each piece), with its share of the length. */
export function snapToPath(path: Coord[], p: Coord): PathPoint {
  if (path.length < 2) return { point: path[0] ?? p, index: 0, fraction: 0 }
  const cum = cumulative(path)
  const total = cum[cum.length - 1] || 1
  let best = { d: Infinity, index: 0, t: 0 }
  for (let i = 0; i < path.length - 1; i++) {
    // Pieces are short, so a flat projection with the longitude scaled by cos(lat) is close enough.
    const [ax, ay] = path[i]
    const [bx, by] = path[i + 1]
    const k = Math.cos((((ay + by) / 2) * Math.PI) / 180)
    const dx = (bx - ax) * k
    const dy = by - ay
    const px = (p[0] - ax) * k
    const py = p[1] - ay
    const len2 = dx * dx + dy * dy
    const t = len2 > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy) / len2)) : 0
    const ex = px - t * dx
    const ey = py - t * dy
    const d = ex * ex + ey * ey
    if (d < best.d) best = { d, index: i, t }
  }
  const point = geoInterpolate(path[best.index], path[best.index + 1])(best.t) as Coord
  const along = cum[best.index] + best.t * (cum[best.index + 1] - cum[best.index])
  return { point, index: best.index, fraction: along / total }
}

/** Splits a path at a point found by pointAlong or snapToPath. */
export function splitAt(path: Coord[], at: PathPoint): [before: Coord[], after: Coord[]] {
  const before = dedupe([...path.slice(0, at.index + 1), at.point])
  const after = dedupe([at.point, ...path.slice(at.index + 1)])
  return [before, after]
}

/** Initial compass bearing from a to b, degrees clockwise from north. */
export function bearing(a: Coord, b: Coord): number {
  const rad = Math.PI / 180
  const [l1, p1] = [a[0] * rad, a[1] * rad]
  const [l2, p2] = [b[0] * rad, b[1] * rad]
  const y = Math.sin(l2 - l1) * Math.cos(p2)
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(l2 - l1)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}
