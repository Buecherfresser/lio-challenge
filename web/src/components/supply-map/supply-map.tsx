import { type CSSProperties, type ReactNode, useMemo, useState } from "react"
import { geoPath } from "d3-geo"
import { X } from "lucide-react"
import type { MapShipment, MapView, TransportMode } from "@shared/api.ts"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { type Coord, type Frame, boxFor, frameFor, toCoord } from "@/lib/geo"
import { cn } from "@/lib/utils"
import { MapLegend } from "./legend"
import { ReplacementCard, ShipmentCard } from "./map-card"
import { MODE_ICON, MODE_LABEL } from "./modes"
import { type DrawnReplacement, type DrawnShipment, buildModel, focusModel } from "./model"
import { useWorld } from "./use-world"

export interface SupplyMapProps {
  map: MapView
  focusPartId?: string | null
  variant: "management" | "buyer"
  className?: string
}

// The dark map palette. Status and decision colours come from the app tokens.
const PALETTE = {
  "--map-sea": "#05080f",
  "--map-land": "#111a30",
  "--map-coast": "#22335a",
  "--map-border": "#1b2745",
  "--map-sea-route": "#98a4ff",
  "--map-air": "#4fd5ef",
  "--map-truck": "#eef2f7",
  "--map-leg": "#677085",
  "--map-hub": "#a5f3fc",
  "--map-lost": "var(--lost)",
  "--map-uncertain": "var(--uncertain)",
  "--map-decision": "color-mix(in oklch, var(--decision), white 30%)",
} as CSSProperties

interface LineStyle {
  stroke: string
  width: number
  dash?: string
}

function lineStyle(mode: TransportMode, kind: "to_port" | "main" | "onward"): LineStyle {
  if (kind === "to_port") return { stroke: "var(--map-leg)", width: 1 }
  if (kind === "onward") return { stroke: "var(--map-truck)", width: 1 }
  switch (mode) {
    case "sea":
      return { stroke: "var(--map-sea-route)", width: 1.5, dash: "4 3" }
    case "air":
      return { stroke: "var(--map-air)", width: 1.5 }
    case "rail":
      return { stroke: "var(--map-truck)", width: 1.5, dash: "6 2" }
    case "truck":
      return { stroke: "var(--map-truck)", width: 1.5 }
    default:
      return { stroke: "var(--map-leg)", width: 1.5, dash: "1 3" }
  }
}

const STATUS_COLOR: Record<MapShipment["status_class"], string> = {
  lost: "var(--map-lost)",
  uncertain: "var(--map-uncertain)",
  safe: "var(--map-truck)",
}

const STATUS_WORD: Record<MapShipment["status_class"], string> = { lost: "lost", uncertain: "early warning", safe: "safe" }

