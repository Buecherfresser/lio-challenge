import { ArrowDownLeft, ArrowLeft, ArrowUpRight, Check, Inbox, ListTodo, MailQuestion, Send } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { useEffect, useRef, type ReactNode } from "react"
import { useSearchParams } from "react-router"
import type { MailFolder, Message, Task, Thread } from "@shared/api.ts"
import { DraftEditor } from "@/components/draft-editor"
import { MessageBody } from "@/components/message-body"
import { ObjectLink } from "@/components/object-link"
import { EmptyState, ErrorState } from "@/components/states"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useMediaQuery } from "@/hooks/use-media-query"
import { ACTOR_LABEL, MESSAGE_STATUS_LABEL, dateTime, num } from "@/lib/format"
import {
  useFolderMessages,
  useTaskDone,
  useTasks,
  useThreadMessages,
  useThreads,
} from "@/lib/queries"
import { cn } from "@/lib/utils"

const FOLDERS: { id: MailFolder; label: string; icon: LucideIcon; empty: string }[] = [
  { id: "inbox", label: "Inbox", icon: Inbox, empty: "No mail has come in yet." },
  { id: "sent", label: "Sent", icon: Send, empty: "Nothing has been sent yet." },
  { id: "needs_approval", label: "Needs approval", icon: MailQuestion, empty: "No mail waits for your approval." },
  { id: "tasks", label: "Tasks", icon: ListTodo, empty: "No tasks right now." },
]

const messageTime = (message: Message) => message.sent_at ?? message.created_at

interface ThreadItem {
  thread_id: string
  title: string
  subject: string
  at: string
  count: number
  needsApproval: number
  unread: number
}

/** The threads that have mail in one folder, newest first. */
function threadItems(messages: Message[], threads: Thread[]): ThreadItem[] {
  const byId = new Map(threads.map((thread) => [thread.thread_id, thread]))
  const items = new Map<string, ThreadItem>()
  for (const message of messages) {
    const at = messageTime(message)
    const thread = byId.get(message.thread_id)
    const item = items.get(message.thread_id)
    if (!item) {
      items.set(message.thread_id, {
        thread_id: message.thread_id,
        title: thread?.title ?? message.person ?? message.thread_id,
        subject: message.subject,
        at,
        count: 1,
        needsApproval: thread?.needs_approval ?? 0,
        unread: thread?.unread_in ?? 0,
      })
    } else {
      item.count += 1
      if (at > item.at) {
        item.at = at
        item.subject = message.subject
      }
    }
  }
  return [...items.values()].sort((a, b) => b.at.localeCompare(a.at))
}

function ListSkeleton() {
  return (
    <div className="space-y-4 p-4">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-full" />
        </div>
      ))}
    </div>
  )
}

function ListRow({
  active,
  onClick,
  title,
  meta,
  line,
  marker,
  muted = false,
}: {
  active: boolean
  onClick: () => void
  title: string
  meta: string
  line: string
  marker?: ReactNode
  muted?: boolean
}) {
  return (
    <li>
      <button
        type="button"
        aria-current={active}
        onClick={onClick}
        className={cn(
          "block w-full border-b px-4 py-3 text-left outline-none hover:bg-muted/50 focus-visible:bg-muted/50",
          active && "bg-muted",
          muted && "text-muted-foreground",
        )}
      >
        <div className="flex items-baseline gap-2">
          <span className="line-clamp-2 min-w-0 flex-1 text-sm font-medium">{title}</span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{meta}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{line}</span>
          {marker}
        </div>
      </button>
    </li>
  )
}

function MessageCard({ message }: { message: Message }) {
  const out = message.direction === "out"
  const Arrow = out ? ArrowUpRight : ArrowDownLeft
  return (
    <article className={cn("rounded-xl border", out && "bg-muted/40", message.status === "rejected" && "opacity-60")}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2.5 text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
          <Arrow className="size-3.5 shrink-0" />
          <span className="truncate">{out ? `To ${message.to_addr}` : `From ${message.from_addr}`}</span>
        </span>
        <span className={cn(message.status === "needs_approval" && "font-semibold text-foreground")}>
          {MESSAGE_STATUS_LABEL[message.status]}
        </span>
        {out && <span>written by {ACTOR_LABEL[message.created_by]}</span>}
        <span className="ml-auto tabular-nums">{dateTime(messageTime(message))}</span>
      </header>
      <div className="space-y-3 px-4 py-3">
        <h3 className="text-sm font-semibold">{message.subject}</h3>
        {message.status === "needs_approval" ? <DraftEditor message={message} /> : <MessageBody message={message} />}
      </div>
    </article>
  )
}

