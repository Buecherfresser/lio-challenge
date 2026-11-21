import { Plane, Ship, TrainFront, Truck } from "lucide-react"
import type { TransportMode } from "@shared/api.ts"

export const MODE_LABEL: Record<TransportMode, string> = {
  sea: "Sea",
  air: "Air",
  truck: "Truck",
  rail: "Rail",
  unknown: "Transport",
}

export const MODE_ICON: Record<TransportMode, typeof Plane> = {
  sea: Ship,
  air: Plane,
  truck: Truck,
  rail: TrainFront,
  unknown: Ship,
}