/** A map of the critical supply on its way to the distribution center. Text only in tooltips and the info cards. */
export function SupplyMap({ map, focusPartId, variant, className }: SupplyMapProps) {
  const world = useWorld()
  const model = useMemo(() => buildModel(map), [map])
  // The frame holds everything critical, so focusing a part does not move the map.
  const frame = useMemo(() => frameFor(boxFor(model.extent)), [model.extent])
  const view = useMemo(() => focusModel(model, focusPartId), [model, focusPartId])
  const [selected, setSelected] = useState<string | null>(null)

  const path = useMemo(() => geoPath(frame.projection), [frame])
  const line = (coords: Coord[]) => path({ type: "LineString", coordinates: coords }) ?? undefined
  const land = useMemo(
    () => (world ? { fill: path(world.land), coast: path(world.coast), borders: path(world.borders) } : null),
    [world, path],
  )

  const [x, y, w, h] = frame.viewBox
  const dimmed = (key: string) => selected !== null && selected !== key
  const empty = view.shipments.length === 0 && view.replacements.length === 0
  const ports = useMemo(() => portsOf(view.shipments), [view.shipments])

  return (
    <div
      className={cn("relative overflow-hidden rounded-xl bg-(--map-sea) text-slate-300", className)}
      style={PALETTE}
    >
      <div className="relative">
        <svg
          viewBox={`${x} ${y} ${w} ${h}`}
          className="block h-auto w-full"
          style={{ aspectRatio: `${w} / ${h}` }}
          role="img"
          aria-label={`Map of critical supply on its way to ${map.hub.name}`}
        >
          {land && (
            <g>
              <path d={land.fill ?? undefined} fill="var(--map-land)" />
              <path d={land.borders ?? undefined} fill="none" stroke="var(--map-border)" strokeWidth={0.6} vectorEffect="non-scaling-stroke" />
              <path d={land.coast ?? undefined} fill="none" stroke="var(--map-coast)" strokeWidth={0.7} vectorEffect="non-scaling-stroke" />
            </g>
          )}

          {/* Routes of the shipments: to port in grey, the main leg by mode, the onward leg in white. */}
          {view.shipments.map((d) => (
            <g key={d.key} opacity={dimmed(d.key) ? 0.3 : 1}>
              {d.route.legs.map((leg) => {
                const style = lineStyle(leg.mode, leg.kind)
                const stroke = d.shipment.disrupted ? "var(--map-lost)" : style.stroke
                const props = {
                  fill: "none",
                  stroke,
                  strokeWidth: style.width,
                  strokeDasharray: style.dash,
                  strokeLinecap: "round" as const,
                  strokeLinejoin: "round" as const,
                  vectorEffect: "non-scaling-stroke",
                }
                if (leg.kind !== "main") {
                  const done = leg.kind === "to_port" && d.shipment.departed
                  return <path key={leg.kind} d={line(leg.path)} {...props} opacity={d.shipment.disrupted ? 0.4 : done ? 0.45 : 0.7} />
                }
                return (
                  <g key={leg.kind}>
                    {!d.shipment.disrupted && (
                      <path d={line(d.position.remaining)} {...props} strokeDasharray={undefined} strokeWidth={5} opacity={0.08} />
                    )}
                    <path d={line(d.position.travelled)} {...props} opacity={d.shipment.disrupted ? 0.3 : 0.35} />
                    <path d={line(d.position.remaining)} {...props} opacity={d.shipment.disrupted ? 0.55 : 0.95} />
                  </g>
                )
              })}
            </g>
          ))}

          {/* Replacement routes: dashed while proposed, solid once approved. */}
          {view.replacements.map((r) => (
            <g key={r.key} opacity={dimmed(r.key) ? 0.3 : 1}>
              <path
                d={line(r.path)}
                fill="none"
                stroke="var(--map-decision)"
                strokeWidth={6}
                opacity={0.12}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={line(r.path)}
                fill="none"
                stroke="var(--map-decision)"
                strokeWidth={r.replacement.status === "approved" ? 2 : 1.75}
                strokeDasharray={r.replacement.status === "approved" ? undefined : "6 4"}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}

          {/* Ports and airports: small grey dots (a zero-length line with round caps keeps its size at any scale). */}
          {ports.map((p) => {
            const xy = frame.projection(p)
            return xy ? (
              <path
                key={`${p[0]},${p[1]}`}
                d={`M${xy[0]},${xy[1]}h0`}
                stroke="var(--map-leg)"
                strokeWidth={4}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ) : null
          })}
        </svg>

        {/* Markers are HTML over the SVG, so they keep their size and can carry tooltips and cards. */}
        <div className="absolute inset-0">
          {view.suppliers.map((s) => (
            <Marker key={s.supplier_id} frame={frame} at={toCoord(s.point)}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    tabIndex={0}
                    role="img"
                    aria-label={`Supplier ${s.name}`}
                    className="block size-2 rounded-full bg-white shadow-[0_0_0_2px_var(--map-sea)] outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                  />
                </TooltipTrigger>
                <TooltipContent>{s.name}</TooltipContent>
              </Tooltip>
            </Marker>
          ))}

          <Marker frame={frame} at={toCoord(map.hub)}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  role="img"
                  aria-label={map.hub.name}
                  className="grid size-4 place-items-center rounded-full border-2 border-(--map-hub) shadow-[0_0_10px_3px_color-mix(in_oklch,var(--map-hub),transparent_45%)] outline-none"
                >
                  <span className="size-1 rounded-full bg-(--map-hub)" />
                </span>
              </TooltipTrigger>
              <TooltipContent>{map.hub.name}</TooltipContent>
            </Tooltip>
          </Marker>

          {view.shipments.map(
            (d) =>
              d.cross && (
                <Marker key={`${d.key}:cross`} frame={frame} at={d.cross}>
                  <span
                    aria-hidden
                    className="grid size-4 place-items-center rounded-full bg-(--map-sea) text-(--map-lost) ring-1 ring-(--map-lost)"
                  >
                    <X className="size-3" strokeWidth={3} />
                  </span>
                </Marker>
              ),
          )}

          {view.replacements.map((r) => (
            <ReplacementMarker
              key={r.key}
              frame={frame}
              drawn={r}
              open={selected === r.key}
              onOpenChange={(open) => setSelected(open ? r.key : null)}
            />
          ))}

          {view.shipments.map((d) => (
            <VehicleMarker
              key={d.key}
              frame={frame}
              drawn={d}
              variant={variant}
              open={selected === d.key}
              onOpenChange={(open) => setSelected(open ? d.key : null)}
            />
          ))}
        </div>

        {empty && (
          <p className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-xs text-slate-400">
            {focusPartId ? "Nothing on the way for this part" : "Nothing critical on the way"}
          </p>
        )}
      </div>
      <MapLegend />
    </div>
  )
}

/** Origins, stopovers and destinations of the drawn shipments, without the supplier sites and the hub. */
function portsOf(shipments: DrawnShipment[]): Coord[] {
  const seen = new Map<string, Coord>()
  for (const { shipment: s } of shipments) {
    for (const p of [s.origin, ...s.via, s.destination]) {
      if (!p || p.kind === "supplier" || p.kind === "hub") continue
      seen.set(`${p.lon},${p.lat}`, toCoord(p))
    }
    if (s.pickup && s.pickup.kind === "site") seen.set(`${s.pickup.lon},${s.pickup.lat}`, toCoord(s.pickup))
  }
  return [...seen.values()]
}

function Marker({ frame, at, children, className }: { frame: Frame; at: Coord; children: ReactNode; className?: string }) {
  const rel = frame.relative(at)
  if (!rel) return null
  return (
    <div
      className={cn("absolute -translate-x-1/2 -translate-y-1/2", className)}
      style={{ left: `${rel[0] * 100}%`, top: `${rel[1] * 100}%` }}
    >
      {children}
    </div>
  )
}

/** Screen angle of the path at the vehicle, degrees clockwise from east. */
function screenAngle(frame: Frame, [a, b]: [Coord, Coord]): number {
  const pa = frame.projection(a)
  const pb = frame.projection(b)
  if (!pa || !pb) return 0
  return (Math.atan2(pb[1] - pa[1], pb[0] - pa[0]) * 180) / Math.PI
}

const chip =
  "grid size-5 place-items-center sm:size-6 rounded-full outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-white/70 data-[state=open]:scale-110"

function VehicleMarker({
  frame,
  drawn,
  variant,
  open,
  onOpenChange,
}: {
  frame: Frame
  drawn: DrawnShipment
  variant: "management" | "buyer"
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const s = drawn.shipment
  const Icon = MODE_ICON[s.mode]
  const angle = screenAngle(frame, drawn.position.tangent)
  // Lucide's plane points up and to the right; the truck faces right. Ships stay upright.
  const transform =
    s.mode === "air" ? `rotate(${angle + 45}deg)` : s.mode === "truck" && Math.abs(angle) > 90 ? "scaleX(-1)" : undefined
  const color = STATUS_COLOR[s.status_class]
  const names = s.parts.map((p) => p.description).join(", ")
  return (
    <Marker frame={frame} at={drawn.position.point} className={open ? "z-20" : "z-10"}>
      <Popover open={open} onOpenChange={onOpenChange}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={`${MODE_LABEL[s.mode]} shipment ${s.shipment_id}: ${names}, ${STATUS_WORD[s.status_class]}`}
                className={chip}
                style={{
                  color,
                  background: "var(--map-sea)",
                  boxShadow: `0 0 0 1.5px ${color}, 0 0 12px 1px color-mix(in oklch, ${color}, transparent 55%)`,
                }}
              >
                <Icon className="size-3 sm:size-3.5" strokeWidth={2.25} style={{ transform }} />
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>
            {s.supplier?.name ?? MODE_LABEL[s.mode]} · {names}
          </TooltipContent>
        </Tooltip>
        <PopoverContent className="w-60" side="top" collisionPadding={8}>
          <ShipmentCard shipment={s} variant={variant} />
        </PopoverContent>
      </Popover>
    </Marker>
  )
}

function ReplacementMarker({
  frame,
  drawn,
  open,
  onOpenChange,
}: {
  frame: Frame
  drawn: DrawnReplacement
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const r = drawn.replacement
  const Icon = MODE_ICON[r.mode]
  const approved = r.status === "approved"
  const n = drawn.path.length
  const i = Math.max(0, Math.min(n - 2, Math.floor(n / 2)))
  const angle = n > 1 ? screenAngle(frame, [drawn.path[i], drawn.path[i + 1]]) : 0
  return (
    <Marker frame={frame} at={drawn.marker} className={open ? "z-20" : "z-10"}>
      <Popover open={open} onOpenChange={onOpenChange}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={`${approved ? "Approved" : "Proposed"} replacement: ${r.title}`}
                className={cn(
                  chip,
                  approved
                    ? "bg-(--map-decision) text-white"
                    : "border-[1.5px] border-dashed border-(--map-decision) bg-(--map-sea) text-(--map-decision)",
                )}
              >
                <Icon
                  className="size-3 sm:size-3.5"
                  strokeWidth={2.25}
                  style={{ transform: r.mode === "air" ? `rotate(${angle + 45}deg)` : undefined }}
                />
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{r.title}</TooltipContent>
        </Tooltip>
        <PopoverContent className="w-60" side="top" collisionPadding={8}>
          <ReplacementCard replacement={r} />
        </PopoverContent>
      </Popover>
    </Marker>
  )
}
