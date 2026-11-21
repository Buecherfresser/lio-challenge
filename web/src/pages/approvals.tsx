import { ChevronRight } from "lucide-react"
import { useState, type ReactNode } from "react"
import { Link, useSearchParams } from "react-router"
import type { DecisionCard } from "@shared/api.ts"
import { Page } from "@/components/app-layout"
import { MessageBody } from "@/components/message-body"
import { RiskDetails } from "@/components/risk-details"
import { Stat, StatRow } from "@/components/stat"
import { EmptyState, ErrorState } from "@/components/states"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { MESSAGE_STATUS_LABEL, dateTime, eur, num } from "@/lib/format"
import { useApproveDecision, useDecisions, useOverview, useRejectDecision } from "@/lib/queries"

function Fold({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Collapsible className="border-t">
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 py-2.5 text-sm font-medium outline-none hover:text-foreground focus-visible:underline">
        <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-4 pl-5">{children}</CollapsibleContent>
    </Collapsible>
  )
}

function Figure({ label, value, children }: { label: string; value: ReactNode; children?: ReactNode }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tracking-tight tabular-nums">{value}</div>
      {children && <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">{children}</div>}
    </div>
  )
}

function RejectDialog({
  decision,
  open,
  onOpenChange,
}: {
  decision: DecisionCard
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [reason, setReason] = useState("")
  const reject = useRejectDecision()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reject this decision?</DialogTitle>
          <DialogDescription>{decision.title}</DialogDescription>
        </DialogHeader>
        <Textarea
          aria-label="Reason"
          placeholder="Reason (optional)"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="min-h-24"
        />
        {reject.isError && <p className="text-xs text-muted-foreground">That did not work. Try again.</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="outline"
            disabled={reject.isPending}
            onClick={() =>
              reject.mutate({ id: decision.id, reason: reason.trim() }, { onSuccess: () => onOpenChange(false) })
            }
          >
            Reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Decision({ decision, productNames }: { decision: DecisionCard; productNames: Map<string, string> }) {
  const approve = useApproveDecision()
  const [rejecting, setRejecting] = useState(false)
  const { approver, mail_draft: draft, risk } = decision
  const pending = decision.status === "pending"

  return (
    <Card className="gap-0 pb-0 shadow-none">
      <CardContent className="space-y-4">
        <div>
          <h2 className="text-base leading-snug font-semibold">{decision.title}</h2>
          <p className="mt-1 max-w-3xl text-sm">{decision.option}</p>
        </div>

        <div className="grid divide-y rounded-lg border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <Figure label="Copies saved" value={num(decision.copies_saved)}>
            {decision.copies_by_product.map((item) => (
              <div key={item.product_id}>
                {productNames.get(item.product_id) ?? item.product_id}: {num(item.copies)}
              </div>
            ))}
          </Figure>
          <Figure label="Cost" value={decision.cost_eur === null ? "Needs a quote" : eur(decision.cost_eur)}>
            <div>{decision.cost_basis}</div>
          </Figure>
          <Figure label="Who approves" value={<span className="text-base">{approver.role}</span>}>
            <div className="text-foreground">
              {approver.person ?? "Nobody named"} ·{" "}
              <span className={approver.available ? undefined : "font-semibold"}>
                {approver.available ? "available" : "not available"}
              </span>
            </div>
            {approver.note && <div>{approver.note}</div>}
            <div>{approver.rule}</div>
          </Figure>
        </div>

        <p className="max-w-3xl text-sm">
          <span className="text-muted-foreground">Why: </span>
          {decision.rationale}
        </p>

        <div>
          {risk && (
            <Fold title={`Risk behind this: ${risk.title}`}>
              <RiskDetails risk={risk} />
            </Fold>
          )}
          {draft && (
            <Fold title="Mail draft">
              <div className="space-y-3">
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
                  <dt className="text-muted-foreground">To</dt>
                  <dd className="truncate">{draft.to_addr}</dd>
                  <dt className="text-muted-foreground">Subject</dt>
                  <dd>{draft.subject}</dd>
                  <dt className="text-muted-foreground">Status</dt>
                  <dd>
                    {MESSAGE_STATUS_LABEL[draft.status]}
                    {draft.status === "needs_approval" && (
                      <>
                        {" · "}
                        <Link
                          to={`/inbox?folder=needs_approval&thread=${encodeURIComponent(draft.thread_id)}`}
                          className="underline decoration-border underline-offset-4 hover:decoration-foreground"
                        >
                          Edit or send it in the inbox
                        </Link>
                      </>
                    )}
                  </dd>
                </dl>
                <MessageBody message={draft} className="rounded-lg border p-3" />
              </div>
            </Fold>
          )}
        </div>
      </CardContent>

      <CardFooter className="flex-wrap gap-2">
        {pending ? (
          <>
            <Button variant="decision" disabled={approve.isPending} onClick={() => approve.mutate(decision.id)}>
              Approve
            </Button>
            <Button variant="outline" disabled={approve.isPending} onClick={() => setRejecting(true)}>
              Reject
            </Button>
            {approve.isError && <span className="text-xs text-muted-foreground">That did not work. Try again.</span>}
            <span className="ml-auto text-xs text-muted-foreground">Prepared {dateTime(decision.created_at)}</span>
            <RejectDialog decision={decision} open={rejecting} onOpenChange={setRejecting} />
          </>
        ) : (
          <p className="text-sm">
            <span className="font-semibold">{decision.status === "approved" ? "Approved" : "Rejected"}</span>
            <span className="text-muted-foreground">
              {decision.decided_by && ` by ${decision.decided_by}`}
              {decision.decided_at && ` · ${dateTime(decision.decided_at)}`}
            </span>
          </p>
        )}
      </CardFooter>
    </Card>
  )
}

function DecisionList({
  decisions,
  empty,
  productNames,
}: {
  decisions: DecisionCard[]
  empty: string
  productNames: Map<string, string>
}) {
  if (decisions.length === 0) return <EmptyState>{empty}</EmptyState>
  return (
    <div className="space-y-4">
      {decisions.map((decision) => (
        <Decision key={decision.id} decision={decision} productNames={productNames} />
      ))}
    </div>
  )
}

export function ApprovalsPage() {
  const { data: decisions, isPending } = useDecisions()
  const { data: overview } = useOverview()
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = searchParams.get("tab") === "decided" ? "decided" : "pending"

  const productNames = new Map((overview?.editions ?? []).map((edition) => [edition.product_id, edition.name]))
  const pending = (decisions ?? []).filter((decision) => decision.status === "pending")
  const decided = (decisions ?? [])
    .filter((decision) => decision.status !== "pending")
    .sort((a, b) => (b.decided_at ?? "").localeCompare(a.decided_at ?? ""))

  const copies = pending.reduce((sum, decision) => sum + decision.copies_saved, 0)
  const cost = pending.reduce((sum, decision) => sum + (decision.cost_eur ?? 0), 0)
  const quotes = pending.filter((decision) => decision.cost_eur === null).length

  return (
    <Page>
      <StatRow>
        <Stat label="Waiting for you" value={num(pending.length)} hint={pending.length === 1 ? "decision" : "decisions"} loading={isPending} />
        <Stat label="Copies they save" value={num(copies)} hint="if you approve all of them" loading={isPending} />
        <Stat
          label="Cost"
          value={eur(cost)}
          hint={quotes > 0 ? `plus ${quotes} that ${quotes === 1 ? "needs" : "need"} a quote` : "all prices known"}
          loading={isPending}
        />
        <Stat label="Decided" value={num(decided.length)} hint="approved or rejected" loading={isPending} />
      </StatRow>

      {isPending ? (
        <div className="space-y-4">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      ) : !decisions ? (
        <ErrorState what="the decisions" />
      ) : (
        <Tabs
          value={tab}
          onValueChange={(value) => setSearchParams(value === "decided" ? { tab: "decided" } : {}, { replace: true })}
          className="gap-4"
        >
          <TabsList>
            <TabsTrigger value="pending" className="px-3">
              Pending <span className="text-muted-foreground tabular-nums">{pending.length}</span>
            </TabsTrigger>
            <TabsTrigger value="decided" className="px-3">
              Decided <span className="text-muted-foreground tabular-nums">{decided.length}</span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="pending">
            <DecisionList decisions={pending} empty="Nothing needs a decision right now." productNames={productNames} />
          </TabsContent>
          <TabsContent value="decided">
            <DecisionList decisions={decided} empty="You have not decided anything yet." productNames={productNames} />
          </TabsContent>
        </Tabs>
      )}
    </Page>
  )
}
