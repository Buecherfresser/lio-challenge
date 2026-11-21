import type { MapShipment } from "@shared/api.ts"
import { type Coord, type PathPoint, bearing, pointAlong, snapToPath, splitAt } from "./coords.ts"

// Where a vehicle is now, estimated on its main leg (origin to destination).

export type PositionState = "at_origin" | "moving" | "at_destination"

export interface Position {
  point: Coord
  /** Share of the main leg behind the vehicle, 0..1. */
  fraction: number
  state: PositionState
  /** How the estimate was made. */
  basis: "not_departed" | "tracked" | "schedule" | "overdue" | "arrived" | "unknown"
  travelled: Coord[]
  remaining: Coord[]
  /** Two points around the vehicle along its path, to turn an icon in screen space. */
  tangent: [Coord, Coord]
  /** Compass bearing of the path at the vehicle, degrees clockwise from north. */
  heading: number
}

const ARRIVED = new Set(["arrived", "delivered", "discharged", "received", "unloaded"])

const time = (iso: string | null | undefined) => {
  const t = iso ? new Date(iso).getTime() : NaN
  return Number.isNaN(t) ? null : t
}

type Timing = Pick<MapShipment, "departed" | "etd" | "eta" | "last_position" | "status">

/**
 * Not departed: at the origin. Tracked: the last position snapped onto the path. Otherwise the
 * share of the scheduled time that has passed, clamped to 0..1. After the eta: at the destination.
 */
export function estimatePosition(path: Coord[], s: Timing, now: string | Date): Position {
  const t = typeof now === "string" ? time(now) : now.getTime()
  let at: PathPoint
  let basis: Position["basis"]
  if (ARRIVED.has(s.status)) {
    at = pointAlong(path, 1)
    basis = "arrived"
  } else if (!s.departed) {
    at = pointAlong(path, 0)
    basis = "not_departed"
  } else if (s.last_position) {
    at = snapToPath(path, [s.last_position.lon, s.last_position.lat])
    basis = "tracked"
  } else {
    const etd = time(s.etd)
    const eta = time(s.eta)
    if (t !== null && eta !== null && t >= eta) {
      at = pointAlong(path, 1)
      basis = "overdue"
    } else if (t !== null && etd !== null && eta !== null && eta > etd) {
      at = pointAlong(path, (t - etd) / (eta - etd))
      basis = "schedule"
    } else {
      // Departed, but without times we can only say it is on the way.
      at = pointAlong(path, 0.5)
      basis = "unknown"
    }
  }
  const [travelled, remaining] = splitAt(path, at)
  const state: PositionState = at.fraction <= 0 ? "at_origin" : at.fraction >= 1 ? "at_destination" : "moving"
  const tangent = tangentAt(path, at)
  return { point: at.point, fraction: at.fraction, state, basis, travelled, remaining, tangent, heading: bearing(...tangent) }
}

function tangentAt(path: Coord[], at: PathPoint): [Coord, Coord] {
  if (path.length < 2) return [at.point, at.point]
  const i = Math.min(at.index, path.length - 2)
  return [path[i], path[i + 1]]
}
