import { Check, ChevronRight, CircleCheck, Copy, MessageSquareReply } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "react-router"
import type { Task } from "@shared/api.ts"
import { Page } from "@/components/app-layout"
import { ObjectLink } from "@/components/object-link"
import { EmptyState, ErrorState } from "@/components/states"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { dateTime, num } from "@/lib/format"
import { useTaskAnswer, useTaskDone, useTasks } from "@/lib/queries"
import { cn } from "@/lib/utils"

// Every task the agents gave a person at Soony, with its state, grouped by person. Each person got a mail when the
// task was created. Whoever hears back records the answer here (the agents read it like a reply) or marks it done.

interface Person {
  name: string
  role: string
  open: Task[]
  answered: Task[]
}

function groupByPerson(tasks: Task[]): Person[] {
  const people = new Map<string, Person>()
  for (const task of tasks) {
    const name = task.person ?? task.role
    let person = people.get(name)
    if (!person) {
      person = { name, role: task.role, open: [], answered: [] }
      people.set(name, person)
    }
    ;(task.status === "open" ? person.open : person.answered).push(task)
  }
  for (const person of people.values()) {
    person.open.sort((a, b) => a.created_at.localeCompare(b.created_at))
    person.answered.sort((a, b) => (b.done_at ?? "").localeCompare(a.done_at ?? ""))
  }
  // Whoever has waited longest comes first. People with nothing open go last.
  const oldest = (p: Person) => p.open[0]?.created_at ?? "9"
  return [...people.values()].sort((a, b) => oldest(a).localeCompare(oldest(b)) || a.name.localeCompare(b.name))
}

/** The text to paste into a chat or mail to the colleague. */
function asMessage(task: Task): string {
  const body = task.body.trim()
  return /^(hi|hello|dear|hallo|liebe)/i.test(body) ? body : `${task.title}\n\n${body}`
}

function CopyButton({ task }: { task: Task }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(asMessage(task))
          setCopied(true)
          window.setTimeout(() => setCopied(false), 2000)
        } catch {
          // Clipboard access can be refused. The text stays visible in the request for copying by hand.
        }
      }}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? "Copied" : "Copy as message"}
    </Button>
  )
}

function AnswerForm({ task, onDone }: { task: Task; onDone: () => void }) {
  const [text, setText] = useState("")
  const answer = useTaskAnswer()
  return (
    <div className="space-y-2">
      <Textarea
        autoFocus
        aria-label={`Answer from ${task.person ?? task.role}`}
        placeholder={`What did ${task.person ?? task.role} say?`}
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="min-h-20"
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={!text.trim() || answer.isPending}
          onClick={() => answer.mutate({ id: task.id, answer: text.trim() }, { onSuccess: onDone })}
        >
          Save answer
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        {answer.isError && <span className="text-xs text-muted-foreground">That did not work. Try again.</span>}
      </div>
    </div>
  )
}

function DoneButton({ task }: { task: Task }) {
  const done = useTaskDone()
  return (
    <Button size="sm" variant="outline" disabled={done.isPending} onClick={() => done.mutate(task.id)}>
      <CircleCheck />
      Mark done
    </Button>
  )
}

/** Where the task stands, in one line: open and since when it was mailed, or done and what came back. */
function stateLine(task: Task): string {
  if (task.status === "done") return `Done${task.done_at ? ` ${dateTime(task.done_at)}` : ""}`
  return `Open since ${dateTime(task.created_at)}${task.notified_at ? ` · mailed ${dateTime(task.notified_at)}` : ""}`
}

