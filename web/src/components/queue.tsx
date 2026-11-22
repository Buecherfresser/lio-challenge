import { Check } from "lucide-react"
import { Link } from "react-router"
import type { Message, Task } from "@shared/api.ts"
import { DecisionDetail } from "@/components/decision"
import { DraftEditor } from "@/components/draft-editor"
import { ObjectLink } from "@/components/object-link"
import { PriorityIcon } from "@/components/priority"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ACTOR_LABEL, dateTime, relativeDue, urgency } from "@/lib/format"
import { KIND, PRIORITY, type QueueItem } from "@/lib/queue"
import { useTaskDone } from "@/lib/queries"
import { cn } from "@/lib/utils"

// One line per item that waits for a person, and the dialog that opens on a click.
// Colour sits only on the priority bars and on a deadline under two hours (as text).

export function Due({ due, now, className }: { due: string; now: string; className?: string }) {
  const { label, ms } = relativeDue(due, now)
  return (
    <span
      title={dateTime(due)}
      className={cn(
        "whitespace-nowrap tabular-nums",
        urgency(ms) === "urgent" ? "font-medium text-lost" : "text-muted-foreground",
        className,
      )}
    >
      {label}
    </span>
  )
}

// ---- The queue: one line per item ----

export function QueueRow({ item, now, onOpen }: { item: QueueItem; now: string | null; onOpen: () => void }) {
  const Icon = KIND[item.kind].icon
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "flex w-full items-center gap-3 px-4 py-3 text-left text-sm outline-none hover:bg-muted/40 focus-visible:bg-muted/40",
          item.done && "text-muted-foreground",
        )}
      >
        {!item.done && <PriorityIcon priority={item.priority} />}
        <Icon aria-label={KIND[item.kind].label} className="size-4 shrink-0 text-muted-foreground" />
        <span className="w-10 shrink-0 text-xs text-muted-foreground tabular-nums">{item.ref}</span>
        <span className="min-w-0 flex-1 truncate">{item.title}</span>
        {item.owner && (
          <span className="hidden w-36 shrink-0 truncate text-right text-muted-foreground md:block">{item.owner}</span>
        )}
        <span className="w-24 shrink-0 text-right">
          {item.due && !item.done && now ? <Due due={item.due} now={now} /> : null}
        </span>
      </button>
    </li>
  )
}

// ---- The dialog ----

function MailDetail({ message, threadTitle }: { message: Message; threadTitle: string | undefined }) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        To {threadTitle ?? message.to_addr} ({message.to_addr}) · written by {ACTOR_LABEL[message.created_by]} ·{" "}
        <Link
          to={`/inbox?folder=needs_approval&thread=${encodeURIComponent(message.thread_id)}`}
          className="underline decoration-border underline-offset-4 hover:text-foreground"
        >
          whole conversation
        </Link>
      </p>
      <DraftEditor message={message} />
    </div>
  )
}

function TaskDetail({ task }: { task: Task }) {
  const done = useTaskDone()
  return (
    <div className="space-y-4">
      {task.status === "open" ? (
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={done.isPending} onClick={() => done.mutate(task.id)}>
            <Check />
            Mark done
          </Button>
          {done.isError && <span className="text-xs text-muted-foreground">That did not work. Try again.</span>}
        </div>
      ) : (
        <p className="text-sm font-medium">Done{task.done_at && ` · ${dateTime(task.done_at)}`}</p>
      )}
      <p className="text-sm leading-relaxed whitespace-pre-wrap">{task.body}</p>
      <p className="text-xs text-muted-foreground">
        {task.object && (
          <>
            About <ObjectLink object={task.object} className="text-foreground" /> ·{" "}
          </>
        )}
        Created {dateTime(task.created_at)} by {ACTOR_LABEL[task.created_by]}
      </p>
    </div>
  )
}

export function ItemSheet({
  item,
  now,
  onClose,
  productNames,
  threadTitle,
}: {
  item: QueueItem | undefined
  now: string | null
  onClose: () => void
  productNames: Map<string, string>
  threadTitle: string | undefined
}) {
  return (
    <Dialog open={Boolean(item)} onOpenChange={(open) => !open && onClose()}>
      {/* Centred, and as wide as the screen allows up to a comfortable reading width, so figures and dates fit. */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-3xl lg:max-w-5xl">
        {item && (
          <>
            <DialogHeader className="gap-1 px-6 pt-6 pb-4 pr-14">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {!item.done && (
                  <>
                    <PriorityIcon priority={item.priority} />
                    <span>{PRIORITY[item.priority].label}</span>
                    <span aria-hidden>·</span>
                  </>
                )}
                <span>
                  {KIND[item.kind].label} {item.ref}
                </span>
                {item.due && !item.done && now && (
                  <>
                    <span aria-hidden>·</span>
                    <Due due={item.due} now={now} />
                  </>
                )}
              </div>
              <DialogTitle className="text-lg leading-snug">{item.title}</DialogTitle>
              <DialogDescription>
                {item.owner ? `${item.owner}, ${item.ownerRole}` : (item.ownerRole ?? "Anyone on the team can send it")}
              </DialogDescription>
            </DialogHeader>
            <div className="px-6 pb-8">
              {item.decision && <DecisionDetail decision={item.decision} productNames={productNames} />}
              {item.message && <MailDetail message={item.message} threadTitle={threadTitle} />}
              {item.task && <TaskDetail task={item.task} />}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
