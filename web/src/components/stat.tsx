import type { ReactNode } from "react"
import { Link } from "react-router"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

/** One number with a label. The KPI cards at the top of each page. */
export function Stat({
  label,
  value,
  hint,
  dot,
  to,
  loading = false,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  dot?: ReactNode
  /** Makes the whole card a link. */
  to?: string
  loading?: boolean
}) {
  const card = (
    <Card size="sm" className={cn("shadow-none", to && "transition-colors hover:bg-muted/50")}>
      <CardContent className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {dot}
          {label}
        </div>
        {loading ? (
          <Skeleton className="h-7 w-20" />
        ) : (
          <div className="text-2xl leading-7 font-semibold tabular-nums">{value}</div>
        )}
        {hint && !loading && <div className="truncate text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  )
  return to ? (
    <Link to={to} className="rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
      {card}
    </Link>
  ) : (
    card
  )
}

export function StatRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-2 gap-3 lg:grid-cols-4", className)}>{children}</div>
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-4">
      <h2 className="text-sm font-semibold">{children}</h2>
      {aside && <div className="text-xs text-muted-foreground">{aside}</div>}
    </div>
  )
}