function Request({ task, highlight }: { task: Task; highlight: boolean }) {
  const [answering, setAnswering] = useState(false)
  const ref = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView({ block: "center" })
  }, [highlight])
  return (
    <li ref={ref} className={cn("space-y-2 px-4 py-3", highlight && "bg-muted/50")}>
      <Collapsible defaultOpen={highlight}>
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <CollapsibleTrigger className="group flex min-w-0 flex-1 items-start gap-1.5 text-left text-sm outline-none focus-visible:underline">
            <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
            <span className="w-10 shrink-0 text-xs text-muted-foreground tabular-nums">T{task.id}</span>
            <span className="min-w-0">
              <span className="block font-medium">{task.title}</span>
              <span className="block text-xs text-muted-foreground">{stateLine(task)}</span>
            </span>
          </CollapsibleTrigger>
          {task.status === "open" && !answering && (
            <div className="flex shrink-0 items-center gap-2">
              <CopyButton task={task} />
              <DoneButton task={task} />
              <Button size="sm" onClick={() => setAnswering(true)}>
                <MessageSquareReply />
                Record answer
              </Button>
            </div>
          )}
        </div>
        <CollapsibleContent className="pt-2 pl-[3.75rem]">
          <p className="max-w-3xl text-sm leading-relaxed whitespace-pre-wrap">{task.body}</p>
          {task.object && (
            <p className="mt-1 text-xs text-muted-foreground">
              About <ObjectLink object={task.object} className="text-foreground" />
            </p>
          )}
        </CollapsibleContent>
      </Collapsible>
      {answering && (
        <div className="pl-[3.75rem]">
          <AnswerForm task={task} onDone={() => setAnswering(false)} />
        </div>
      )}
      {task.status === "done" && task.answer && (
        <p className="pl-[3.75rem] text-sm">
          <span className="text-muted-foreground">
            {task.answer ? "Answer: " : ""}
          </span>
          {task.answer}
        </p>
      )}
    </li>
  )
}

export function TasksPage() {
  const tasks = useTasks()
  const [searchParams] = useSearchParams()
  const openKey = searchParams.get("item")
  const opened = (tasks.data ?? []).find((task) => `task-${task.id}` === openKey)
  const [showAnswered, setShowAnswered] = useState(() => opened?.status === "done")
  const people = useMemo(() => groupByPerson(tasks.data ?? []), [tasks.data])
  const openCount = people.reduce((n, p) => n + p.open.length, 0)
  const answeredCount = people.reduce((n, p) => n + p.answered.length, 0)
  const shown = people.filter((p) => (showAnswered ? p.answered.length > 0 : p.open.length > 0))

  return (
    <Page>
      <div className="mx-auto max-w-5xl space-y-4">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Everything the agents asked of someone at Soony. Each person got a mail when their task was created. When you hear
          back, record the answer, which the agents read like a reply, or mark the task done.
        </p>

        {tasks.isPending ? (
          <div className="space-y-3">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-24 w-full rounded-xl" />
            ))}
          </div>
        ) : !tasks.data ? (
          <ErrorState what="the tasks" />
        ) : shown.length === 0 ? (
          <EmptyState>{showAnswered ? "No task is done yet." : "Nobody has an open task."}</EmptyState>
        ) : (
          shown.map((person) => {
            const list = showAnswered ? person.answered : person.open
            return (
              <section key={person.name} aria-label={person.name} className="overflow-hidden rounded-xl border">
                <header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b bg-muted/30 px-4 py-2.5">
                  <h2 className="text-sm font-semibold">{person.name}</h2>
                  <span className="text-xs text-muted-foreground">{person.role}</span>
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                    {showAnswered
                      ? `${num(list.length)} done`
                      : `${num(list.length)} open · waiting since ${dateTime(list[0].created_at)}`}
                  </span>
                </header>
                <ul className="divide-y">
                  {list.map((task) => (
                    <Request key={task.id} task={task} highlight={`task-${task.id}` === openKey} />
                  ))}
                </ul>
              </section>
            )
          })
        )}

        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={() => setShowAnswered(!showAnswered)}
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {showAnswered ? `Back to open tasks (${num(openCount)})` : `Show done (${num(answeredCount)})`}
          </button>
        </div>
      </div>
    </Page>
  )
}
