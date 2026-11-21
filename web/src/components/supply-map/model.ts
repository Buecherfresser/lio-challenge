import type { MapReplacement, MapShipment, MapView } from "@shared/api.ts"
import {
  type Coord,
  type Position,
  type ShipmentRoute,
  estimatePosition,
  pointAlong,
  replacementRoute,
  shipmentRoute,
  toCoord,
} from "@/lib/geo"

// What the map draws, worked out from MapView: only critical shipments, their suppliers, the hub,
// and the replacement routes of disrupted shipments.

export interface DrawnShipment {
  key: string
  shipment: MapShipment
  route: ShipmentRoute
  position: Position
  /** Where the strike-through mark goes on a disrupted route: halfway along what is still ahead. */
  cross: Coord | null
}

export interface DrawnReplacement {
  key: string
  replacement: MapReplacement
  path: Coord[]
  /** Where its marker sits: halfway along the route. */
  marker: Coord
}

export interface MapModel {
  shipments: DrawnShipment[]
  replacements: DrawnReplacement[]
  suppliers: MapView["suppliers"]
  /** Every coordinate drawn, to fit the frame. */
  extent: Coord[]
}

export function buildModel(map: MapView): MapModel {
  const hub = toCoord(map.hub)
  const supplierPoint = new Map(map.suppliers.map((s) => [s.supplier_id, toCoord(s.point)]))

  const shipments: DrawnShipment[] = []
  for (const s of map.shipments) {
    if (!s.critical) continue
    const start = s.supplier ? (supplierPoint.get(s.supplier.supplier_id) ?? null) : null
    const route = shipmentRoute(s, { start, end: hub })
    if (!route) continue
    const position = estimatePosition(route.main, s, map.now)
    const cross = s.disrupted ? pointAlong(position.remaining, 0.5).point : null
    shipments.push({ key: `shipment:${s.shipment_id}`, shipment: s, route, position, cross })
  }

  // Replacements belong to a disrupted shipment, by id or by the part it carries. Rejected ones are not drawn.
  const disrupted = shipments.filter((d) => d.shipment.disrupted)
  const disruptedIds = new Set(disrupted.map((d) => d.shipment.shipment_id))
  const disruptedParts = new Set(disrupted.flatMap((d) => d.shipment.parts.map((p) => p.part_id)))
  const replacements: DrawnReplacement[] = []
  for (const r of map.replacements) {
    if (r.status === "rejected") continue
    const linked =
      (r.replaces_shipment_id !== null && disruptedIds.has(r.replaces_shipment_id)) ||
      (r.part_id !== null && disruptedParts.has(r.part_id))
    if (!linked) continue
    const path = replacementRoute(r)
    replacements.push({ key: `replacement:${r.decision_id}`, replacement: r, path, marker: pointAlong(path, 0.5).point })
  }

  // Suppliers of the parts in trouble, and of every drawn shipment.
  const partIds = new Set(
    shipments.flatMap((d) => d.shipment.parts.filter((p) => p.status !== "ok").map((p) => p.part_id)),
  )
  const supplierIds = new Set(shipments.map((d) => d.shipment.supplier?.supplier_id).filter(Boolean))
  const suppliers = map.suppliers.filter(
    (s) => supplierIds.has(s.supplier_id) || s.status !== "ok" || s.part_ids.some((id) => partIds.has(id)),
  )

  const extent: Coord[] = [
    hub,
    ...suppliers.map((s) => toCoord(s.point)),
    ...shipments.flatMap((d) => d.route.legs.flatMap((l) => l.path)),
    ...replacements.flatMap((r) => r.path),
  ]
  return { shipments, replacements, suppliers, extent }
}

/** The model narrowed to one part. The frame stays the same, so the map does not jump. */
export function focusModel(model: MapModel, partId: string | null | undefined): MapModel {
  if (!partId) return model
  const shipments = model.shipments.filter((d) => d.shipment.parts.some((p) => p.part_id === partId))
  const ids = new Set(shipments.map((d) => d.shipment.shipment_id))
  const replacements = model.replacements.filter(
    (r) => r.replacement.part_id === partId || (r.replacement.replaces_shipment_id !== null && ids.has(r.replacement.replaces_shipment_id)),
  )
  const supplierIds = new Set(shipments.map((d) => d.shipment.supplier?.supplier_id))
  const suppliers = model.suppliers.filter((s) => s.part_ids.includes(partId) || supplierIds.has(s.supplier_id))
  return { ...model, shipments, replacements, suppliers }
}
