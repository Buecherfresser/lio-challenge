import { ArrowRight } from "lucide-react"
import { Link } from "react-router"
import type { DecisionCard, EditionStatus, Risk } from "@shared/api.ts"
import { Page } from "@/components/app-layout"
import { PartLink } from "@/components/object-link"
import { SectionTitle, Stat, StatRow } from "@/components/stat"
import { EmptyState, ErrorState } from "@/components/states"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { eur, num, pct } from "@/lib/format"
import { useOverview } from "@/lib/queries"
import { cn } from "@/lib/utils"

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

function DecisionRow({ decision }: { decision: DecisionCard }) {
  return (
    <li>
      <Link to="/approvals" className="group flex items-center gap-4 px-4 py-3 hover:bg-muted/50">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{decision.title}</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {decision.approver.person ?? decision.approver.role} approves
            {!decision.approver.available && " · not available"}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-sm font-medium tabular-nums">{num(decision.copies_saved)} copies</div>
          <div className="text-xs text-muted-foreground tabular-nums">
            {decision.cost_eur === null ? "needs a quote" : eur(decision.cost_eur)}
          </div>
        </div>
        <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </Link>
    </li>
  )
}

function RiskRow({ risk }: { risk: Risk }) {
  return (
    <li className="flex items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{risk.title}</div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {risk.part_id ? <PartLink partId={risk.part_id} /> : "No part"}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-sm font-medium tabular-nums">{num(risk.copies_at_risk)} copies</div>
        <div className="text-xs text-muted-foreground tabular-nums">{pct(risk.probability)} likely</div>
      </div>
    </li>
  )
}

function ListCard({ children }: { children: React.ReactNode }) {
  return (
    <Card className="py-0 shadow-none">
      <ul className="divide-y">{children}</ul>
    </Card>
  )
}

function ListSkeleton() {
  return (
    <Card className="shadow-none">
      <CardContent className="space-y-4">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center justify-between gap-4">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

export function OverviewPage() {
  const { data, isPending } = useOverview()

  if (!isPending && !data) {
    return (
      <Page>
        <ErrorState what="the overview" />
      </Page>
    )
  }

  return (
    <Page>
      <section aria-label="Editions">
        {isPending ? (
          <div className="grid gap-4 lg:grid-cols-3">
            {[0, 1, 2].map((card) => (
              <Skeleton key={card} className="h-56 rounded-xl" />
            ))}
          </div>
        ) : data.editions.length === 0 ? (
          <EmptyState>No editions yet. Run a sync to load them.</EmptyState>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] gap-4">
            {data.editions.map((edition) => (
              <EditionCard key={edition.product_id} edition={edition} />
            ))}
          </div>
        )}
      </section>

      <StatRow>
        <Stat label="Parts at risk" value={data ? num(data.counts.parts_at_risk) : null} to="/parts" loading={isPending} />
        <Stat label="Open questions" value={data ? num(data.counts.open_issues) : null} to="/parts" loading={isPending} />
        <Stat
          label="Open tasks"
          value={data ? num(data.counts.open_tasks) : null}
          to="/inbox?folder=tasks"
          loading={isPending}
        />
        <Stat
          label="Mails waiting for approval"
          value={data ? num(data.counts.needs_approval_mails) : null}
          to="/inbox?folder=needs_approval"
          loading={isPending}
        />
      </StatRow>

      <div className="grid gap-6 xl:grid-cols-2">
        <section>
          <SectionTitle
            aside={
              data && data.open_decisions.length > 0 ? (
                <Link to="/approvals" className="hover:text-foreground">
                  Open approvals
                </Link>
              ) : null
            }
          >
            Decisions waiting for you
          </SectionTitle>
          {isPending ? (
            <ListSkeleton />
          ) : data.open_decisions.length === 0 ? (
            <EmptyState>Nothing needs a decision right now.</EmptyState>
          ) : (
            <ListCard>
              {data.open_decisions.map((decision) => (
                <DecisionRow key={decision.id} decision={decision} />
              ))}
            </ListCard>
          )}
        </section>

        <section>
          <SectionTitle>Top risks</SectionTitle>
          {isPending ? (
            <ListSkeleton />
          ) : data.top_risks.length === 0 ? (
            <EmptyState>No open risks.</EmptyState>
          ) : (
            <ListCard>
              {data.top_risks.map((risk) => (
                <RiskRow key={risk.id} risk={risk} />
              ))}
            </ListCard>
          )}
        </section>
      </div>
    </Page>
  )
}
