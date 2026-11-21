import type { ReactNode } from "react"
import { X } from "lucide-react"

// Line styles and marks of the map, a word each.

function Swatch({ stroke, dash, width = 1.5 }: { stroke: string; dash?: string; width?: number }) {
  return (
    <svg aria-hidden width="18" height="6" className="shrink-0">
      <line x1="1" y1="3" x2="17" y2="3" stroke={stroke} strokeWidth={width} strokeDasharray={dash} strokeLinecap="round" />
    </svg>
  )
}

function Item({ mark, children }: { mark: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-1.5">
      {mark}
      {children}
    </li>
  )
}

export function MapLegend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/5 px-3 py-2 text-[11px] text-slate-400">
      <Item mark={<Swatch stroke="var(--map-sea-route)" dash="4 3" />}>Sea</Item>
      <Item mark={<Swatch stroke="var(--map-air)" />}>Air</Item>
      <Item mark={<Swatch stroke="var(--map-truck)" />}>Truck</Item>
      <Item mark={<Swatch stroke="var(--map-leg)" width={1} />}>To port</Item>
      <Item mark={<span className="size-2 rounded-full bg-(--map-uncertain)" />}>Uncertain</Item>
      <Item mark={<span className="size-2 rounded-full bg-(--map-lost)" />}>Lost</Item>
      <Item mark={<X className="size-3 text-(--map-lost)" strokeWidth={3} />}>Disrupted</Item>
      <Item mark={<Swatch stroke="var(--map-decision)" dash="5 3" width={1.75} />}>Proposed</Item>
      <Item mark={<Swatch stroke="var(--map-decision)" width={2} />}>Approved</Item>
    </ul>
  )
}
