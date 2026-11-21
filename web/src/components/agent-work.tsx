import { Link } from "react-router"
import type { AgentWork } from "@shared/api.ts"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { dateTime, eur, num } from "@/lib/format"
import { cn } from "@/lib/utils"

// What the action agent is doing about each open risk, and who has to move next.
// The dot says who is on the move: black = the agent, amber = a supplier, blue = a person at the company.

const STATE: Record<AgentWork["state"], { label: string; dot: string; pulse?: boolean }> = {
  working: { label: "Working on it", dot: "bg-foreground", pulse: true },
  waiting_supplier: { label: "Waiting for", dot: "bg-uncertain" },
  waiting_person: { label: "Waiting for", dot: "bg-decision" },
  ordered: { label: "Sent, to be confirmed by", dot: "bg-uncertain" },
  watching: { label: "Watching", dot: "bg-neutral-400" },
}

function Row({ work }: { work: AgentWork }) {
  const state = STATE[work.state]
  const to = work.state === "waiting_person" ? "/approvals" : `/log?object_type=risk&object_id=${work.risk_id}`
  return (
    <li>
      <Link to={to} className="block px-4 py-3 hover:bg-muted/50">
        <div className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-sm font-medium">{work.title}</span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {work.value_at_risk_eur !== null && work.value_at_risk_eur > 0
              ? eur(work.value_at_risk_eur)
              : `${num(work.copies_at_risk)} copies`}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-xs">
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", state.dot, state.pulse && "animate-pulse")} />
          <span>
            {state.label}
            {work.waiting_for && <span className="font-medium"> {work.waiting_for}</span>}
            {work.until && <span className="text-muted-foreground"> · by {dateTime(work.until)}</span>}
          </span>
        </div>
        {work.last_step && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{work.last_step}</p>}
      </Link>
    </li>
  )
}

export function AgentWorkCard({ work, loading = false }: { work: AgentWork[] | undefined; loading?: boolean }) {
  return (
    <Card className="gap-0 py-0 shadow-none">
      <div className="flex items-baseline justify-between gap-3 border-b px-4 py-3">
        <span className="text-sm font-semibold">Agents at work</span>
        <Link to="/log?actor=action_agent" className="text-xs text-muted-foreground hover:text-foreground">
          Every step
        </Link>
      </div>
      {loading ? (
        <div className="space-y-3 p-4">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      ) : !work || work.length === 0 ? (
        <p className="p-6 text-center text-sm text-muted-foreground">No open risk needs work right now.</p>
      ) : (
        <ul className="divide-y">
          {work.map((item) => (
            <Row key={item.risk_id} work={item} />
          ))}
        </ul>
      )}
    </Card>
  )
}
