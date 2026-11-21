import { ChevronRight } from "lucide-react"
import { Fragment, type ReactNode } from "react"
import type { Issue, IssueStatus, IssueType, PartDetail, PartSourceLine } from "@shared/api.ts"
import { FactSources } from "@/components/fact-source"
import { ObjectLink } from "@/components/object-link"
import { RiskDetails } from "@/components/risk-details"
import { EmptyState, ErrorState } from "@/components/states"
import { StatusBadge, StatusDot } from "@/components/status"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
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

const PIPELINE: { key: "ordered" | "confirmed" | "shipped" | "in_transit" | "arrived" | "usable"; label: string }[] = [
  { key: "ordered", label: "Ordered" },
  { key: "confirmed", label: "Confirmed" },
  { key: "shipped", label: "Shipped" },
  { key: "in_transit", label: "In transit" },
  { key: "arrived", label: "Arrived" },
  { key: "usable", label: "Usable" },
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
      <FactSources factIds={line.fact_ids} facts={part.facts} className="mt-1 pl-4" />
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
      <FactSources factIds={issue.fact_ids} facts={part.facts} showValue />
    </li>
  )
}

function Body({ part }: { part: PartDetail }) {
  return (
    <div className="space-y-6 px-4 pb-8">
      <div className="rounded-lg border">
        <div className="grid grid-cols-3 gap-y-3 px-1 py-3 sm:flex sm:items-center">
          {PIPELINE.map((step, index) => (
            <Fragment key={step.key}>
              {index > 0 && <ChevronRight className="hidden size-3.5 shrink-0 text-muted-foreground/60 sm:block" />}
              <div className="min-w-0 flex-1 px-2 text-center">
                <div className="truncate text-[11px] text-muted-foreground">{step.label}</div>
                <div
                  className={cn("text-sm font-semibold tabular-nums", part[step.key] === 0 && "text-muted-foreground")}
                >
                  {num(part[step.key])}
                </div>
              </div>
            </Fragment>
          ))}
        </div>
        <dl className="grid grid-cols-2 gap-y-2 border-t px-3 py-2.5 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Need</dt>
            <dd className="font-medium tabular-nums">{num(part.need)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Safe by the deadline</dt>
            <dd className="font-medium tabular-nums">{num(part.available_safe)}</dd>
          </div>
          <div>
            <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {part.available_uncertain > 0 && <StatusDot level="uncertain" className="size-1.5" />}
              May still come
            </dt>
            <dd className="font-medium tabular-nums">{num(part.available_uncertain)}</dd>
          </div>
          <div>
            <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {part.gap > 0 && <StatusDot level="lost" className="size-1.5" />}
              Gap
            </dt>
            <dd className="font-medium tabular-nums">{num(part.gap)}</dd>
          </div>
        </dl>
      </div>

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

      <Section title="History" count={part.history.length}>
        {part.history.length === 0 ? (
          <EmptyState className="min-h-0 py-4">Nothing has happened to this part yet.</EmptyState>
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
      </Section>

      <Section title="All facts" count={part.facts.length}>
        {part.facts.length === 0 ? (
          <EmptyState className="min-h-0 py-4">No facts recorded for this part.</EmptyState>
        ) : (
          <div className="rounded-lg border px-3 py-2.5">
            <FactSources factIds={part.facts.map((fact) => fact.id)} facts={part.facts} showValue className="space-y-1.5" />
          </div>
        )}
      </Section>
    </div>
  )
}

export function PartSheet({ partId, onClose }: { partId: string | undefined; onClose: () => void }) {
  const { data: part, isPending, isError } = usePart(partId)
  return (
    <Sheet open={Boolean(partId)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-[640px]">
        <SheetHeader className="gap-1.5 pr-12">
          {part ? (
            <>
              <div className="flex items-center gap-2">
                <StatusBadge level={part.status} />
                {part.critical && <span className="rounded-full border px-2 text-xs leading-5">Critical</span>}
              </div>
              <SheetTitle className="text-lg">{part.description}</SheetTitle>
              <SheetDescription>
                <span className="font-mono text-xs">{part.part_id}</span> · {part.category}
                {part.drawing_rev && ` · drawing rev ${part.drawing_rev}`}
                {part.suppliers.length > 0 && ` · ${part.suppliers.map((supplier) => supplier.name).join(", ")}`}
              </SheetDescription>
            </>
          ) : (
            <>
              <SheetTitle className="text-lg">{isError ? "Part not found" : <Skeleton className="h-6 w-56" />}</SheetTitle>
              <SheetDescription>
                <span className="font-mono text-xs">{partId}</span>
              </SheetDescription>
            </>
          )}
        </SheetHeader>
        {part ? (
          <Body part={part} />
        ) : isPending ? (
          <div className="space-y-4 px-4">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <div className="px-4">
            <ErrorState what="this part" />
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
