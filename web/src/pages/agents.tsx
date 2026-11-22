import { Check, ChevronRight } from "lucide-react"
import { useState } from "react"
import { Link, useSearchParams } from "react-router"
import type { AgentCase, CaseState } from "@shared/api.ts"
import { Page } from "@/components/app-layout"
import { Segmented } from "@/components/controls"
import { EmptyState, ErrorState } from "@/components/states"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { dateTime, eur, num } from "@/lib/format"
import { useCases } from "@/lib/queries"
import { cn } from "@/lib/utils"

// What the agents took care of, one line per case. A line is a chain of four points:
//   what changed -> what it means -> what was done -> where it stands
// The phrases are written by the agent, the state behind the last point is set by code. A click opens the steps.
// Requests that stayed inside the company (a question to a colleague) sit in their own group, closed at first.

const HEADS = ["What changed", "What it means", "What was done", "Where it stands"] as const

const OPEN_STATES: CaseState[] = ["needs_you", "waiting", "working", "failed"]
const isOpen = (c: AgentCase) => OPEN_STATES.includes(c.state)

type Show = "all" | "open" | "done"

/** The point at the end of the chain says where the case stands. Blue needs a person, red did not work out. */
function EndDot({ state }: { state: CaseState }) {
  if (state === "solved")
    return (
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
        <Check className="size-3" strokeWidth={3} />
      </span>
    )
  return (
    <span
      className={cn(
        "size-3 shrink-0 rounded-full border-[1.5px]",
        state === "needs_you" && "border-decision bg-decision",
        state === "failed" && "border-lost bg-lost",
        (state === "waiting" || state === "working") && "border-foreground bg-background",
      )}
    />
  )
}

function Point({
  head,
  text,
  meta,
  dot,
  line,
  quiet,
}: {
  head: string
  text: string
  meta?: string | null
  dot: React.ReactNode
  /** The line to the next point. Absent on the last one. Dashed = not there yet. */
  line?: "solid" | "dashed"
  quiet?: boolean
}) {
  return (
    <li className="relative flex min-w-0 gap-3 pb-3 last:pb-0 md:block md:pb-0">
      {/* The point and its line: down the side on a phone, across on a desktop. */}
      <span className="relative flex w-4 shrink-0 justify-center md:h-4 md:w-full md:items-center md:justify-start">
        <span className="flex h-5 items-center md:h-auto">{dot}</span>
        {line && (
          <span
            aria-hidden
            className={cn(
              "absolute top-5 -bottom-3 left-1/2 w-0 border-l-[1.5px] md:static md:mx-1.5 md:h-0 md:w-auto md:flex-1 md:border-t-[1.5px] md:border-l-0",
              line === "dashed" ? "border-dashed border-muted-foreground/50" : "border-foreground/70",
            )}
          />
        )}
      </span>
      <span className="block min-w-0 flex-1 md:mt-1.5 md:pr-4">
        <span className="block text-[11px] text-muted-foreground md:hidden">{head}</span>
        <span className={cn("block text-sm leading-snug font-medium text-pretty", quiet && "font-normal text-muted-foreground")}>
          {text}
        </span>
        {meta && <span className="block text-xs text-muted-foreground tabular-nums">{meta}</span>}
      </span>
    </li>
  )
}

const dot = <span className="size-2.5 shrink-0 rounded-full bg-foreground" />
const hollow = <span className="size-2.5 shrink-0 rounded-full border-[1.5px] border-muted-foreground/60 bg-background" />

function Chain({ item }: { item: AgentCase }) {
  const settled = item.state === "solved" || item.state === "failed"
  const numbers =
    item.copies && item.copies > 0
      ? `${num(item.copies)} copies${item.value_eur ? ` · ${eur(item.value_eur)}` : ""}`
      : null
  const when =
    item.state === "waiting" || item.state === "needs_you"
      ? item.due
        ? `by ${dateTime(item.due)}`
        : `since ${dateTime(item.updated_at)}`
      : dateTime(item.updated_at)
  return (
    <ol className="min-w-0 flex-1 md:grid md:grid-cols-4">
      <Point head={HEADS[0]} text={item.change} meta={dateTime(item.started_at)} dot={dot} line="solid" />
      <Point head={HEADS[1]} text={item.impact} meta={numbers} dot={dot} line={item.action ? "solid" : "dashed"} />
      <Point
        head={HEADS[2]}
        text={item.action ?? "Nothing yet"}
        quiet={!item.action}
        dot={item.action ? dot : hollow}
        line={settled ? "solid" : "dashed"}
      />
      <Point head={HEADS[3]} text={item.result} meta={when} dot={<EndDot state={item.state} />} />
    </ol>
  )
}

