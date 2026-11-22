import { ChevronRight } from "lucide-react"
import { Fragment, type ReactNode } from "react"
import type { Issue, IssueStatus, IssueType, PartDetail, PartSourceLine } from "@shared/api.ts"
import { Fold } from "@/components/decision"
import { FactSources } from "@/components/fact-source"
import { ObjectLink } from "@/components/object-link"
import { RiskDetails } from "@/components/risk-details"
import { EmptyState, ErrorState } from "@/components/states"
import { StatusBadge, StatusDot } from "@/components/status"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { ACTOR_LABEL, dateTime, num } from "@/lib/format"
import { usePart } from "@/lib/queries"
import { cn } from "@/lib/utils"

const ISSUE_TYPE_LABEL: Record<IssueType, string> = {
  quantity: "Quantity",
  date_eta: "Arrival date",
  price: "Price",
  tracking_stale: "Tracking",
  source_conflict: "Sources disagree",
  quality_hold: "Quality hold",
  supplier_notice: "Supplier notice",
  other: "Other",
}

const ISSUE_STATUS_LABEL: Record<IssueStatus, string> = {
  open: "Open",
  asked: "Asked",
  answered: "Answered",
  resolved: "Resolved",
}

// These count every open order of the part, also deliveries promised after the launch, so they can be far above the need.
const PIPELINE: { key: "ordered" | "confirmed" | "shipped" | "in_transit" | "arrived" | "usable"; label: string; hint: string }[] = [
  { key: "ordered", label: "Ordered", hint: "Open order quantity, all open orders" },
  { key: "confirmed", label: "Confirmed", hint: "Confirmed by the supplier" },
  { key: "shipped", label: "Shipped", hint: "The supplier says it left" },
  { key: "in_transit", label: "In transit", hint: "On a shipment that has not been received" },
  { key: "arrived", label: "Arrived", hint: "Received at the distribution center for the open orders" },
  { key: "usable", label: "Usable", hint: "In stock and not blocked" },
]

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        {title}
        {count !== undefined && count > 0 && (
          <span className="text-xs font-normal text-muted-foreground tabular-nums">{count}</span>
        )}
      </h3>
      {children}
    </section>
  )
}

/** The documents behind a line, folded: "3 documents" opens the file names, quotes and how sure the reading is. */
function Evidence({ factIds, part, showValue = false }: { factIds: number[]; part: PartDetail; showValue?: boolean }) {
  const files = new Set(factIds.map((id) => part.facts.find((fact) => fact.id === id)?.source_path).filter(Boolean))
  const n = files.size || factIds.length
  return (
    <details className="group mt-1 pl-4 text-xs text-muted-foreground">
      <summary className="cursor-pointer list-none select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight className="mr-0.5 inline size-3 transition-transform group-open:rotate-90" />
        {n} {n === 1 ? "document" : "documents"}
      </summary>
      <FactSources factIds={factIds} facts={part.facts} showValue={showValue} className="mt-1" />
    </details>
  )
}

function SourceLine({ line, part }: { line: PartSourceLine; part: PartDetail }) {
  return (
    <li className="px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <StatusDot level={line.confidence} className="translate-y-[-1px]" />
        <span className="text-sm font-medium">{line.label}</span>
        <span className="ml-auto text-sm font-medium tabular-nums">
          {line.quantity === null ? "" : num(line.quantity)}
        </span>
      </div>
      <div className="mt-0.5 pl-4 text-sm text-muted-foreground">
        {line.detail}
        {line.when && <span> · {dateTime(line.when)}</span>}
        {line.object && (
          <span>
            {" "}
            · <ObjectLink object={line.object} />
          </span>
        )}
      </div>
      {line.fact_ids.length > 0 && <Evidence factIds={line.fact_ids} part={part} />}
    </li>
  )
}

