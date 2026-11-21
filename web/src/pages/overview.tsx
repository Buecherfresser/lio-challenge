import { ArrowRight } from "lucide-react"
import { useMemo } from "react"
import { Link, useSearchParams } from "react-router"
import type { EditionStatus, PartRow } from "@shared/api.ts"
import { Page } from "@/components/app-layout"
import { ObjectLink } from "@/components/object-link"
import { ItemSheet, QueueRow } from "@/components/queue"
import { ErrorState } from "@/components/states"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { shortEdition } from "@/lib/decisions"
import { num } from "@/lib/format"
import { byDeadline, useQueue } from "@/lib/queue"
import { useOverview, useParts } from "@/lib/queries"
import { cn } from "@/lib/utils"

// The buyer's start page shows only what is urgent: what is due in the next hours, and one number per edition.
// Everything else is one link away: the whole to-do list, the parts, and what the agents handle on their own.
// "Urgent" is measured against the server clock, so the page also reads right when it shows an earlier time.

/** What counts as due soon on the start page. Everything later waits on the To do page. */
const URGENT_WITHIN_MS = 24 * 3600000

const SEGMENTS = [
  { key: "packed", label: "Packed", color: "bg-foreground" },
  { key: "safe", label: "Safe", color: "bg-neutral-400" },
  { key: "uncertain", label: "Uncertain", color: "bg-uncertain" },
  { key: "lost", label: "Lost", color: "bg-lost" },
] as const

function Bar({ edition, className }: { edition: EditionStatus; className?: string }) {
  const total = Math.max(edition.demand, edition.packed + edition.safe + edition.uncertain + edition.lost, 1)
  return (
    <div className={cn("flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-muted", className)} aria-hidden>
      {SEGMENTS.map((segment) =>
        edition[segment.key] > 0 ? (
          <div
            key={segment.key}
            className={cn("h-full", segment.color)}
            style={{ width: `${(edition[segment.key] / total) * 100}%` }}
          />
        ) : null,
      )}
    </div>
  )
}

