import { History, LayoutDashboard, ListTodo, Mail, Package, Users } from "lucide-react"
import type { LucideIcon } from "lucide-react"

/** The management view: one number and the map. No sidebar, no agent internals. */
export const MANAGEMENT_HOME = "/"

/** The buyer's start page. Every page below lives in the buyer view. */
export const BUYER_HOME = "/buyer"

/**
 * The pages of the buyer view, in sidebar order.
 * Overview shows only what is urgent. To do is the work queue of the people who use the dashboard (decisions, mails,
 * tasks). Colleagues lists what the agents asked of people who never open it, to pass on and to record their answer.
 * Supply is the state of every part, as a table or a map.
 * Mail is the archive of every conversation. History is what the agents did, step by step.
 */
export const NAV_ITEMS: { to: string; label: string; icon: LucideIcon; match?: string[] }[] = [
  { to: BUYER_HOME, label: "Overview", icon: LayoutDashboard },
  { to: "/todo", label: "To do", icon: ListTodo, match: ["/approvals"] },
  { to: "/colleagues", label: "Colleagues", icon: Users },
  { to: "/parts", label: "Supply", icon: Package },
  { to: "/inbox", label: "Mail", icon: Mail },
  { to: "/log", label: "History", icon: History },
]

export function navItemFor(pathname: string) {
  return NAV_ITEMS.find(
    (item) => pathname.startsWith(item.to) || item.match?.some((prefix) => pathname.startsWith(prefix)),
  )
}