function Conversation({ threadId, title }: { threadId: string; title: string | undefined }) {
  const { data: messages, isPending } = useThreadMessages(threadId)

  // Open at the mail that needs you: the first draft, or else the newest mail.
  const focus = useRef<HTMLDivElement>(null)
  const loaded = Boolean(messages)
  useEffect(() => {
    if (loaded) focus.current?.scrollIntoView({ block: "nearest" })
  }, [loaded])
  if (isPending) {
    return (
      <div className="space-y-4 p-4 md:p-6">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    )
  }
  if (!messages) return <ErrorState what="this conversation" className="m-4 md:m-6" />

  const sorted = [...messages].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const focusId = (sorted.find((message) => message.status === "needs_approval") ?? sorted.at(-1))?.id
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{title ?? threadId}</h2>
        <p className="text-xs text-muted-foreground">
          {sorted.length} {sorted.length === 1 ? "mail" : "mails"}, oldest first
        </p>
      </div>
      {sorted.length === 0 ? (
        <EmptyState>No mail in this conversation.</EmptyState>
      ) : (
        sorted.map((message) => (
          <div key={message.id} ref={message.id === focusId ? focus : undefined} className="scroll-m-4">
            <MessageCard message={message} />
          </div>
        ))
      )}
    </div>
  )
}

function TaskDetail({ task }: { task: Task }) {
  const done = useTaskDone()
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{task.title}</h2>
        <p className="text-xs text-muted-foreground">
          Created {dateTime(task.created_at)} by {ACTOR_LABEL[task.created_by]}
        </p>
      </div>
      <dl className="grid grid-cols-2 divide-x rounded-lg border text-sm">
        <div className="px-3 py-2">
          <dt className="text-xs text-muted-foreground">Role</dt>
          <dd className="font-medium">{task.role}</dd>
        </div>
        <div className="px-3 py-2">
          <dt className="text-xs text-muted-foreground">Person</dt>
          <dd className={cn("font-medium", !task.person && "text-muted-foreground")}>{task.person ?? "Nobody yet"}</dd>
        </div>
      </dl>
      <p className="text-sm leading-relaxed whitespace-pre-wrap">{task.body}</p>
      {task.object && (
        <p className="text-sm text-muted-foreground">
          About <ObjectLink object={task.object} className="text-foreground" />
        </p>
      )}
      {task.status === "open" ? (
        <div className="flex items-center gap-3">
          <Button variant="outline" disabled={done.isPending} onClick={() => done.mutate(task.id)}>
            <Check />
            Mark done
          </Button>
          {done.isError && <span className="text-xs text-muted-foreground">That did not work. Try again.</span>}
        </div>
      ) : (
        <p className="text-sm">
          <span className="font-semibold">Done</span>
          {task.done_at && <span className="text-muted-foreground"> · {dateTime(task.done_at)}</span>}
        </p>
      )}
    </div>
  )
}

