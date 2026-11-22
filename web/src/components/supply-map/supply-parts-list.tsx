import { useMemo } from "react"
import { Check, ChevronDown, CircleCheck } from "lucide-react"
import type { MapView, PartRow, TransportMode } from "@shared/api.ts"
import { StatusDot } from "@/components/status"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { MODE_ICON } from "./modes"

export interface SupplyPartsListProps {
  parts: PartRow[]
  map: MapView
  focusPartId: string | null
  onFocus: (id: string | null) => void
}

const RANK = { lost: 0, uncertain: 1, ok: 2 } as const
const WORD = { lost: "Lost", uncertain: "Early warning", ok: "On track" } as const

/** Beside the map: the critical parts as focus buttons, the fine ones folded into one line. */
export function SupplyPartsList({ parts, map, focusPartId, onFocus }: SupplyPartsListProps) {
  const critical = useMemo(
    () => parts.filter((p) => p.status !== "ok").sort((a, b) => RANK[a.status] - RANK[b.status] || b.gap - a.gap),
    [parts],
  )
  const fine = useMemo(() => parts.filter((p) => p.status === "ok"), [parts])

  // How each critical part travels, for the small mode icons.
  const modes = useMemo(() => {
    const out = new Map<string, Set<TransportMode>>()
    for (const s of map.shipments) {
      if (!s.critical) continue
      for (const p of s.parts) {
        if (!out.has(p.part_id)) out.set(p.part_id, new Set())
        out.get(p.part_id)!.add(s.mode)
      }
    }
    return out
  }, [map.shipments])

  return (
    <div className="flex flex-col gap-3">
      {critical.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {critical.map((p) => {
            const active = focusPartId === p.part_id
            return (
              <li key={p.part_id}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => onFocus(active ? null : p.part_id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted",
                    active && "bg-muted ring-1 ring-foreground/10",
                  )}
                >
                  <span aria-hidden className="flex">
                    <StatusDot level={p.status} />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">{p.description}</span>
                  <span aria-hidden className="flex items-center gap-1 text-muted-foreground">
                    {[...(modes.get(p.part_id) ?? [])].map((mode) => {
                      const Icon = MODE_ICON[mode]
                      return <Icon key={mode} className="size-3.5" />
                    })}
                  </span>
                  <span className={cn("w-16 text-right text-xs", p.status === "lost" ? "text-lost" : "text-muted-foreground")}>
                    {WORD[p.status]}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="flex items-center gap-2 px-2 text-sm text-muted-foreground">
          <CircleCheck className="size-4" />
          Nothing critical
        </p>
      )}

      {fine.length > 0 && (
        <Collapsible className="border-t pt-2">
          <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground">
            <CircleCheck className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {fine.map((p) => p.description).join(", ")} on track
            </span>
            <ChevronDown className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-1 flex flex-col gap-1 px-2 pb-1 text-xs text-muted-foreground">
              {fine.map((p) => (
                <li key={p.part_id} className="flex items-center gap-2">
                  <Check className="size-3 shrink-0" />
                  <span className="truncate">{p.description}</span>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}
