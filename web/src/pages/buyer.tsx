import { ArrowRight, CircleCheck, Inbox, ListTodo, type LucideIcon } from "lucide-react"
import { Link } from "react-router"
import type { EditionStatus, Overview } from "@shared/api.ts"
import { Page } from "@/components/app-layout"
import { AgentWorkCard } from "@/components/agent-work"
import { PartLink } from "@/components/object-link"
import { SectionTitle } from "@/components/stat"
import { EmptyState, ErrorState } from "@/components/states"
import { SupplyMapPanel } from "@/components/supply-map"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { num } from "@/lib/format"
import { useMap, useOverview, useParts } from "@/lib/queries"
import { cn } from "@/lib/utils"

// The buyer's start page. Top level only: copies per edition, what waits for the buyer, and the map.
// The details sit one click deeper, in parts, approvals and the inbox.

const SEGMENTS = [
  { key: "packed", label: "Packed", color: "bg-foreground" },
  { key: "safe", label: "Safe", color: "bg-neutral-500" },
  { key: "uncertain", label: "Uncertain", color: "bg-uncertain" },
  { key: "lost", label: "Lost", color: "bg-lost" },
] as const

function EditionCard({ edition }: { edition: EditionStatus }) {
  const total = Math.max(edition.demand, edition.packed + edition.safe + edition.uncertain + edition.lost, 1)
  const dayOne = edition.packed + edition.safe
  return (
    <Card className="shadow-none">
      <CardContent className="space-y-4">
        <div>
          <div className="text-sm text-muted-foreground">{edition.name}</div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
            <span className="text-4xl font-semibold tracking-tight tabular-nums">{num(dayOne)}</span>
            <span className="text-sm text-muted-foreground">of {num(edition.demand)} copies make day one</span>
          </div>
        </div>

        <div
          className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full"
          role="img"
          aria-label={SEGMENTS.map((segment) => `${segment.label} ${num(edition[segment.key])}`).join(", ")}
        >
          {SEGMENTS.map((segment) =>
            edition[segment.key] > 0 ? (
              <div
                key={segment.key}
                title={`${segment.label}: ${num(edition[segment.key])}`}
                className={cn("h-full min-w-1", segment.color)}
                style={{ width: `${(edition[segment.key] / total) * 100}%` }}
              />
            ) : null,
          )}
        </div>

        <dl className="grid grid-cols-4 gap-2">
          {SEGMENTS.map((segment) => (
            <div key={segment.key} className="min-w-0">
              <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span aria-hidden className={cn("size-2 shrink-0 rounded-full", segment.color)} />
                <span className="truncate">{segment.label}</span>
              </dt>
              <dd
                className={cn(
                  "mt-0.5 text-sm font-medium tabular-nums",
                  edition[segment.key] === 0 && "text-muted-foreground",
                )}
              >
                {num(edition[segment.key])}
              </dd>
            </div>
          ))}
        </dl>

        <div className="border-t pt-3 text-sm">
          {edition.bottleneck_part_id ? (
            <p className="line-clamp-2">
              <span className="text-muted-foreground">Bottleneck </span>
              <PartLink partId={edition.bottleneck_part_id} className="font-medium" />
              {edition.bottleneck_reason && <span className="text-muted-foreground"> · {edition.bottleneck_reason}</span>}
            </p>
          ) : (
            <p className="text-muted-foreground">No bottleneck.</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

interface TodoItem {
  to: string
  icon: LucideIcon
  count: number
  one: string
  many: string
}

function todos(overview: Overview): TodoItem[] {
  return [
    { to: "/approvals", icon: CircleCheck, count: overview.counts.pending_decisions, one: "decision to approve", many: "decisions to approve" },
    { to: "/inbox?folder=needs_approval", icon: Inbox, count: overview.counts.needs_approval_mails, one: "mail to release", many: "mails to release" },
    { to: "/inbox?folder=tasks", icon: ListTodo, count: overview.counts.open_tasks, one: "open task", many: "open tasks" },
  ]
}

/** What waits for the buyer, as counts with a link each. The lists themselves are one click away. */
function NeedsYou({ overview }: { overview: Overview | undefined }) {
  const items = overview ? todos(overview).filter((item) => item.count > 0) : []
  return (
    <Card className="h-full gap-0 py-0 shadow-none">
      <div className="border-b px-4 py-3 text-sm font-semibold">Needs you</div>
      {!overview ? (
        <div className="space-y-3 p-4">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-5 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">Nothing waits for you.</p>
      ) : (
        <ul className="divide-y">
          {items.map((item) => (
            <li key={item.to}>
              <Link to={item.to} className="group flex items-center gap-3 px-4 py-3 text-sm hover:bg-muted/50">
                <item.icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-semibold tabular-nums">{num(item.count)}</span>{" "}
                  {item.count === 1 ? item.one : item.many}
                </span>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

export function BuyerPage() {
  const { data, isPending } = useOverview()
  const map = useMap()
  const parts = useParts()

  if (!isPending && !data) {
    return (
      <Page>
        <ErrorState what="the overview" />
      </Page>
    )
  }

  return (
    <Page>
      <section aria-label="Editions" className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
        {isPending ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {[0, 1].map((card) => (
              <Skeleton key={card} className="h-56 rounded-xl" />
            ))}
          </div>
        ) : data.editions.length === 0 ? (
          <EmptyState>No editions yet. Run a sync to load them.</EmptyState>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-4">
            {data.editions.map((edition) => (
              <EditionCard key={edition.product_id} edition={edition} />
            ))}
          </div>
        )}
        <NeedsYou overview={data} />
      </section>

      <section aria-label="Agents at work">
        <AgentWorkCard work={data?.agent_work} loading={isPending} />
      </section>

      <section aria-label="Critical supply">
        <SectionTitle
          aside={
            <Link to="/parts" className="hover:text-foreground">
              All parts
            </Link>
          }
        >
          Critical supply
        </SectionTitle>
        <SupplyMapPanel map={map.data} parts={parts.data} variant="buyer" loading={map.isPending || parts.isPending} />
      </section>
    </Page>
  )
}