function IssueItem({ issue, part }: { issue: Issue; part: PartDetail }) {
  return (
    <li className={cn("space-y-2 px-3 py-2.5", issue.status === "resolved" && "opacity-60")}>
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm font-medium">{issue.title}</div>
        <span className="shrink-0 rounded-full border px-2 text-xs leading-5 text-muted-foreground">
          {ISSUE_TYPE_LABEL[issue.type]} · {ISSUE_STATUS_LABEL[issue.status]}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">{issue.detail}</p>
      {(issue.expected !== null || issue.actual !== null) && (
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-md border px-2 py-1.5">
            <dt className="text-xs text-muted-foreground">Expected</dt>
            <dd className="font-medium">{issue.expected ?? "n/a"}</dd>
          </div>
          <div className="rounded-md border px-2 py-1.5">
            <dt className="text-xs text-muted-foreground">Actual</dt>
            <dd className="font-medium">{issue.actual ?? "n/a"}</dd>
          </div>
        </dl>
      )}
      {issue.question && (
        <p className="text-sm">
          <span className="text-muted-foreground">
            {issue.addressee === "internal"
              ? `Question for ${issue.assignee_role ?? "the team"}: `
              : issue.addressee === "supplier"
                ? "Question for the supplier: "
                : "Open question: "}
          </span>
          {issue.question}
        </p>
      )}
      <div className="text-xs text-muted-foreground">
        <ObjectLink object={issue.object} /> · since {dateTime(issue.created_at)}
      </div>
      {issue.fact_ids.length > 0 && <Evidence factIds={issue.fact_ids} part={part} showValue />}
    </li>
  )
}

/**
 * The one question for a part: is there enough of it by the deadline? A bar against the need, split into what is
 * safe, what carries an early warning (may still come, not confirmed) and the gap, with one sentence that says it.
 */
