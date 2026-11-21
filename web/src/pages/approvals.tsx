import { ChevronRight } from "lucide-react"
import { useState, type ReactNode } from "react"
import { Link, useSearchParams } from "react-router"
import type { DecisionCard, Fact, ReportLine, Signature } from "@shared/api.ts"
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
import { useApproveDecision, useDecisions, useOverview, useRejectDecision, useSaveSettings, useSettings } from "@/lib/queries"
import { cn } from "@/lib/utils"

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

const STAGE_LABEL: Record<DecisionCard["stage"], string> = {
  proposed: "Waits for a decision",
  approved: "Approved, the mail waits to be sent",
  ordered: "The mail is out, waiting for the confirmation",
  done: "Done, confirmed in the data",
  failed: "Did not work out",
  withdrawn: "Taken back",
}

/** File name of a source path: enough to recognise the document. */
const fileName = (path: string) => path.split("/").pop() ?? path

/** One line of the report with the documents it rests on. */
function Lines({ lines, facts, ordered = false }: { lines: ReportLine[]; facts: Map<number, Fact>; ordered?: boolean }) {
  const List = ordered ? "ol" : "ul"
  return (
    <List className={cn("space-y-2 pl-4 text-sm", ordered ? "list-decimal" : "list-disc")}>
      {lines.map((line, index) => {
        const sources = [...new Set(line.fact_ids.map((id) => facts.get(id)?.source_path).filter((x): x is string => Boolean(x)).map(fileName))]
        return (
          <li key={index}>
            {line.text}
            {sources.length > 0 && (
              <span className="block font-mono text-[11px] break-all text-muted-foreground">{sources.join(" · ")}</span>
            )}
          </li>
        )
      })}
    </List>
  )
}

function Block({ step, title, children }: { step: number; title: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-2 px-4 py-3">
      <h3 className="flex items-baseline gap-2 text-sm font-semibold">
        <span className="font-mono text-[11px] font-normal text-muted-foreground">{step}</span>
        {title}
      </h3>
      {children}
    </div>
  )
}

