import { ChevronRight, Cog, Loader2, FileSearch, RefreshCw, Search, Send, ShieldAlert, User, X } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { useSearchParams } from "react-router"
import type { Actor, EventRow, ObjectType, Status } from "@shared/api.ts"
import { Page } from "@/components/app-layout"
import { FactSources } from "@/components/fact-source"
import { JsonBlock } from "@/components/json-block"
import { ObjectLink } from "@/components/object-link"
import { AutonomyDial } from "@/components/decision"
import { SyncControls } from "@/components/app-sidebar"
import { AGENTS } from "@/lib/agents"
import { EmptyState, ErrorState } from "@/components/states"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { ACTOR_LABEL, OBJECT_TYPE_LABEL, dateOnly, num, timeOnly, timeWithSeconds, usd } from "@/lib/format"
import { useEvents, useFacts, useStatus } from "@/lib/queries"
import { cn } from "@/lib/utils"

const ACTOR_ICON: Record<Actor, LucideIcon> = {
  sync: RefreshCw,
  data_agent: FileSearch,
  risk_agent: ShieldAlert,
  action_agent: Send,
  human: User,
  system: Cog,
}
const ACTORS = Object.keys(ACTOR_LABEL) as Actor[]
const OBJECT_TYPES = Object.keys(OBJECT_TYPE_LABEL) as ObjectType[]
const ALL = "all"

function ActorBadge({ actor }: { actor: Actor }) {
  const Icon = ACTOR_ICON[actor]
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-full border px-2 text-xs font-medium whitespace-nowrap",
        actor === "human" ? "border-foreground bg-foreground text-background" : "bg-muted/60 text-foreground",
      )}
    >
      <Icon className="size-3" />
      {ACTOR_LABEL[actor]}
    </span>
  )
}

function EventDetails({ event }: { event: EventRow }) {
  // Facts can only be fetched per object, so we look up the cited ones through the event's object.
  const facts = useFacts(event.object?.type, event.object?.id, event.fact_ids.length > 0)
  const nothing = event.input == null && event.output == null && event.fact_ids.length === 0
  return (
    <div className="space-y-3 border-t bg-muted/30 px-4 py-3 pl-10 text-sm">
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Action</dt>
          <dd className="font-mono">{event.action}</dd>
        </div>
        {event.run_id && (
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">Run</dt>
            <dd className="font-mono">{event.run_id}</dd>
          </div>
        )}
        {event.tokens_in !== null && event.tokens_out !== null && (
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">Tokens</dt>
            <dd className="tabular-nums">
              {num(event.tokens_in)} in, {num(event.tokens_out)} out
            </dd>
          </div>
        )}
      </dl>
      <JsonBlock label="Input" value={event.input} defaultOpen />
      <JsonBlock label="Output" value={event.output} defaultOpen />
      {event.fact_ids.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">Cited facts</div>
          <FactSources factIds={event.fact_ids} facts={facts.data} showValue />
        </div>
      )}
      {nothing && <p className="text-xs text-muted-foreground">This entry has no input, output or facts.</p>}
    </div>
  )
}

