import { ArrowRight } from "lucide-react"
import { useMemo } from "react"
import { Link, useSearchParams } from "react-router"
import type { EditionStatus, PartRow, Task } from "@shared/api.ts"
import { Page } from "@/components/app-layout"
import { ObjectLink } from "@/components/object-link"
import { ItemSheet, QueueRow } from "@/components/queue"
import { ErrorState } from "@/components/states"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { shortEdition } from "@/lib/decisions"
import { dateTime, num } from "@/lib/format"
import { byDeadline, useQueue } from "@/lib/queue"
import { useOverview, useParts, useTasks } from "@/lib/queries"
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

/**
 * Whom the agents wait for outside the dashboard: one line per colleague with their oldest open request, so a buyer
 * knows whom to call. The full list with "Record answer" is on the Colleagues page.
 */
function WaitingOnColleagues({ tasks }: { tasks: Task[] }) {
  const byPerson = new Map<string, { role: string; open: Task[] }>()
  for (const task of tasks) {
    if (task.dashboard || task.status !== "open") continue
    const name = task.person ?? task.role
    const entry = byPerson.get(name) ?? { role: task.role, open: [] }
    entry.open.push(task)
    byPerson.set(name, entry)
  }
  const people = [...byPerson.entries()]
    .map(([name, entry]) => ({ name, role: entry.role, open: entry.open.sort((a, b) => a.created_at.localeCompare(b.created_at)) }))
    .sort((a, b) => a.open[0].created_at.localeCompare(b.open[0].created_at))
  if (people.length === 0) return null
  return (
    <section aria-label="Waiting on colleagues" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold">Waiting on colleagues</h2>
        <Link to="/colleagues" className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          Pass on and record answers
        </Link>
      </div>
      <ul className="divide-y rounded-xl border">
        {people.slice(0, 4).map((person) => (
          <li key={person.name}>
            <Link
              to="/colleagues"
              className="flex items-center gap-3 px-4 py-3 text-sm outline-none hover:bg-muted/40 focus-visible:bg-muted/40"
            >
              <span className="w-40 shrink-0 truncate font-medium" title={person.role}>
                {person.name}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {person.open[0].title}
                {person.open.length > 1 && ` and ${num(person.open.length - 1)} more`}
              </span>
              <span className="hidden shrink-0 text-xs text-muted-foreground tabular-nums sm:block">
                since {dateTime(person.open[0].created_at)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

const plural = (n: number, one: string, many: string) => `${num(n)} ${n === 1 ? one : many}`

export function OverviewPage() {
  const overview = useOverview()
  const parts = useParts()
  const tasks = useTasks()
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

        <WaitingOnColleagues tasks={tasks.data ?? []} />

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
