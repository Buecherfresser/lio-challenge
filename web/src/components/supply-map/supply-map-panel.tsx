import { useState } from "react"
import type { MapView, PartRow } from "@shared/api.ts"
import { ErrorState } from "@/components/states"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { SupplyMap } from "./supply-map"
import { SupplyPartsList } from "./supply-parts-list"

export interface SupplyMapPanelProps {
  map: MapView | undefined
  parts: PartRow[] | undefined
  variant: "management" | "buyer"
  loading?: boolean
  className?: string
}

/** The map with the parts list beside it (below it on narrow screens). A click on a part focuses the map. */
export function SupplyMapPanel({ map, parts, variant, loading, className }: SupplyMapPanelProps) {
  const [focus, setFocus] = useState<string | null>(null)
  // A focused part that is no longer critical lets go of the focus.
  const focusPartId = focus && parts?.some((p) => p.part_id === focus && p.status !== "ok") ? focus : null

  return (
    <div className={cn("grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[minmax(0,1fr)_17rem]", className)}>
      {loading && !map ? (
        <Skeleton className="aspect-[3/1] w-full rounded-xl" />
      ) : map ? (
        <SupplyMap map={map} focusPartId={focusPartId} variant={variant} />
      ) : (
        <ErrorState what="the map" />
      )}
      <div className="rounded-xl p-1 ring-1 ring-foreground/10">
        {loading && !(map && parts) ? (
          <div className="space-y-2 p-2">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-4/5" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        ) : map && parts ? (
          <SupplyPartsList parts={parts} map={map} focusPartId={focusPartId} onFocus={setFocus} />
        ) : (
          <p className="p-2 text-xs text-muted-foreground">We can't load the parts.</p>
        )}
      </div>
    </div>
  )
}
