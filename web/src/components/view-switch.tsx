import { Gauge, ShoppingCart } from "lucide-react"
import { NavLink } from "react-router"
import { BUYER_HOME, MANAGEMENT_HOME } from "@/lib/nav"
import { cn } from "@/lib/utils"

const VIEWS = [
  { to: MANAGEMENT_HOME, label: "Management", icon: Gauge },
  { to: BUYER_HOME, label: "Buyer", icon: ShoppingCart },
] as const

/**
 * Switches between the two views. Management sees one number and the map,
 * the buyer works through parts, approvals, inbox and log.
 */
export function ViewSwitch({ className }: { className?: string }) {
  return (
    <nav aria-label="View" className={cn("inline-flex rounded-lg border bg-muted/50 p-0.5", className)}>
      {VIEWS.map((view) => (
        <NavLink
          key={view.to}
          to={view.to}
          end={view.to === MANAGEMENT_HOME}
          className={({ isActive }) =>
            cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
              isActive && "bg-background text-foreground shadow-xs",
            )
          }
        >
          <view.icon className="size-3.5" />
          {view.label}
        </NavLink>
      ))}
    </nav>
  )
}
