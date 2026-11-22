import { ChevronRight } from "lucide-react"
import { useState, type ReactNode } from "react"
import { Link } from "react-router"
import type { DecisionCard, Fact, ReportLine } from "@shared/api.ts"
import { MessageBody } from "@/components/message-body"
import { RiskDetails } from "@/components/risk-details"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { PRODUCT_NAME } from "@/lib/config"
import { decisionReach, nextSigner, shortEdition, signatureList } from "@/lib/decisions"
import { MESSAGE_STATUS_LABEL, dateTime, eur, num } from "@/lib/format"
import { useApproveDecision, useRejectDecision, useSaveSettings, useSettings } from "@/lib/queries"
import { cn } from "@/lib/utils"

// One decision card, laid out for a person with a minute: the numbers and the buttons first,
// then the problem and what happens on approval. Everything that backs it up is folded away.

export function Fold({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <Collapsible className="border-t">
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 py-2.5 text-left text-sm font-medium outline-none hover:text-foreground focus-visible:underline">
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <span className="min-w-0 flex-1">{title}</span>
        {count !== undefined && <span className="text-xs font-normal text-muted-foreground tabular-nums">{count}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-4 pl-5">{children}</CollapsibleContent>
    </Collapsible>
  )
}

function Figure({ label, value, children }: { label: string; value: ReactNode; children?: ReactNode }) {
  return (
    <div className="min-w-0 px-3 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-lg leading-6 font-semibold tracking-tight tabular-nums">{value}</div>
      {children && <div className="mt-0.5 space-y-0.5 text-xs text-muted-foreground">{children}</div>}
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
function Lines({
  lines,
  facts,
  ordered = false,
}: {
  lines: ReportLine[]
  facts: Map<number, Fact>
  ordered?: boolean
}) {
  const List = ordered ? "ol" : "ul"
  return (
    <List className={cn("space-y-2 pl-4 text-sm", ordered ? "list-decimal" : "list-disc")}>
      {lines.map((line, index) => {
        const sources = [
          ...new Set(
            line.fact_ids
              .map((id) => facts.get(id)?.source_path)
              .filter((x): x is string => Boolean(x))
              .map(fileName),
          ),
        ]
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

function Actions({ decision }: { decision: DecisionCard }) {
  const approve = useApproveDecision()
  const [rejecting, setRejecting] = useState(false)
  const signatures = signatureList(decision)
  const open = signatures.filter((signature) => !signature.signed_by)
  const several = decision.signatures.length > 1
  const next = open[0]
  const reach = decisionReach(decision)
  const doer = decision.mail_draft?.person ?? null
  const last = open.length <= 1

  const label =
    several && next && !last
      ? `Sign as ${next.person ?? next.role}`
      : reach === "external"
        ? "Approve and send"
        : reach === "handover"
          ? `Approve and hand to ${doer}`
          : "Confirm"
  const hint =
    reach === "self"
      ? `Internal step. Nothing leaves Soony: the signature confirms that ${next?.person ?? "the signer"} does it.`
      : reach === "handover"
        ? `Internal step. Nothing leaves Soony: ${doer} gets it as a task.`
        : null

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="default"
          disabled={approve.isPending}
          onClick={() => approve.mutate({ id: decision.id, by: next?.person ?? undefined })}
        >
          {label}
        </Button>
        <Button variant="outline" disabled={approve.isPending} onClick={() => setRejecting(true)}>
          Reject
        </Button>
        {approve.isError && <span className="text-xs text-muted-foreground">That did not work. Try again.</span>}
      </div>
      {hint && !several && <p className="min-w-0 flex-1 text-xs text-muted-foreground sm:text-right">{hint}</p>}
      {/* One signer is named in the figures above. Several signers are listed here, with who has signed. */}
      {several && (
        <div className="min-w-0 flex-1 text-xs text-muted-foreground sm:text-right">
          {signatures.map((signature, index) => (
            <div key={index}>
              {signature.signed_by ? "Signed: " : "Signs: "}
              <span className="font-medium text-foreground">{signature.person ?? "nobody named"}</span>,{" "}
              {signature.role}
              {signature.stands_in_for && ` (stands in, ${signature.stands_in_for} is vacant)`}
              {signature.signed_at && ` · ${dateTime(signature.signed_at)}`}
            </div>
          ))}
        </div>
      )}
      <RejectDialog decision={decision} open={rejecting} onOpenChange={setRejecting} />
    </div>
  )
}

/** The stage in words. An internal step has no mail out, so "ordered" means handed over or confirmed by signing. */
function stageLabel(decision: DecisionCard): string {
  if (decision.stage !== "ordered") return STAGE_LABEL[decision.stage]
  const reach = decisionReach(decision)
  if (reach === "self") return "Confirmed by signing, waiting for it to show in the data"
  if (reach === "handover") return `Handed to ${decision.mail_draft?.person} as a task, waiting for it to show in the data`
  return STAGE_LABEL.ordered
}

function Outcome({ decision }: { decision: DecisionCard }) {
  return (
    <div className="space-y-1 text-sm">
      <p>
        <span className="font-semibold">
          {decision.status === "approved"
            ? decision.auto
              ? `Carried out by ${PRODUCT_NAME}`
              : "Approved"
            : decision.stage === "withdrawn"
              ? "Taken back"
              : "Rejected"}
        </span>
        <span className="text-muted-foreground">
          {decision.decided_by && !decision.auto && decision.stage !== "withdrawn" && ` by ${decision.decided_by}`}
          {decision.decided_at && ` · ${dateTime(decision.decided_at)}`}
          {decision.status === "approved" && ` · ${stageLabel(decision)}`}
        </span>
      </p>
      {decision.decision_reason && <p className="max-w-3xl text-muted-foreground">{decision.decision_reason}</p>}
    </div>
  )
}

/** The body of a decision: what we would do, its numbers, the buttons, the problem, the plan, and the evidence. */
export function DecisionDetail({
  decision,
  productNames,
}: {
  decision: DecisionCard
  productNames: Map<string, string>
}) {
  const { mail_draft: draft, risk, report } = decision
  const pending = decision.status === "pending"
  const facts = new Map((decision.report_facts ?? []).map((fact) => [fact.id, fact]))
  const signer = nextSigner(decision)
  const editions = decision.copies_by_product.filter((item) => item.copies > 0)

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm">{decision.option}</p>

      <div
        className={cn(
          "grid grid-cols-2 divide-x rounded-lg border",
          decision.value_eur !== null ? "sm:grid-cols-5" : "sm:grid-cols-4",
          "max-sm:[&>*:nth-child(n+3)]:border-t max-sm:[&>*:nth-child(3)]:border-l-0",
        )}
      >
        <Figure label="Copies saved" value={num(decision.copies_saved)}>
          {editions.length > 1 &&
            editions.map((item) => (
              <div key={item.product_id} className="truncate">
                {shortEdition(productNames.get(item.product_id) ?? item.product_id)}: {num(item.copies)}
              </div>
            ))}
          {editions.length === 1 && (
            <div className="truncate">
              {shortEdition(productNames.get(editions[0].product_id) ?? editions[0].product_id)}
            </div>
          )}
        </Figure>
        {decision.value_eur !== null && <Figure label="Worth" value={eur(decision.value_eur)} />}
        <Figure label="Cost" value={decision.cost_eur === null ? "Needs a quote" : eur(decision.cost_eur)} />
        <Figure label="Decide by" value={decision.decide_by ? dateTime(decision.decide_by) : "No deadline"}>
          {decision.wait_copies_per_hour ? (
            <div className="text-foreground">
              Each hour later costs {num(decision.wait_copies_per_hour)} copies
              {decision.wait_eur_per_hour ? ` (${eur(decision.wait_eur_per_hour)})` : ""}
            </div>
          ) : null}
        </Figure>
        <Figure label={pending ? "Signs" : "Signed by"} value={signer?.person ?? "Nobody named"}>
          <div className="truncate">{signer?.role}</div>
        </Figure>
      </div>

      {pending ? <Actions decision={decision} /> : <Outcome decision={decision} />}

      {report ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="space-y-1.5">
            <h3 className="text-sm font-semibold">The problem</h3>
            <p className="text-sm">{report.problem}</p>
          </section>
          <section className="space-y-1.5">
            <h3 className="text-sm font-semibold">{pending ? "What happens when you approve" : "What happens next"}</h3>
            <ol className="list-decimal space-y-1.5 pl-4 text-sm">
              {report.next_steps.map((stepText, index) => (
                <li key={index}>{stepText}</li>
              ))}
            </ol>
          </section>
        </div>
      ) : (
        <p className="max-w-3xl text-sm">
          <span className="text-muted-foreground">Why: </span>
          {decision.rationale}
        </p>
      )}

      <div>
        {report && report.research.length > 0 && (
          <Fold title="What the agent looked at" count={report.research.length}>
            <Lines lines={report.research} facts={facts} />
          </Fold>
        )}
        {report && (
          <Fold
            title={report.contact.with ? `Agreed with ${report.contact.with}` : "Agreed so far"}
            count={report.agreed.length}
          >
            <div className="space-y-2">
              {report.agreed.length > 0 ? (
                <Lines lines={report.agreed} facts={facts} />
              ) : (
                <p className="text-sm text-muted-foreground">Nothing is agreed yet.</p>
              )}
              {report.contact.with && (
                <p className="border-l-2 pl-2.5 text-xs text-muted-foreground">
                  {report.contact.sent === 0
                    ? "No mail has gone to them about this yet."
                    : `${num(report.contact.sent)} ${report.contact.sent === 1 ? "mail" : "mails"} sent, ${num(report.contact.received)} ${report.contact.received === 1 ? "reply" : "replies"}.`}{" "}
                  {pending && "Nothing is ordered yet."}
                </p>
              )}
            </div>
          </Fold>
        )}
        {report && report.ruled_out.length > 0 && (
          <Fold title="Other options, ruled out" count={report.ruled_out.length}>
            <ul className="space-y-1.5 text-sm">
              {report.ruled_out.map((item, index) => (
                <li key={index}>
                  <span className="font-medium">{item.option}.</span>{" "}
                  <span className="text-muted-foreground">{item.reason}</span>
                </li>
              ))}
            </ul>
          </Fold>
        )}
        {(decision.cost_basis || decision.timing_basis || (report && decision.rationale)) && (
          <Fold title="How cost and deadline are worked out">
            <dl className="max-w-3xl space-y-2 text-sm">
              {report && decision.rationale && (
                <div>
                  <dt className="text-xs text-muted-foreground">Why this option</dt>
                  <dd>{decision.rationale}</dd>
                </div>
              )}
              {decision.cost_basis && (
                <div>
                  <dt className="text-xs text-muted-foreground">Cost</dt>
                  <dd>{decision.cost_basis}</dd>
                </div>
              )}
              {decision.timing_basis && (
                <div>
                  <dt className="text-xs text-muted-foreground">Deadline</dt>
                  <dd>{decision.timing_basis}</dd>
                </div>
              )}
              <div>
                <dt className="text-xs text-muted-foreground">Approval rule</dt>
                <dd>{decision.approver.rule}</dd>
              </div>
            </dl>
          </Fold>
        )}
        {risk && (
          <Fold title="The risk behind it">
            <RiskDetails risk={risk} showTitle />
          </Fold>
        )}
        {draft && (
          <Fold
            title={
              draft.supplier_id
                ? pending
                  ? "The mail that goes out when you approve"
                  : "The mail"
                : decisionReach(decision) === "self"
                  ? "What the signature confirms"
                  : pending
                    ? `The task ${draft.person ?? "a colleague"} gets when you approve`
                    : `The task for ${draft.person ?? "a colleague"}`
            }
          >
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
                        Edit it before you approve
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
    </div>
  )
}

const LIMITS = [0, 10_000, 50_000]

/** How much the agent may do without a click. The approval policy still names who signs everything above. */
export function AutonomyDial({ className }: { className?: string }) {
  const { data } = useSettings()
  const save = useSaveSettings()
  if (!data) return null
  const options = LIMITS.includes(data.autonomy_limit_eur)
    ? LIMITS
    : [...LIMITS, data.autonomy_limit_eur].sort((a, b) => a - b)
  return (
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border px-4 py-3 text-sm", className)}>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{PRODUCT_NAME} may order on its own</div>
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
