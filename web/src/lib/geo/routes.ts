import type { MapReplacement, MapShipment, TransportMode } from "@shared/api.ts"
import { type Coord, dedupe, densifyGreatCircle, densifyLinear, joinPaths, sameCoord, toCoord } from "./coords.ts"
import { seaRoute } from "./sea-lanes.ts"

// Route lines for shipments and replacements. Sea follows the lane graph, air flies great circles
// through its hubs, truck and rail run straight.

export type LegKind = "to_port" | "main" | "onward"

export interface RouteLeg {
  kind: LegKind
  mode: TransportMode
  path: Coord[]
}

export interface ShipmentRoute {
  legs: RouteLeg[]
  /** Origin to destination: the leg the vehicle is on. */
  main: Coord[]
}

/** The path a vehicle of this mode takes through the stops, in order. */
export function modePath(mode: TransportMode, stops: Coord[]): Coord[] {
  const pts = dedupe(stops)
  if (pts.length < 2) return pts
  switch (mode) {
    case "sea": {
      const pieces: Coord[][] = []
      for (let i = 1; i < pts.length; i++) pieces.push(seaRoute(pts[i - 1], pts[i]))
      return joinPaths(...pieces)
    }
    case "truck":
    case "rail":
      return densifyLinear(pts)
    default:
      return densifyGreatCircle(pts)
  }
}

/**
 * The full path of a shipment: pickup to origin (to port or airport), origin through `via` to the
 * destination (main leg), destination to the distribution center (onward leg).
 * `start` stands in for a missing origin and pickup (usually the supplier), `end` for a missing
 * destination and final stop (the hub). Returns null when there is nothing to start from.
 */
export function shipmentRoute(s: MapShipment, fallback: { start?: Coord | null; end: Coord }): ShipmentRoute | null {
  const pickup = s.pickup ? toCoord(s.pickup) : null
  const origin = s.origin ? toCoord(s.origin) : (pickup ?? fallback.start ?? null)
  if (!origin) return null
  const final = s.final ? toCoord(s.final) : null
  const destination = s.destination ? toCoord(s.destination) : (final ?? fallback.end)

  const legs: RouteLeg[] = []
  if (pickup && !sameCoord(pickup, origin)) legs.push({ kind: "to_port", mode: "truck", path: densifyLinear([pickup, origin]) })
  const main = modePath(s.mode, [origin, ...s.via.map(toCoord), destination])
  legs.push({ kind: "main", mode: s.mode, path: main.length > 1 ? main : [origin, destination] })
  if (final && !sameCoord(final, destination)) legs.push({ kind: "onward", mode: "truck", path: densifyLinear([destination, final]) })
  return { legs, main: legs.find((l) => l.kind === "main")!.path }
}

/** The path of a replacement route from a decision card. */
export function replacementRoute(r: MapReplacement): Coord[] {
  return modePath(r.mode, [toCoord(r.from), ...r.via.map(toCoord), toCoord(r.to)])
}