/** The report in the order a person needs it: what was looked at, the problem, what is agreed, what happens next. */
function Report({ decision }: { decision: DecisionCard }) {
  const report = decision.report
  if (!report) return null
  const facts = new Map((decision.report_facts ?? []).map((fact) => [fact.id, fact]))
  const { contact } = report
  return (
    <div className="space-y-3">
      <div className="grid divide-y rounded-lg border md:grid-cols-2 md:divide-x md:divide-y-0 xl:grid-cols-4 md:[&>*:nth-child(n+3)]:border-t xl:[&>*:nth-child(n+3)]:border-t-0">
        <Block step={1} title="What I looked at">
          <Lines lines={report.research} facts={facts} />
        </Block>
        <Block step={2} title="The problem">
          <p className="text-sm">{report.problem}</p>
        </Block>
        <Block step={3} title={contact.with ? `Agreed with ${contact.with}` : "Agreed so far"}>
          {report.agreed.length > 0 ? (
            <Lines lines={report.agreed} facts={facts} />
          ) : (
            <p className="text-sm text-muted-foreground">Nothing is agreed yet.</p>
          )}
          {contact.with && (
            <p className="border-l-2 pl-2.5 text-xs text-muted-foreground">
              {contact.sent === 0
                ? "I have not written to them about this."
                : `${num(contact.sent)} ${contact.sent === 1 ? "mail" : "mails"} sent, ${num(contact.received)} ${contact.received === 1 ? "reply" : "replies"}.`}{" "}
              {decision.status === "pending" && "Nothing is ordered yet."}
            </p>
          )}
        </Block>
        <Block step={4} title={decision.status === "pending" ? "What happens when you approve" : "What happens next"}>
          <ol className="list-decimal space-y-2 pl-4 text-sm">
            {report.next_steps.map((stepText, index) => (
              <li key={index}>{stepText}</li>
            ))}
          </ol>
        </Block>
      </div>
      {report.ruled_out.length > 0 && (
        <ul className="space-y-1 text-sm text-muted-foreground">
          {report.ruled_out.map((item, index) => (
            <li key={index}>
              <span className="font-medium text-foreground">Ruled out: {item.option}.</span> {item.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Who has to sign, and who has. */
function Signatures({ decision }: { decision: DecisionCard }) {
  const { approver, signatures } = decision
  const list: Signature[] =
    signatures.length > 0
      ? signatures
      : [{ role: approver.role, person: approver.person, stands_in_for: null, signed_by: null, signed_at: null }]
  return (
    <div className="min-w-0 space-y-1 text-xs text-muted-foreground sm:text-right">
      {list.map((signature, index) => (
        <div key={index}>
          <span className="font-medium text-foreground">{signature.person ?? "Nobody named"}</span>, {signature.role}
          {signature.stands_in_for && ` (the role ${signature.stands_in_for} is vacant)`}
          {signature.signed_by && ` · signed ${dateTime(signature.signed_at)}`}
        </div>
      ))}
      <div className="max-w-md sm:ml-auto">{approver.rule}</div>
    </div>
  )
}

function Decision({ decision, productNames }: { decision: DecisionCard; productNames: Map<string, string> }) {
  const approve = useApproveDecision()
  const [rejecting, setRejecting] = useState(false)
  const { mail_draft: draft, risk } = decision
  const pending = decision.status === "pending"
  const open = decision.signatures.filter((signature) => !signature.signed_by)
  const several = decision.signatures.length > 1
  const next = open[0]

  return (
    <Card className={cn("gap-0 pb-0 shadow-none", decision.recommended && "border-decision/40")}>
      <CardContent className="space-y-4">
        <div>
          {pending && (decision.recommended || several) && (
            <div className="mb-1.5 flex flex-wrap gap-1.5 text-xs">
              {decision.recommended && (
                <span className="rounded-full border border-decision/40 px-2 py-0.5 font-medium text-decision">Recommended</span>
              )}
              {several && (
                <span className="rounded-full border px-2 py-0.5 text-muted-foreground">
                  {num(decision.signatures.length - open.length)} of {num(decision.signatures.length)} signed
                </span>
              )}
            </div>
          )}
          <h2 className="text-base leading-snug font-semibold">{decision.title}</h2>
          <p className="mt-1 max-w-3xl text-sm">{decision.option}</p>
        </div>

        <div className="grid divide-y rounded-lg border sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-4 sm:[&>*:nth-child(n+3)]:border-t lg:[&>*:nth-child(n+3)]:border-t-0">
          <Figure label="Copies saved" value={num(decision.copies_saved)}>
            {decision.copies_by_product
              .filter((item) => item.copies > 0)
              .map((item) => (
                <div key={item.product_id}>
                  {productNames.get(item.product_id) ?? item.product_id}: {num(item.copies)}
                </div>
              ))}
          </Figure>
          <Figure label="Worth" value={decision.value_eur === null ? "Not valued" : eur(decision.value_eur)}>
            <div>
              {decision.value_eur === null
                ? "No value per copy is set for these products."
                : "What these copies are worth on day one."}
            </div>
          </Figure>
          <Figure label="Cost" value={decision.cost_eur === null ? "Needs a quote" : eur(decision.cost_eur)}>
            <div>{decision.cost_basis}</div>
          </Figure>
          <Figure label="Decide by" value={decision.decide_by ? dateTime(decision.decide_by) : "No deadline"}>
            {decision.wait_copies_per_hour ? (
              <div className="text-foreground">
                Each hour later costs {num(decision.wait_copies_per_hour)} copies
                {decision.wait_eur_per_hour ? ` (${eur(decision.wait_eur_per_hour)})` : ""}.
              </div>
            ) : null}
            {decision.timing_basis && <div>{decision.timing_basis}</div>}
          </Figure>
        </div>

        {decision.report ? (
          <Report decision={decision} />
        ) : (
          <p className="max-w-3xl text-sm">
            <span className="text-muted-foreground">Why: </span>
            {decision.rationale}
          </p>
        )}

        <div>
          {decision.report && decision.rationale && (
            <Fold title="Why this option">
              <p className="max-w-3xl text-sm">{decision.rationale}</p>
            </Fold>
          )}
          {risk && (
            <Fold title={`Risk behind this: ${risk.title}`}>
              <RiskDetails risk={risk} />
            </Fold>
          )}
          {draft && (
            <Fold title={pending ? "The mail that goes out when you approve" : "The mail"}>
              <div className="space-y-3">
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
                  <dt className="text-muted-foreground">To</dt>
                  <dd className="truncate">{draft.to_addr || draft.person || "a colleague, as a task"}</dd>
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

      <CardFooter className="flex-wrap items-start gap-x-4 gap-y-3">
        {pending ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="decision"
                disabled={approve.isPending}
                onClick={() => approve.mutate({ id: decision.id, by: next?.person ?? undefined })}
              >
                {several && next ? `Sign as ${next.person ?? next.role}` : draft ? "Approve and send" : "Approve"}
              </Button>
              <Button variant="outline" disabled={approve.isPending} onClick={() => setRejecting(true)}>
                Reject
              </Button>
              {approve.isError && <span className="text-xs text-muted-foreground">That did not work. Try again.</span>}
            </div>
            <div className="ml-auto">
              <Signatures decision={decision} />
            </div>
            <RejectDialog decision={decision} open={rejecting} onOpenChange={setRejecting} />
          </>
        ) : (
          <div className="space-y-1 text-sm">
            <p>
              <span className="font-semibold">
                {decision.status === "approved"
                  ? decision.auto
                    ? "Carried out by Lineguard"
                    : "Approved"
                  : decision.stage === "withdrawn"
                    ? "Taken back"
                    : "Rejected"}
              </span>
              <span className="text-muted-foreground">
                {decision.decided_by && !decision.auto && decision.stage !== "withdrawn" && ` by ${decision.decided_by}`}
                {decision.decided_at && ` · ${dateTime(decision.decided_at)}`}
                {decision.status === "approved" && ` · ${STAGE_LABEL[decision.stage]}`}
              </span>
            </p>
            {decision.decision_reason && <p className="max-w-3xl text-muted-foreground">{decision.decision_reason}</p>}
          </div>
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

const LIMITS = [0, 10_000, 50_000]

/** How much Lineguard may do without a click. The approval policy still names who signs everything above. */
function AutonomyDial() {
  const { data } = useSettings()
  const save = useSaveSettings()
  if (!data) return null
  const options = LIMITS.includes(data.autonomy_limit_eur) ? LIMITS : [...LIMITS, data.autonomy_limit_eur].sort((a, b) => a - b)
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border px-4 py-3 text-sm">
      <div className="min-w-0 flex-1">
        <div className="font-medium">Lineguard may order on its own</div>
        <div className="text-xs text-muted-foreground">
          Below the amount it carries out an order or a freight booking and tells you. Quality releases and exceptions
          always need a person.
        </div>
      </div>
      <div className="flex gap-1" role="group" aria-label="Limit for acting alone">
        {options.map((limit) => (
          <Button
            key={limit}
            size="sm"
            variant={limit === data.autonomy_limit_eur ? "default" : "outline"}
            aria-pressed={limit === data.autonomy_limit_eur}
            disabled={save.isPending}
            onClick={() => save.mutate({ autonomy_limit_eur: limit })}
          >
            {limit === 0 ? "Never" : `Below ${eur(limit)}`}
          </Button>
        ))}
      </div>
    </div>
  )
}

/** Cards in the order to take them: the nearest deadline first, and within a risk the recommended option first. */
function byUrgency(a: DecisionCard, b: DecisionCard): number {
  const time = (decision: DecisionCard) => (decision.decide_by ? new Date(decision.decide_by).getTime() : Infinity)
  return time(a) - time(b) || Number(b.recommended) - Number(a.recommended) || (b.value_eur ?? 0) - (a.value_eur ?? 0)
}

export function ApprovalsPage() {
  const { data: decisions, isPending } = useDecisions()
  const { data: overview } = useOverview()
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = searchParams.get("tab") === "decided" ? "decided" : "pending"

  const productNames = new Map((overview?.editions ?? []).map((edition) => [edition.product_id, edition.name]))
  const pending = (decisions ?? []).filter((decision) => decision.status === "pending").sort(byUrgency)
  const decided = (decisions ?? [])
    .filter((decision) => decision.status !== "pending")
    .sort((a, b) => (b.decided_at ?? "").localeCompare(a.decided_at ?? ""))

  // Options for the same risk are alternatives, so the totals count one per risk: the recommended one.
  const picks = pending.filter((decision) => decision.recommended)
  const copies = picks.reduce((sum, decision) => sum + decision.copies_saved, 0)
  const worth = picks.reduce((sum, decision) => sum + (decision.value_eur ?? 0), 0)
  const cost = picks.reduce((sum, decision) => sum + (decision.cost_eur ?? 0), 0)
  const quotes = picks.filter((decision) => decision.cost_eur === null).length
  const nearest = pending.find((decision) => decision.decide_by)

  return (
    <Page>
      <StatRow>
        <Stat
          label="Waiting for you"
          value={num(pending.length)}
          hint={nearest?.decide_by ? `first one by ${dateTime(nearest.decide_by)}` : pending.length === 1 ? "decision" : "decisions"}
          loading={isPending}
        />
        <Stat label="Copies they save" value={num(copies)} hint="if you approve the recommended ones" loading={isPending} />
        <Stat label="Worth" value={eur(worth)} hint="what those copies are worth on day one" loading={isPending} />
        <Stat
          label="Cost"
          value={eur(cost)}
          hint={quotes > 0 ? `plus ${quotes} that ${quotes === 1 ? "needs" : "need"} a quote` : "all prices known"}
          loading={isPending}
        />
      </StatRow>

      <AutonomyDial />

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
            <DecisionList decisions={decided} empty="Nothing has been decided yet." productNames={productNames} />
          </TabsContent>
        </Tabs>
      )}
    </Page>
  )
}