function Steps({ item }: { item: AgentCase }) {
  const links = [
    item.decision_id ? { to: `/decisions?item=decision-${item.decision_id}&show=${item.state === "needs_you" ? "open" : "done"}`, label: "Open the decision" } : null,
    item.task_id ? { to: `/tasks?item=task-${item.task_id}`, label: "Open the task" } : null,
    item.thread_id ? { to: `/inbox?thread=${encodeURIComponent(item.thread_id)}`, label: "Open the mails" } : null,
    item.part_id ? { to: `/parts/${encodeURIComponent(item.part_id)}`, label: "Open the part" } : null,
    item.risk_id ? { to: `/log?object_type=risk&object_id=${item.risk_id}`, label: "See it in the history" } : null,
  ].filter((link) => link !== null)
  return (
    <div className="border-t bg-muted/20 px-4 py-3 md:pl-11">
      <ol className="space-y-1.5">
        {item.steps.map((step, index) => (
          <li key={index} className="flex gap-3 text-sm">
            <span className="w-28 shrink-0 text-xs leading-5 text-muted-foreground tabular-nums">{dateTime(step.at)}</span>
            <span className="min-w-0 flex-1">
              {step.who && <span className="font-medium">{step.who}: </span>}
              <span className="text-muted-foreground">{step.text}</span>
            </span>
          </li>
        ))}
      </ol>
      {links.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {links.map((link) => (
            <Link key={link.label} to={link.to} className="font-medium underline underline-offset-4 hover:text-decision">
              {link.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function CaseRow({ item }: { item: AgentCase }) {
  const [open, setOpen] = useState(false)
  return (
    <li className={cn(item.state === "solved" && !open && "opacity-70")}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-start gap-3 px-4 py-3.5 text-left outline-none hover:bg-muted/40 focus-visible:bg-muted/40"
      >
        <ChevronRight className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <Chain item={item} />
      </button>
      {open && <Steps item={item} />}
    </li>
  )
}

function CaseList({ items }: { items: AgentCase[] }) {
  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="hidden border-b bg-muted/30 py-1.5 pr-4 pl-11 text-xs font-medium text-muted-foreground md:grid md:grid-cols-4">
        {HEADS.map((head) => (
          <span key={head}>{head}</span>
        ))}
      </div>
      <ul className="divide-y">
        {items.map((item) => (
          <CaseRow key={item.key} item={item} />
        ))}
      </ul>
    </div>
  )
}

const plural = (n: number, one: string, many: string) => `${num(n)} ${n === 1 ? one : many}`

export function AgentsPage() {
  const { data, isPending } = useCases()
  const [searchParams, setSearchParams] = useSearchParams()
  const showParam = searchParams.get("show")
  const show: Show = showParam === "open" || showParam === "done" ? showParam : "all"

  const all = data?.cases ?? []
  const matches = (c: AgentCase) => show === "all" || (show === "open" ? isOpen(c) : !isOpen(c))
  const main = all.filter((c) => !c.internal)
  const internal = all.filter((c) => c.internal)
  const count = (state: CaseState) => main.filter((c) => c.state === state).length

  function setShow(value: Show) {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous)
        if (value === "all") next.delete("show")
        else next.set("show", value)
        return next
      },
      { replace: true },
    )
  }

  const shownMain = main.filter(matches)
  const shownInternal = internal.filter(matches)
  const summary = [
    plural(main.length, "case", "cases"),
    count("needs_you") > 0 ? `${num(count("needs_you"))} ${count("needs_you") === 1 ? "needs" : "need"} a person` : null,
    count("waiting") > 0 ? `${num(count("waiting"))} waiting for an answer` : null,
    count("working") > 0 ? `${num(count("working"))} in progress` : null,
    count("failed") > 0 ? `${num(count("failed"))} not solved` : null,
    `${num(count("solved"))} solved`,
  ].filter(Boolean)

  return (
    <Page>
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground tabular-nums">
            {isPending ? "Loading the cases" : summary.join(" · ")}
          </p>
          <Segmented
            label="Which cases"
            value={show}
            onChange={setShow}
            options={[
              { value: "all", label: `All ${num(all.length)}` },
              { value: "open", label: `Open ${num(all.filter(isOpen).length)}` },
              { value: "done", label: `Done ${num(all.filter((c) => !isOpen(c)).length)}` },
            ]}
          />
        </div>

        {isPending ? (
          <div className="space-y-2">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-20 w-full rounded-xl" />
            ))}
          </div>
        ) : !data ? (
          <ErrorState what="the cases" />
        ) : (
          <>
            {shownMain.length === 0 ? (
              <EmptyState>
                {main.length === 0
                  ? "The agents have not taken up a case yet. A case starts when a risk is found or a supplier is asked."
                  : show === "open"
                    ? "No case is open."
                    : "No case is done yet."}
              </EmptyState>
            ) : (
              <CaseList items={shownMain} />
            )}

            {internal.length > 0 && (
              <Collapsible className="group/internal">
                <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-xl border px-4 py-3 text-left text-sm outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 group-data-[state=open]/internal:rounded-b-none">
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/internal:rotate-90" />
                  <span className="font-medium">Internal requests</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground tabular-nums">
                    {plural(internal.length, "question", "questions")} to colleagues, {num(internal.filter(isOpen).length)} still open
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent className="[&>div]:rounded-t-none [&>div]:border-t-0">
                  {shownInternal.length === 0 ? (
                    <div className="rounded-xl border px-4 py-3 text-sm text-muted-foreground">
                      {show === "open" ? "None of them is open." : "None of them is done yet."}
                    </div>
                  ) : (
                    <CaseList items={shownInternal} />
                  )}
                </CollapsibleContent>
              </Collapsible>
            )}
          </>
        )}
      </div>
    </Page>
  )
}
