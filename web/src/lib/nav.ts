import { CircleCheck, Inbox, LayoutDashboard, Package, ScrollText } from "lucide-react"
import type { LucideIcon } from "lucide-react"

/** The management view: one number and the map. No sidebar, no agent internals. */
export const MANAGEMENT_HOME = "/"

/** The buyer's start page. Every page below lives in the buyer view. */
export const BUYER_HOME = "/buyer"

/** The pages of the buyer view, in sidebar order. */
export const NAV_ITEMS: { to: string; label: string; icon: LucideIcon }[] = [
  { to: BUYER_HOME, label: "Overview", icon: LayoutDashboard },
  { to: "/parts", label: "Parts", icon: Package },
  { to: "/approvals", label: "Approvals", icon: CircleCheck },
  { to: "/inbox", label: "Inbox", icon: Inbox },
  { to: "/log", label: "Log", icon: ScrollText },
]