export function InboxPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const wide = useMediaQuery("(min-width: 1024px)")

  const threadParam = searchParams.get("thread")
  const taskParam = searchParams.get("task")

  const threads = useThreads()
  const tasks = useTasks()
  const folderMessages = {
    inbox: useFolderMessages("inbox"),
    sent: useFolderMessages("sent"),
    needs_approval: useFolderMessages("needs_approval"),
  }

  const sortedTasks = [...(tasks.data ?? [])].sort(
    (a, b) => Number(a.status === "done") - Number(b.status === "done") || b.created_at.localeCompare(a.created_at),
  )
  const counts: Record<MailFolder, number | undefined> = {
    inbox: threads.data?.reduce((sum, thread) => sum + thread.unread_in, 0),
    sent: folderMessages.sent.data?.length,
    needs_approval: threads.data?.reduce((sum, thread) => sum + thread.needs_approval, 0),
    tasks: tasks.data?.filter((task) => task.status === "open").length,
  }

  // Without a folder in the address, open the one that needs you: mails to approve first, else the inbox.
  const folder =
    FOLDERS.find((item) => item.id === searchParams.get("folder")) ??
    (counts.needs_approval ? FOLDERS.find((item) => item.id === "needs_approval")! : FOLDERS[0])

  const isTasks = folder.id === "tasks"
  const current = folder.id === "tasks" ? null : folderMessages[folder.id]
  const items = current?.data ? threadItems(current.data, threads.data ?? []) : []

  // On a wide window the first entry opens by itself. On a narrow one the list shows first.
  const threadId = isTasks ? null : (threadParam ?? (wide ? items[0]?.thread_id : null) ?? null)
  const taskId = isTasks ? (taskParam ? Number(taskParam) : wide ? sortedTasks[0]?.id : undefined) : undefined
  const task = sortedTasks.find((item) => item.id === taskId)
  const detailOpen = isTasks ? Boolean(taskParam) : Boolean(threadParam)

  const listPending = isTasks ? tasks.isPending : (current?.isPending ?? false) || threads.isPending
  const listFailed = isTasks ? !tasks.data : !current?.data
  const listEmpty = isTasks ? sortedTasks.length === 0 : items.length === 0

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <nav
        aria-label="Folders"
        className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 md:w-48 md:flex-col md:overflow-visible md:border-r md:border-b-0 md:p-3"
      >
        {FOLDERS.map((item) => {
          const count = counts[item.id]
          return (
            <button
              key={item.id}
              type="button"
              aria-current={item.id === folder.id}
              onClick={() => setSearchParams({ folder: item.id })}
              className={cn(
                "flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-sm whitespace-nowrap outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                item.id === folder.id && "bg-muted font-medium",
              )}
            >
              <item.icon className="size-4 text-muted-foreground" />
              <span className="flex-1 text-left">{item.label}</span>
              {count ? <span className="text-xs text-muted-foreground tabular-nums">{num(count)}</span> : null}
            </button>
          )
        })}
      </nav>

      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto lg:w-80 lg:flex-none lg:border-r 2xl:w-[26rem]",
          !wide && detailOpen && "hidden",
        )}
      >
        {listPending ? (
          <ListSkeleton />
        ) : listFailed ? (
          <ErrorState what={isTasks ? "the tasks" : "the mail"} className="m-4" />
        ) : listEmpty ? (
          <EmptyState className="m-4">{folder.empty}</EmptyState>
        ) : isTasks ? (
          <ul>
            {sortedTasks.map((item) => (
              <ListRow
                key={item.id}
                active={item.id === taskId}
                muted={item.status === "done"}
                onClick={() => setSearchParams({ folder: "tasks", task: String(item.id) })}
                title={item.title}
                meta={dateTime(item.created_at)}
                line={item.person ? `${item.role} · ${item.person}` : item.role}
                marker={item.status === "done" ? <span className="shrink-0 text-xs">Done</span> : undefined}
              />
            ))}
          </ul>
        ) : (
          <ul>
            {items.map((item) => (
              <ListRow
                key={item.thread_id}
                active={item.thread_id === threadId}
                onClick={() =>
                  setSearchParams({ folder: folder.id, thread: item.thread_id })
                }
                title={item.title}
                meta={dateTime(item.at)}
                line={item.subject}
                marker={
                  item.needsApproval > 0 ? (
                    <span className="shrink-0 rounded-full border px-1.5 text-[11px] leading-4.5 font-medium text-foreground">
                      {item.needsApproval} to approve
                    </span>
                  ) : item.count > 1 ? (
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{item.count}</span>
                  ) : undefined
                }
              />
            ))}
          </ul>
        )}
      </div>

      <div className={cn("min-h-0 min-w-0 flex-1 overflow-y-auto", !wide && !detailOpen && "hidden")}>
        {!wide && (
          <div className="border-b px-2 py-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSearchParams({ folder: folder.id })}
            >
              <ArrowLeft />
              Back to {folder.label.toLowerCase()}
            </Button>
          </div>
        )}
        {isTasks ? (
          task ? (
            <TaskDetail key={task.id} task={task} />
          ) : tasks.isPending ? (
            <ListSkeleton />
          ) : taskParam ? (
            <EmptyState className="m-4 md:m-6">This task does not exist.</EmptyState>
          ) : listEmpty ? null : (
            <EmptyState className="m-4 md:m-6">Pick a task from the list.</EmptyState>
          )
        ) : threadId ? (
          <Conversation
            key={threadId}
            threadId={threadId}
            title={threads.data?.find((thread) => thread.thread_id === threadId)?.title}
          />
        ) : listPending ? (
          <ListSkeleton />
        ) : listEmpty ? null : (
          <EmptyState className="m-4 md:m-6">Pick a conversation from the list.</EmptyState>
        )}
      </div>
    </div>
  )
}
