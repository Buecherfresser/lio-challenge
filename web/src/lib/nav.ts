import { CircleCheck, Inbox, LayoutDashboard, Package, ScrollText } from "lucide-react"
import type { LucideIcon } from "lucide-react"

/** The pages, in sidebar order. */
export const NAV_ITEMS: { to: string; label: string; icon: LucideIcon }[] = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/parts", label: "Parts", icon: Package },
  { to: "/approvals", label: "Approvals", icon: CircleCheck },
  { to: "/inbox", label: "Inbox", icon: Inbox },
  { to: "/log", label: "Log", icon: ScrollText },
]
