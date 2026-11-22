import { Loader2, RefreshCw, SkipForward } from "lucide-react"
import { useRef, useState } from "react"
import { Link, NavLink, useLocation } from "react-router"
import { Button } from "@/components/ui/button"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ProductMark } from "@/components/product-mark"
import { ViewSwitch } from "@/components/view-switch"
import { runningAgents } from "@/lib/agents"
import { num } from "@/lib/format"
import { NAV_ITEMS, navItemFor } from "@/lib/nav"
import { useOverview, useReplayNext, useRunAll, useStatus } from "@/lib/queries"

/** "Sync now" and, in replay, "Next snapshot". Small enough for the header. */
export function SyncControls() {
  const { data: status } = useStatus()
  const runAll = useRunAll()
  const replayNext = useReplayNext()
  const busy = runAll.isPending || runningAgents(status).length > 0
  const replay = status?.replay

  return (
    <div className="flex shrink-0 items-center gap-1">
      {replay && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={replayNext.isPending || replay.position >= replay.total}
              onClick={() => replayNext.mutate(undefined)}
            >
              <SkipForward />
              <span className="tabular-nums">
                {replay.position}/{replay.total}
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Load the next stored snapshot of the portal</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Sync now"
            disabled={runAll.isPending}
            onClick={() => runAll.mutate(undefined)}
          >
            <RefreshCw className={busy ? "animate-spin" : undefined} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {runAll.data?.started === false && !runAll.isPending
            ? "A run is already going"
            : runAll.isError || replayNext.isError
              ? "That did not work. Try again."
              : "Sync now and let the agents look at what changed"}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

/** One quiet line: what the agents are doing. The details live in the history. */
function AgentActivity() {
  const { data: status, isError } = useStatus()
  const running = runningAgents(status)
  const waiting = status?.queue.documents_pending ?? 0
  return (
    <Link
      to="/log"
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
    >
      {isError && !status ? (
        <span>We can't reach the server.</span>
      ) : running.length > 0 ? (
        <>
          <Loader2 className="size-3 shrink-0 animate-spin" />
          <span className={`truncate ${RAIL_HIDDEN}`}>{running.join(", ")} at work</span>
        </>
      ) : (
        <>
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
          <span className={`truncate ${RAIL_HIDDEN}`}>
            Agents idle{waiting > 0 ? ` · ${num(waiting)} documents waiting` : ""}
          </span>
        </>
      )}
    </Link>
  )
}

/** Fades text out while the sidebar is a rail of icons, so only the icons show. */
const RAIL_HIDDEN = "transition-opacity duration-150 group-data-[collapsible=icon]:opacity-0"

export function AppSidebar() {
  const { pathname } = useLocation()
  const { setOpenMobile } = useSidebar()
  // Hovering or tabbing into the rail opens it at once. Leaving closes it after a short pause, so a mouse that
  // slips over the edge for a moment does not make it flicker.
  const [peek, setPeek] = useState(false)
  const closeTimer = useRef<number | undefined>(undefined)
  const show = () => {
    window.clearTimeout(closeTimer.current)
    setPeek(true)
  }
  const hide = () => {
    window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setPeek(false), 150)
  }
  const { data: overview } = useOverview()
  const active = navItemFor(pathname)

  const counts = overview?.counts
  const badges: Record<string, number | undefined> = {
    ["/decisions"]: counts ? counts.pending_decisions + counts.needs_approval_mails : undefined,
    ["/tasks"]: counts ? counts.open_tasks + counts.colleague_tasks : undefined,
  }

  return (
    <Sidebar
      collapsible="icon"
      peek={peek}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={show}
      onBlurCapture={hide}
    >
      <SidebarHeader>
        <ProductMark labelClassName={RAIL_HIDDEN} />
        <ViewSwitch className={`mx-2 mt-1 flex ${RAIL_HIDDEN}`} />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => {
                const badge = badges[item.to]
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild isActive={item === active}>
                      <NavLink to={item.to} onClick={() => setOpenMobile(false)}>
                        <item.icon />
                        <span>{item.label}</span>
                      </NavLink>
                    </SidebarMenuButton>
                    {badge ? <SidebarMenuBadge>{num(badge)}</SidebarMenuBadge> : null}
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-2">
        <AgentActivity />
      </SidebarFooter>
    </Sidebar>
  )
}
