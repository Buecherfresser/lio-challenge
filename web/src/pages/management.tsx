import { ArrowRight } from "lucide-react"
import { Link } from "react-router"
import type { EditionStatus, Overview } from "@shared/api.ts"
import { ErrorState } from "@/components/states"
import { SupplyMapPanel } from "@/components/supply-map"
import { Skeleton } from "@/components/ui/skeleton"
import { eur, num, weekdayTime } from "@/lib/format"
import { useMap, useOverview, useParts } from "@/lib/queries"
import { cn } from "@/lib/utils"

// The view for the head of procurement: one number, the map, and a single line when a decision waits.
// Everything else (parts, mails, tasks, the log) lives in the buyer view.

const SHARES = [
  { key: "sure", label: "Safe", color: "bg-foreground" },
  { key: "uncertain", label: "Uncertain", color: "bg-uncertain" },
  { key: "lost", label: "Lost", color: "bg-lost" },
] as const

type Totals = Record<(typeof SHARES)[number]["key"], number> & { demand: number }

/** Packed copies count as safe here: management does not need the difference. */
function totals(editions: EditionStatus[]): Totals {
  const sum = (pick: (edition: EditionStatus) => number) => editions.reduce((total, edition) => total + pick(edition), 0)
  return {
    demand: sum((edition) => edition.demand),
    sure: sum((edition) => edition.packed + edition.safe),
    uncertain: sum((edition) => edition.uncertain),
    lost: sum((edition) => edition.lost),
  }
}

function ShareBar({ values, className }: { values: Totals; className?: string }) {
  const total = Math.max(values.demand, values.sure + values.uncertain + values.lost, 1)
  return (
    <div
      className={cn("flex w-full gap-0.5 overflow-hidden rounded-full bg-muted", className)}
      role="img"
      aria-label={SHARES.map((share) => `${share.label} ${num(values[share.key])}`).join(", ")}
    >
      {SHARES.map((share) =>
        values[share.key] > 0 ? (
          <div
            key={share.key}
            className={cn("h-full min-w-1", share.color)}
            style={{ width: `${(values[share.key] / total) * 100}%` }}
          />
        ) : null,
      )}
    </div>
  )
}

function Headline({ overview }: { overview: Overview }) {
  const all = totals(overview.editions)
  return (
    <section aria-label="Copies for day one" className="min-w-0 flex-1 space-y-4">
      <div>
        <div className="text-sm text-muted-foreground">Copies ready by {weekdayTime(overview.deadline)}</div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3">
          <span className="text-6xl font-semibold tracking-tight tabular-nums md:text-7xl">{num(all.sure)}</span>
          <span className="text-base text-muted-foreground">of {num(all.demand)}</span>
        </div>
      </div>

      <ShareBar values={all} className="h-3 max-w-2xl" />

      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        {SHARES.map((share) => (
          <div key={share.key} className="flex items-center gap-1.5">
            <span aria-hidden className={cn("size-2 rounded-full", share.color)} />
            <dt className="text-muted-foreground">{share.label}</dt>
            <dd className={cn("font-medium tabular-nums", all[share.key] === 0 && "text-muted-foreground")}>
              {num(all[share.key])}
            </dd>
          </div>
        ))}
      </dl>

      {overview.editions.length > 1 && (
        <ul className="grid max-w-2xl gap-2 pt-1 sm:grid-cols-2">
          {overview.editions.map((edition) => {
            const values = totals([edition])
            return (
              <li key={edition.product_id} className="min-w-0 space-y-1.5">
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate text-muted-foreground">{edition.name}</span>
                  <span className="shrink-0 tabular-nums">
                    {num(values.sure)} <span className="text-muted-foreground">of {num(values.demand)}</span>
                  </span>
                </div>
                <ShareBar values={values} className="h-1.5" />
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function DecisionsLine({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <Link
      to="/approvals"
      className="group flex items-center gap-3 self-start rounded-xl border border-decision/30 bg-decision/5 px-4 py-3 text-sm outline-none transition-colors hover:bg-decision/10 focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <span className="flex size-7 items-center justify-center rounded-full bg-decision text-xs font-semibold text-decision-foreground tabular-nums">
        {num(count)}
      </span>
      <span className="font-medium">{count === 1 ? "Decision waits for approval" : "Decisions wait for approval"}</span>
      <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </Link>
  )
}

/** What the lost copies cost as things stand. Shown only when copies are lost and a value per copy is set. */
function MoneyLine({ overview }: { overview: Overview }) {
  if (!overview.value_at_risk_eur) return null
  return (
    <p className="max-w-2xl text-sm">
      <span className="font-semibold tabular-nums">{eur(overview.value_at_risk_eur)}</span>{" "}
      <span className="text-muted-foreground">is what the lost copies cost as things stand.</span>
    </p>
  )
}

export function ManagementPage() {
  const overview = useOverview()
  const map = useMap()
  const parts = useParts()

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-6 p-4 md:p-6">
      {overview.isPending ? (
        <div className="space-y-4">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-16 w-72" />
          <Skeleton className="h-3 w-full max-w-2xl" />
        </div>
      ) : !overview.data ? (
        <ErrorState what="the numbers" />
      ) : overview.data.editions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No editions yet. The first sync loads them.</p>
      ) : (
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0 flex-1 space-y-4">
            <Headline overview={overview.data} />
            <MoneyLine overview={overview.data} />
          </div>
          <DecisionsLine count={overview.data.counts.pending_decisions} />
        </div>
      )}

      <SupplyMapPanel
        map={map.data}
        parts={parts.data}
        variant="management"
        loading={map.isPending || parts.isPending}
      />
    </div>
  )
}