function Coverage({ part }: { part: PartDetail }) {
  const need = Math.max(part.need, 0)
  const safe = Math.min(part.available_safe, need)
  const warning = Math.min(part.available_uncertain, need - safe)
  const gap = Math.max(need - safe - warning, 0)
  const share = (n: number) => `${need > 0 ? (n / need) * 100 : 0}%`
  const verdict =
    need === 0
      ? "Nothing more is needed before the deadline."
      : gap > 0
        ? `${num(gap)} of ${num(need)} cannot arrive in time as things stand.`
        : warning > 0
          ? `${num(safe)} of ${num(need)} are safe. The other ${num(warning)} depend on supply that is not confirmed yet.`
          : `All ${num(need)} are safe.`
  const rows = [
    { level: "safe" as const, label: "Safe", value: safe, text: "In the building and usable" },
    {
      level: "uncertain" as const,
      label: "Early warning",
      value: warning,
      text:
        part.available_uncertain > warning
          ? `May still come in time but is not confirmed (${num(part.available_uncertain)} on the way, ${num(warning)} needed)`
          : "May still come in time but is not confirmed",
    },
    { level: "lost" as const, label: "Gap", value: gap, text: "Cannot arrive before the deadline" },
  ]
  return (
    <div className="space-y-3 rounded-lg border px-4 py-3.5">
      <div>
        <div className="text-xs text-muted-foreground">Needed until the deadline: {num(need)}</div>
        <p className="mt-0.5 text-base font-semibold">{verdict}</p>
      </div>
      {need > 0 && (
        <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-muted" aria-hidden>
          {safe > 0 && <div className="h-full bg-foreground" style={{ width: share(safe) }} />}
          {warning > 0 && <div className="h-full bg-uncertain" style={{ width: share(warning) }} />}
          {gap > 0 && <div className="h-full bg-lost" style={{ width: share(gap) }} />}
        </div>
      )}
      <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3">
        {rows.map((row) => (
          <div key={row.label} className="min-w-0">
            <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <StatusDot level={row.level} className="size-1.5" />
              {row.label}
            </dt>
            <dd className={cn("font-semibold tabular-nums", row.value === 0 && "text-muted-foreground")}>{num(row.value)}</dd>
            <dd className="text-xs text-muted-foreground">{row.text}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function Body({ part }: { part: PartDetail }) {
  return (
    <div className="space-y-6 px-6 pb-8">
      <Coverage part={part} />

      <Section title="Sources" count={part.sources.length}>
        {part.sources.length === 0 ? (
          <EmptyState className="min-h-0 py-4">No sources for this part yet.</EmptyState>
        ) : (
          <ul className="divide-y rounded-lg border">
            {part.sources.map((line, index) => (
              <SourceLine key={index} line={line} part={part} />
            ))}
          </ul>
        )}
      </Section>

      <Section title="Contradictions and open questions" count={part.issues.length}>
        {part.issues.length === 0 ? (
          <EmptyState className="min-h-0 py-4">The sources agree. No open questions.</EmptyState>
        ) : (
          <ul className="divide-y rounded-lg border">
            {part.issues.map((issue) => (
              <IssueItem key={issue.id} issue={issue} part={part} />
            ))}
          </ul>
        )}
      </Section>

      <Section title="Risks" count={part.risks.length}>
        {part.risks.length === 0 ? (
          <EmptyState className="min-h-0 py-4">No risks for this part.</EmptyState>
        ) : (
          <ul className="divide-y rounded-lg border">
            {part.risks.map((risk) => (
              <li key={risk.id} className="px-3 py-2.5">
                <RiskDetails risk={risk} facts={part.facts} showTitle />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="border-b">
        <Fold title="All open orders, also those due after the launch">
          <p className="mb-2 text-xs text-muted-foreground">
            Each step counts every open order of this part, so the numbers can be far above what the launch needs.
          </p>
          <div className="grid grid-cols-3 gap-y-3 rounded-lg border px-1 py-3 sm:flex sm:items-center">
            {PIPELINE.map((step, index) => (
              <Fragment key={step.key}>
                {index > 0 && <ChevronRight className="hidden size-3.5 shrink-0 text-muted-foreground/60 sm:block" />}
                <div className="min-w-0 flex-1 px-2 text-center" title={step.hint}>
                  <div className="truncate text-[11px] text-muted-foreground">{step.label}</div>
                  <div className={cn("text-sm font-semibold tabular-nums", part[step.key] === 0 && "text-muted-foreground")}>
                    {num(part[step.key])}
                  </div>
                </div>
              </Fragment>
            ))}
          </div>
        </Fold>
        <Fold title="History" count={part.history.length}>
          {part.history.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing has happened to this part yet.</p>
          ) : (
            <ol className="divide-y rounded-lg border">
              {part.history.map((event) => (
                <li key={event.id} className="px-3 py-2">
                  <div className="text-sm">{event.summary}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {dateTime(event.ts)} · {ACTOR_LABEL[event.actor]}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Fold>
        <Fold title="Every fact read for this part" count={part.facts.length}>
          {part.facts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No facts recorded for this part.</p>
          ) : (
            <FactSources factIds={part.facts.map((fact) => fact.id)} facts={part.facts} showValue className="space-y-1.5" />
          )}
        </Fold>
      </div>
    </div>
  )
}

export function PartSheet({ partId, onClose }: { partId: string | undefined; onClose: () => void }) {
  const { data: part, isPending, isError } = usePart(partId)
  return (
    <Dialog open={Boolean(partId)} onOpenChange={(open) => !open && onClose()}>
      {/* Centred and as wide as a comfortable read, like the items of the to-do list. */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-3xl lg:max-w-4xl">
        <DialogHeader className="gap-1.5 px-6 pt-6 pb-4 pr-14">
          {part ? (
            <>
              <div className="flex items-center gap-2">
                <StatusBadge level={part.status} />
                {part.critical && <span className="rounded-full border px-2 text-xs leading-5">Critical</span>}
              </div>
              <DialogTitle className="text-lg">{part.description}</DialogTitle>
              <DialogDescription>
                <span className="font-mono text-xs">{part.part_id}</span> · {part.category}
                {part.drawing_rev && ` · drawing rev ${part.drawing_rev}`}
                {part.suppliers.length > 0 && ` · ${part.suppliers.map((supplier) => supplier.name).join(", ")}`}
              </DialogDescription>
            </>
          ) : (
            <>
              <DialogTitle className="text-lg">{isError ? "Part not found" : <Skeleton className="h-6 w-56" />}</DialogTitle>
              <DialogDescription>
                <span className="font-mono text-xs">{partId}</span>
              </DialogDescription>
            </>
          )}
        </DialogHeader>
        {part ? (
          <Body part={part} />
        ) : isPending ? (
          <div className="space-y-4 px-6 pb-6">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <div className="px-6 pb-6">
            <ErrorState what="this part" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
