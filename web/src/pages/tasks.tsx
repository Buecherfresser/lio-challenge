import { Check, ChevronRight, Copy, MessageSquareReply } from "lucide-react"
import { useMemo, useState } from "react"
import type { Task } from "@shared/api.ts"
import { Page } from "@/components/app-layout"
import { ObjectLink } from "@/components/object-link"
import { EmptyState, ErrorState } from "@/components/states"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { PRODUCT_NAME } from "@/lib/config"
import { dateTime, num } from "@/lib/format"
import { useTaskAnswer, useTasks } from "@/lib/queries"

// What the agents asked of colleagues who never open the dashboard: the warehouse, logistics, quality.
// A buyer passes each request on (phone, Teams, in person) and types the answer in, which the agents then read.

interface Person {
  name: string
  role: string
  open: Task[]
  answered: Task[]
}

function groupByPerson(tasks: Task[]): Person[] {
  const people = new Map<string, Person>()
  for (const task of tasks) {
    if (task.dashboard) continue
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

function Request({ task }: { task: Task }) {
  const [answering, setAnswering] = useState(false)
  return (
    <li className="space-y-2 px-4 py-3">
      <Collapsible>
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <CollapsibleTrigger className="group flex min-w-0 flex-1 items-start gap-1.5 text-left text-sm outline-none focus-visible:underline">
            <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
            <span className="min-w-0">
              <span className="block font-medium">{task.title}</span>
              <span className="block text-xs text-muted-foreground">Asked {dateTime(task.created_at)}</span>
            </span>
          </CollapsibleTrigger>
          {task.status === "open" && !answering && (
            <div className="flex shrink-0 items-center gap-2">
              <CopyButton task={task} />
              <Button size="sm" onClick={() => setAnswering(true)}>
                <MessageSquareReply />
                Record answer
              </Button>
            </div>
          )}
        </div>
        <CollapsibleContent className="pt-2 pl-5">
          <p className="max-w-3xl text-sm leading-relaxed whitespace-pre-wrap">{task.body}</p>
          {task.object && (
            <p className="mt-1 text-xs text-muted-foreground">
              About <ObjectLink object={task.object} className="text-foreground" />
            </p>
          )}
        </CollapsibleContent>
      </Collapsible>
      {answering && (
        <div className="pl-5">
          <AnswerForm task={task} onDone={() => setAnswering(false)} />
        </div>
      )}
      {task.status === "done" && (
        <p className="pl-5 text-sm">
          <span className="text-muted-foreground">
            {task.answer ? "Answer" : "Done"}
            {task.done_at && ` · ${dateTime(task.done_at)}`}
            {task.answer && ": "}
          </span>
          {task.answer}
        </p>
      )}
    </li>
  )
}

export function ColleaguesPage() {
  const tasks = useTasks()
  const [showAnswered, setShowAnswered] = useState(false)
  const people = useMemo(() => groupByPerson(tasks.data ?? []), [tasks.data])
  const openCount = people.reduce((n, p) => n + p.open.length, 0)
  const answeredCount = people.reduce((n, p) => n + p.answered.length, 0)
  const shown = people.filter((p) => (showAnswered ? p.answered.length > 0 : p.open.length > 0))

  return (
    <Page>
      <div className="mx-auto max-w-5xl space-y-4">
        <p className="max-w-3xl text-sm text-muted-foreground">
          These colleagues do not use {PRODUCT_NAME}. Pass each request on by phone, Teams or in person, then record what they
          said. The agents read the answer like a reply to a mail.
        </p>

        {tasks.isPending ? (
          <div className="space-y-3">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-24 w-full rounded-xl" />
            ))}
          </div>
        ) : !tasks.data ? (
          <ErrorState what="the requests to colleagues" />
        ) : shown.length === 0 ? (
          <EmptyState>{showAnswered ? "No answers recorded yet." : "Nobody outside the dashboard has an open request."}</EmptyState>
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
                      ? `${num(list.length)} answered`
                      : `${num(list.length)} open · waiting since ${dateTime(list[0].created_at)}`}
                  </span>
                </header>
                <ul className="divide-y">
                  {list.map((task) => (
                    <Request key={task.id} task={task} />
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
            {showAnswered ? `Back to open requests (${num(openCount)})` : `Show answered (${num(answeredCount)})`}
          </button>
        </div>
      </div>
    </Page>
  )
}
