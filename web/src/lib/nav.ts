import { CircleCheck, History, LayoutDashboard, ListTodo, Mail, Package } from "lucide-react"
import type { LucideIcon } from "lucide-react"

/** The management view: one number and the map. No sidebar, no agent internals. */
export const MANAGEMENT_HOME = "/"

/** The buyer's start page. Every page below lives in the buyer view. */
export const BUYER_HOME = "/buyer"

/**
 * The pages of the buyer view, in sidebar order.
 * Overview shows only what is urgent. Decisions is what waits for a signature (and mails to release).
 * Tasks is everything the agents asked of a person at Soony, with its state. Each person gets a mail per new task.
 * Supply is the state of every part, as a table or a map.
 * Mail is the archive of every conversation. History is what the agents did, step by step.
 */
export const NAV_ITEMS: { to: string; label: string; icon: LucideIcon; match?: string[] }[] = [
  { to: BUYER_HOME, label: "Overview", icon: LayoutDashboard },
  { to: "/decisions", label: "Decisions", icon: CircleCheck, match: ["/approvals", "/todo"] },
  { to: "/tasks", label: "Tasks", icon: ListTodo, match: ["/colleagues"] },
  { to: "/parts", label: "Supply", icon: Package },
  { to: "/inbox", label: "Mail", icon: Mail },
  { to: "/log", label: "History", icon: History },
]

export function navItemFor(pathname: string) {
  return NAV_ITEMS.find(
    (item) => pathname.startsWith(item.to) || item.match?.some((prefix) => pathname.startsWith(prefix)),
  )
}
