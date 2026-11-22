import type { EventRow } from "@shared/api.ts"

// A short line per log entry for the History page, such as "Missing price: Collect container NHSU4471921 ...".
// The full sentence and the data stay in the details that open on a click.
// The texts these rules read are written by our own code (see the backend), not by a model.

const MAX = 110

const cut = (text: string, max = MAX) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

/** The first sentence of a summary, without the agent's "I ..." framing where that is easy to drop. */
function firstSentence(summary: string): string {
  const line = summary.split("\n", 1)[0].replace(/\*\*/g, "").trim()
  const match = line.match(/^(.+?[.!?])(\s|$)/)
  return match ? match[1] : line
}

/** What woke the action agent, from the reasons code gives it. The first reason names the headline. */
function triggerOf(changes: string[]): { label: string; subject: string | null } {
  const first = changes[0] ?? ""
  const quoted = first.match(/\("(.+?)"\)/)?.[1] ?? null
  if (/has no price/.test(first)) return { label: "Missing price", subject: quoted }
  if (/new to you/.test(first)) return { label: "New risk", subject: null }
  if (/asked to look at this risk again/.test(first)) return { label: "Looked at again", subject: null }
  if (/risk itself changed/.test(first)) return { label: "Risk changed", subject: null }
  if (/confirm has passed/.test(first)) return { label: "Confirmation overdue", subject: quoted }
  if (/was approved by/.test(first)) return { label: "Approved", subject: quoted }
  if (/was rejected by/.test(first)) return { label: "Rejected", subject: quoted }
  if (/questions/.test(first)) return { label: "Answer in or overdue", subject: null }
  if (/limit up to which/.test(first)) return { label: "Autonomy limit changed", subject: null }
  return { label: "Started", subject: null }
}

const LABELS: Record<string, string> = {
  "action_agent.finished": "Pass finished",
  "action_agent.failed": "Pass failed",
  "action_agent.skipped": "Skipped",
  "decision.proposed": "Decision ready",
  "decision.approved": "Approved",
  "decision.carried_out": "Carried out on its own",
  "decision.rejected": "Rejected",
  "decision.withdrawn": "Withdrawn",
  "decision.signed": "Signed",
  "decision.recomputed": "Decision recomputed",
  "decision.rejected_proposal": "Option sent back",
  "risk.reported": "Risk reported",
  "risk.updated": "Risk updated",
  "risk.recomputed": "Risk recomputed",
  "mail.sent": "Mail sent",
  "mail.received": "Mail received",
  "mail.read": "Mail read",
  "mail.approved": "Mail approved",
  "mail.rejected": "Mail rejected",
  "task.done": "Task done",
  "task.answered": "Answer recorded",
  "issue.opened": "Deviation found",
  "issue.answered": "Answered",
  "issue.resolved": "Deviation gone",
  "issue.dismissed": "Closed, no action",
  "document.read": "Document read",
  "notify.sent": "Approver told",
}

export function headlineOf(event: EventRow): string {
  const label = event.object?.label ?? null
  const input = (event.input ?? {}) as Record<string, unknown>

  if (event.action === "action_agent.started") {
    const changes = Array.isArray(input.changes) ? (input.changes as string[]) : []
    const trigger = triggerOf(changes)
    return cut(`${trigger.label}: ${trigger.subject ?? label ?? "a risk"}`)
  }
  if (event.action === "task.created") {
    const match = event.summary.match(/^I gave (.+?) a task: (.+?)\.?$/)
    if (match) return cut(`Task for ${match[1]}: ${match[2]}`)
  }
  if (event.action === "question.asked" || event.action === "question.raised") {
    const who = event.summary.match(/question for (.+?):/)?.[1]
    const what = event.summary.match(/"(.+?)"/)?.[1]
    if (who) return cut(`Question for ${who}${what ? `: ${what}` : ""}`)
  }
  if (event.action === "task.answered") {
    const match = event.summary.match(/recorded (.+?)'s answer to "(.+?)":/)
    if (match) return cut(`Answer from ${match[1]}: ${match[2]}`)
  }
  if (event.action === "document.read") {
    const path = event.summary.match(/^I read (\S+)/)?.[1]
    if (path) return cut(`Document read: ${path.split("/").pop()}`)
  }
  if (event.action.startsWith("tool.")) return cut(firstSentence(event.summary))
  const known = LABELS[event.action]
  if (known && label) return cut(`${known}: ${label}`)
  return cut(firstSentence(event.summary))
}

/** Whether the short line leaves something out, so the details should show the full sentence. */
export function headlineShortens(event: EventRow): boolean {
  return headlineOf(event).replace(/…$/, "") !== event.summary.trim()
}