/** One number and a bar. A click shows the breakdown and the bottleneck. */
function EditionTile({ edition, parts }: { edition: EditionStatus; parts: Map<string, PartRow> }) {
  const dayOne = edition.packed + edition.safe
  const bottleneck = edition.bottleneck_part_id ? parts.get(edition.bottleneck_part_id) : undefined
  const note =
    edition.lost > 0
      ? `${num(edition.lost)} lost`
      : edition.uncertain > 0
        ? `${num(edition.uncertain)} uncertain`
        : "on track"
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="rounded-xl border px-5 py-4 text-left outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="font-medium">{shortEdition(edition.name)}</span>
            <span className="text-muted-foreground tabular-nums">{note}</span>
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-3xl font-semibold tracking-tight tabular-nums">{num(dayOne)}</span>
            <span className="text-sm text-muted-foreground tabular-nums">/ {num(edition.demand)}</span>
          </div>
          <Bar edition={edition} className="mt-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-3">
        <div>
          <div className="font-medium">{edition.name}</div>
          <div className="text-xs text-muted-foreground">
            {num(dayOne)} of {num(edition.demand)} copies make day one
          </div>
        </div>
        <dl className="space-y-1">
          {SEGMENTS.map((segment) => (
            <div key={segment.key} className="flex items-center gap-2">
              <span aria-hidden className={cn("size-2 rounded-full", segment.color)} />
              <dt className="flex-1 text-muted-foreground">{segment.label}</dt>
              <dd className="tabular-nums">{num(edition[segment.key])}</dd>
            </div>
          ))}
        </dl>
        {edition.bottleneck_part_id && (
          <div className="border-t pt-3">
            <div className="text-xs text-muted-foreground">Bottleneck</div>
            <ObjectLink
              object={{ type: "part", id: edition.bottleneck_part_id, label: bottleneck?.description }}
              className="font-medium"
            />
            {bottleneck && (
              <div className="text-xs text-muted-foreground tabular-nums">
                {num(bottleneck.available_safe)} safe of {num(bottleneck.need)} needed
              </div>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** One quiet line that leads to a subpage. */
function MoreLink({ to, label, detail }: { to: string; label: string; detail: string }) {
  return (
    <Link
      to={to}
      className="group flex items-center gap-3 rounded-xl border px-4 py-3 text-sm outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{label}</span>
        <span className="block truncate text-muted-foreground">{detail}</span>
      </span>
      <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </Link>
  )
}

const plural = (n: number, one: string, many: string) => `${num(n)} ${n === 1 ? one : many}`

export function OverviewPage() {
  const overview = useOverview()
  const parts = useParts()
  const { queue, threadById, productNames, now, loading } = useQueue()
  const [searchParams, setSearchParams] = useSearchParams()
  const openKey = searchParams.get("item")

  const partById = useMemo(() => new Map((parts.data ?? []).map((p) => [p.part_id, p])), [parts.data])
  const open = queue.filter((item) => !item.done)
  const urgent = now
    ? open
        .filter((item) => item.due && new Date(item.due).getTime() - new Date(now).getTime() < URGENT_WITHIN_MS)
        .sort(byDeadline)
    : []
  const openItem = queue.find((item) => item.key === openKey)

  const decisions = open.filter((item) => item.kind === "decision").length
  const lostParts = (parts.data ?? []).filter((part) => part.status === "lost").length
  const uncertainParts = (parts.data ?? []).filter((part) => part.status === "uncertain").length
  const agentWork = (overview.data?.agent_work ?? []).filter((item) => item.state !== "waiting_person").length

  function setItem(key: string | null) {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous)
        if (key) next.set("item", key)
        else next.delete("item")
        return next
      },
      { replace: true },
    )
  }

  return (
    <Page>
      <div className="mx-auto max-w-5xl space-y-8">
        <section aria-label="Due soon" className="space-y-3">
          <h2 className="text-base font-semibold">Due soon</h2>
          {loading || !now ? (
            <Skeleton className="h-24 w-full rounded-xl" />
          ) : urgent.length === 0 ? (
            <p className="rounded-xl border px-4 py-3 text-sm text-muted-foreground">
              Nothing is due in the next 24 hours.
            </p>
          ) : (
            <ul className="divide-y rounded-xl border">
              {urgent.map((item) => (
                <QueueRow key={item.key} item={item} now={now} onOpen={() => setItem(item.key)} />
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Editions" className="grid gap-4 sm:grid-cols-2">
          {overview.isPending ? (
            [0, 1].map((card) => <Skeleton key={card} className="h-28 rounded-xl" />)
          ) : !overview.data ? (
            <ErrorState what="the editions" className="sm:col-span-2" />
          ) : (
            overview.data.editions.map((edition) => (
              <EditionTile key={edition.product_id} edition={edition} parts={partById} />
            ))
          )}
        </section>

        <section aria-label="More" className="grid gap-3 sm:grid-cols-3">
          <MoreLink
            to="/todo"
            label="To do"
            detail={`${plural(open.length, "open item", "open items")}, ${plural(decisions, "decision", "decisions")}`}
          />
          <MoreLink
            to="/parts"
            label="Supply"
            detail={
              lostParts + uncertainParts > 0
                ? `${num(lostParts)} parts lost, ${num(uncertainParts)} uncertain`
                : "Every part is covered"
            }
          />
          <MoreLink
            to="/log?actor=action_agent"
            label="Agents"
            detail={agentWork > 0 ? `${plural(agentWork, "risk", "risks")} handled on their own` : "Nothing in hand"}
          />
        </section>
      </div>

      <ItemSheet
        item={openItem}
        now={now}
        onClose={() => setItem(null)}
        productNames={productNames}
        threadTitle={openItem?.message ? threadById.get(openItem.message.thread_id)?.title : undefined}
      />
    </Page>
  )
}
