import { CircleCheck, ListTodo, Mail, type LucideIcon } from "lucide-react"
import { useMemo } from "react"
import type { DecisionCard, Message, Priority, Task, Thread } from "@shared/api.ts"
import { nextSigner } from "@/lib/decisions"
import { isTranslated } from "@/lib/format"
import { useDecisions, useFolderMessages, useOverview, useTasks, useThreads } from "@/lib/queries"

// Everything that waits for a person, as one list: decisions to sign, mails to release, tasks.
// The overview shows the urgent part of it, the To do page all of it.

export type Kind = "decision" | "mail" | "task"

export interface QueueItem {
  key: string
  /** The number people say out loud: "#9" for decision 9, "T28" for task 28, "M40" for mail 40. */
  ref: string
  kind: Kind
  title: string
  due: string | null
  /** Who has to act. Null means anyone on the team can. */
  owner: string | null
  ownerRole: string | null
  at: string
  done: boolean
  priority: Priority
  decision?: DecisionCard
  message?: Message
  task?: Task
}

export const KIND: Record<Kind, { label: string; plural: string; icon: LucideIcon; order: number }> = {
  decision: { label: "Decision", plural: "Decisions", icon: CircleCheck, order: 0 },
  mail: { label: "Mail to release", plural: "Mails", icon: Mail, order: 1 },
  task: { label: "Task", plural: "Tasks", icon: ListTodo, order: 2 },
}

export const PRIORITY: Record<Priority, { label: string; order: number }> = {
  urgent: { label: "Urgent", order: 0 },
  high: { label: "Important", order: 1 },
  normal: { label: "Normal", order: 2 },
  low: { label: "Later", order: 3 },
}

export const PRIORITIES = Object.keys(PRIORITY) as Priority[]

/**
 * The tier an agent set, or our own rule while it has not: a decision due within two hours is urgent,
 * every other open decision is important (it binds the company and saves copies), mails and tasks are normal.
 */
function priorityOf(set: Priority | null | undefined, kind: Kind, due: string | null, now: string | null): Priority {
  if (set) return set
  if (kind !== "decision") return "normal"
  if (due && now && new Date(due).getTime() - new Date(now).getTime() < 2 * 3600000) return "urgent"
  return "high"
}

export function englishSubject(message: Message): string {
  if (!isTranslated(message)) return message.subject
  const first = message.body_en.split("\n", 1)[0].trim()
  return /^subject:/i.test(first) ? first.replace(/^subject:\s*/i, "") : message.subject
}

export function buildQueue(
  decisions: DecisionCard[],
  mails: Message[],
  tasks: Task[],
  now: string | null,
): QueueItem[] {
  const pendingDecisionIds = new Set(decisions.filter((d) => d.status === "pending").map((d) => d.id))
  const items: QueueItem[] = []

  for (const decision of decisions) {
    const signer = nextSigner(decision)
    items.push({
      key: `decision-${decision.id}`,
      ref: `#${decision.id}`,
      kind: "decision",
      title: decision.title,
      due: decision.status === "pending" ? decision.decide_by : null,
      owner: signer?.person ?? null,
      ownerRole: signer?.role ?? null,
      at: decision.status === "pending" ? decision.created_at : (decision.decided_at ?? decision.created_at),
      done: decision.status !== "pending",
      priority: priorityOf(decision.priority, "decision", decision.decide_by, now),
      decision,
    })
  }

  for (const message of mails) {
    // A mail that belongs to an open decision goes out with that decision, so it is not listed twice.
    if (message.decision_id !== null && pendingDecisionIds.has(message.decision_id)) continue
    items.push({
      key: `mail-${message.id}`,
      ref: `M${message.id}`,
      kind: "mail",
      title: englishSubject(message),
      due: null,
      owner: null,
      ownerRole: null,
      at: message.created_at,
      done: false,
      priority: priorityOf(message.priority, "mail", null, now),
      message,
    })
  }

  for (const task of tasks) {
    // Tasks for people who never open the dashboard (warehouse, logistics, quality) are listed under Colleagues.
    if (!task.dashboard) continue
    items.push({
      key: `task-${task.id}`,
      ref: `T${task.id}`,
      kind: "task",
      title: task.title,
      due: null,
      owner: task.person,
      ownerRole: task.role,
      at: task.status === "done" ? (task.done_at ?? task.created_at) : task.created_at,
      done: task.status === "done",
      priority: priorityOf(task.priority, "task", null, now),
      task,
    })
  }
  return items
}

/** The nearest deadline first, then decisions before mails before tasks, then the newest. */
export function byDeadline(a: QueueItem, b: QueueItem): number {
  const time = (item: QueueItem) => (item.due ? new Date(item.due).getTime() : Infinity)
  return time(a) - time(b) || KIND[a.kind].order - KIND[b.kind].order || b.at.localeCompare(a.at)
}

/** The highest tier first, then by deadline. */
export function byPriority(a: QueueItem, b: QueueItem): number {
  return PRIORITY[a.priority].order - PRIORITY[b.priority].order || byDeadline(a, b)
}

/** "in 29 min". Red text under two hours, plain text otherwise. No background, no border. */
/** The whole queue and what the pages need around it. "now" is the server clock, null until it has loaded. */
export function useQueue() {
  const overview = useOverview()
  const decisions = useDecisions()
  const mails = useFolderMessages("needs_approval")
  const tasks = useTasks()
  const threads = useThreads()

  const now = overview.data?.now ?? null
  const queue = useMemo(
    () => buildQueue(decisions.data ?? [], mails.data ?? [], tasks.data ?? [], now),
    [decisions.data, mails.data, tasks.data, now],
  )
  const threadById = useMemo(
    () => new Map<string, Thread>((threads.data ?? []).map((t) => [t.thread_id, t])),
    [threads.data],
  )
  const productNames = useMemo(
    () => new Map((overview.data?.editions ?? []).map((edition) => [edition.product_id, edition.name])),
    [overview.data],
  )
  const loading = decisions.isPending || mails.isPending || tasks.isPending
  return {
    queue,
    threadById,
    productNames,
    now,
    loading,
    failed: !loading && !decisions.data && !mails.data && !tasks.data,
  }
}