function EventItem({ event, repeat = 1 }: { event: EventRow; repeat?: number }) {
  const [open, setOpen] = useState(false)
  const tokens = (event.tokens_in ?? 0) + (event.tokens_out ?? 0)
  const usage = [
    event.model,
    tokens > 0 ? `${num(tokens)} tokens` : null,
    event.cost_usd !== null ? usd(event.cost_usd) : null,
  ].filter(Boolean)

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault()
            setOpen(!open)
          }
        }}
        className="grid cursor-pointer grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1 px-4 py-2 outline-none hover:bg-muted/50 focus-visible:bg-muted/50 lg:grid-cols-[auto_6.5rem_7.5rem_1fr_auto]"
      >
        <ChevronRight className={cn("mt-1 size-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 lg:contents">
          <time dateTime={event.ts} className="pt-0.5 font-mono text-xs text-muted-foreground tabular-nums">
            {timeWithSeconds(event.ts)}
          </time>
          <div>
            <ActorBadge actor={event.actor} />
          </div>
        </div>
        <div className="col-start-2 min-w-0 text-sm lg:col-start-auto">
          {event.summary}
          {repeat > 1 && <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">×{repeat}</span>}
          {/* The object link repeats the title when the sentence already names it, so it is left out then. */}
          {event.object && !(event.object.label && event.summary.includes(event.object.label)) && (
            <>
              {" "}
              <ObjectLink object={event.object} className="text-xs whitespace-nowrap text-muted-foreground" />
            </>
          )}
        </div>
        {usage.length > 0 && (
          <div className="col-start-2 pt-0.5 text-xs whitespace-nowrap text-muted-foreground tabular-nums lg:col-start-auto lg:text-right">
            {usage.join(" · ")}
          </div>
        )}
      </div>
      {open && <EventDetails event={event} />}
    </li>
  )
}

/** What each agent does right now, the document queue and the spend. One line, above the log it explains. */
function AgentStatus({ status, loading }: { status: Status | undefined; loading: boolean }) {
  if (loading) return <Skeleton className="h-12 w-full rounded-xl" />
  if (!status) return <ErrorState what="the agents' status" />
  const figures = [
    { label: "Documents read", value: num(status.queue.documents_done) },
    { label: "waiting", value: num(status.queue.documents_pending) },
    { label: "failed", value: num(status.queue.documents_failed) },
    { label: "Spend on model calls", value: usd(status.spend_usd) },
  ]
  return (
    <Card size="sm" className="flex-row flex-wrap items-center gap-x-6 gap-y-2 px-4 shadow-none">
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        {AGENTS.map((agent) => {
          const running = status.running[agent.key]
          return (
            <li key={agent.key} className="flex items-center gap-1.5">
              {running ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/50" />
              )}
              <span className={cn(!running && "text-muted-foreground")}>{agent.label}</span>
              <span className="text-xs text-muted-foreground">{running ? "running" : "idle"}</span>
            </li>
          )
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground sm:ml-auto">
        {figures.map((figure) => (
          <span key={figure.label}>
            <span className="font-medium text-foreground tabular-nums">{figure.value}</span> {figure.label}
          </span>
        ))}
        <span>
          {status.last_sync ? `Last sync ${timeOnly(status.last_sync.at)}` : "No sync yet"} · {status.mode.source}
        </span>
        <SyncControls />
      </div>
    </Card>
  )
}

export function LogPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { data: status, isPending: statusPending } = useStatus()

  const actors = (searchParams.get("actor") ?? "").split(",").filter(Boolean)
  const objectType = searchParams.get("object_type") ?? ""
  const objectId = searchParams.get("object_id") ?? ""
  const q = searchParams.get("q") ?? ""

  function setParam(key: string, value: string) {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous)
        if (value) next.set(key, value)
        else next.delete(key)
        if (key === "object_type") next.delete("object_id")
        return next
      },
      { replace: true },
    )
  }

  function toggleActor(actor: Actor) {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous)
        const current = (next.get("actor") ?? "").split(",").filter(Boolean)
        const updated = current.includes(actor) ? current.filter((item) => item !== actor) : [...current, actor]
        if (updated.length > 0) next.set("actor", updated.join(","))
        else next.delete("actor")
        return next
      },
      { replace: true },
    )
  }

  // The search box waits until typing stops before it asks the server.
  // When the URL changes from outside, for example through "Clear filters", the box follows.
  const [text, setText] = useState(q)
  const [seenQ, setSeenQ] = useState(q)
  if (q !== seenQ) {
    setSeenQ(q)
    setText(q)
  }
  useEffect(() => {
    if (text === q) return
    const timer = setTimeout(() => setParam("q", text), 300)
    return () => clearTimeout(timer)
    // Only typing restarts the timer.
  }, [text]) // oxlint-disable-line react-hooks/exhaustive-deps

  const events = useEvents({ actors, object_type: objectType, object_id: objectId, q })
  const rows = events.data?.pages.flat() ?? []
  const filtered = actors.length > 0 || Boolean(objectType || objectId || q)

  // Group by day so each row only needs the time. The same step twice in the same second shows once, with ×2.
  const days: { day: string; events: { event: EventRow; repeat: number }[] }[] = []
  for (const event of rows) {
    const day = dateOnly(event.ts)
    const group = days.at(-1)?.day === day ? days.at(-1)! : (days.push({ day, events: [] }), days.at(-1)!)
    const last = group.events.at(-1)
    if (last && last.event.actor === event.actor && last.event.summary === event.summary && last.event.ts.slice(0, 19) === event.ts.slice(0, 19)) {
      last.repeat += 1
    } else {
      group.events.push({ event, repeat: 1 })
    }
  }

  return (
    <Page>
      <AgentStatus status={status} loading={statusPending} />
      <AutonomyDial />

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              aria-label="Search the log"
              placeholder="Search the log"
              value={text}
              onChange={(event) => setText(event.target.value)}
              className="pl-8"
            />
          </div>
          <Select value={objectType || ALL} onValueChange={(value) => setParam("object_type", value === ALL ? "" : value)}>
            <SelectTrigger aria-label="Object type" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All objects</SelectItem>
              {OBJECT_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {OBJECT_TYPE_LABEL[type]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {objectId && (
            <Button variant="outline" onClick={() => setParam("object_id", "")} title="Remove this filter">
              <span className="max-w-56 truncate font-mono text-xs">{objectId}</span>
              <X />
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Actors">
          {ACTORS.map((actor) => {
            const on = actors.includes(actor)
            const Icon = ACTOR_ICON[actor]
            return (
              <button
                key={actor}
                type="button"
                aria-pressed={on}
                onClick={() => toggleActor(actor)}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                  on ? "border-foreground bg-foreground text-background hover:bg-foreground/85" : "text-muted-foreground",
                )}
              >
                <Icon className="size-3" />
                {ACTOR_LABEL[actor]}
              </button>
            )
          })}
          {filtered && (
            <Button variant="ghost" size="sm" onClick={() => setSearchParams({}, { replace: true })}>
              Clear filters
            </Button>
          )}
        </div>
      </div>

      {events.isPending ? (
        <Card className="space-y-3 p-4 shadow-none">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((row) => (
            <Skeleton key={row} className="h-5 w-full" />
          ))}
        </Card>
      ) : !events.data ? (
        <ErrorState what="the log" />
      ) : rows.length === 0 ? (
        <EmptyState>{filtered ? "No entry matches your filter." : "Nothing has happened yet. Run a sync to start."}</EmptyState>
      ) : (
        <div className="space-y-4">
          {days.map((group) => (
            <section key={group.day}>
              <h2 className="mb-1.5 text-xs font-medium text-muted-foreground">{group.day}</h2>
              <Card className="py-0 shadow-none">
                <ol className="divide-y">
                  {group.events.map(({ event, repeat }) => (
                    <EventItem key={event.id} event={event} repeat={repeat} />
                  ))}
                </ol>
              </Card>
            </section>
          ))}
          <div className="flex justify-center">
            {events.hasNextPage ? (
              <Button variant="outline" disabled={events.isFetchingNextPage} onClick={() => events.fetchNextPage()}>
                {events.isFetchingNextPage ? "Loading" : "Load older"}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                {num(rows.length)} {rows.length === 1 ? "entry" : "entries"}. This is the start of the log.
              </p>
            )}
          </div>
        </div>
      )}
    </Page>
  )
}
