import { Loader2, RefreshCw, SkipForward } from "lucide-react"
import { NavLink, useLocation } from "react-router"
import type { Status } from "@shared/api.ts"
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
import { Skeleton } from "@/components/ui/skeleton"
import { ProductMark } from "@/components/product-mark"
import { ViewSwitch } from "@/components/view-switch"
import { num, usd } from "@/lib/format"
import { NAV_ITEMS } from "@/lib/nav"
import { useOverview, useReplayNext, useRunAll, useStatus } from "@/lib/queries"

const AGENTS: { key: keyof Status["running"]; label: string }[] = [
  { key: "sync", label: "Sync" },
  { key: "data_agent", label: "Data agent" },
  { key: "risk_agent", label: "Risk agent" },
  { key: "action_agent", label: "Action agent" },
]

function StatusBlock() {
  const { data: status, isPending, isError } = useStatus()
  const runAll = useRunAll()
  const replayNext = useReplayNext()

  if (isPending) return <Skeleton className="h-40 w-full" />
  if (isError && !status) {
    return <p className="px-1 text-xs text-muted-foreground">We can't reach the server. We try again every 5 seconds.</p>
  }

  const replay = status.replay
  return (
    <div className="space-y-3">
      <dl className="space-y-1 px-1 text-xs">
        {AGENTS.map((agent) => {
          const running = status.running[agent.key]
          return (
            <div key={agent.key} className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">{agent.label}</dt>
              <dd className="flex items-center gap-1">
                {running ? (
                  <>
                    <Loader2 className="size-3 animate-spin" />
                    <span className="font-medium">running</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">idle</span>
                )}
              </dd>
            </div>
          )
        })}
        <div className="flex items-center justify-between gap-2 border-t pt-1.5">
          <dt className="text-muted-foreground">Documents waiting</dt>
          <dd className="font-medium tabular-nums">{num(status.queue.documents_pending)}</dd>
        </div>
        {status.queue.documents_failed > 0 && (
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">Documents failed</dt>
            <dd className="font-medium tabular-nums">{num(status.queue.documents_failed)}</dd>
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Spend</dt>
          <dd className="font-medium tabular-nums">{usd(status.spend_usd)}</dd>
        </div>
      </dl>
      <div className="space-y-1.5">
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          disabled={runAll.isPending}
          onClick={() => runAll.mutate(undefined)}
        >
          <RefreshCw className={runAll.isPending || status.running.sync ? "animate-spin" : undefined} />
          Sync now
        </Button>
        {replay && (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            disabled={replayNext.isPending || replay.position >= replay.total}
            onClick={() => replayNext.mutate(undefined)}
          >
            <SkipForward />
            Next snapshot ({replay.position}/{replay.total})
          </Button>
        )}
        {runAll.data?.started === false && !runAll.isPending && (
          <p className="px-1 text-xs text-muted-foreground">A run is already going.</p>
        )}
        {(runAll.isError || replayNext.isError) && (
          <p className="px-1 text-xs text-muted-foreground">That did not work. Try again.</p>
        )}
      </div>
    </div>
  )
}

export function AppSidebar() {
  const { pathname } = useLocation()
  const { setOpenMobile } = useSidebar()
  const { data: overview } = useOverview()

  const badges: Record<string, number | undefined> = {
    "/approvals": overview?.counts.pending_decisions,
    "/inbox": overview?.counts.needs_approval_mails,
  }

  return (
    <Sidebar>
      <SidebarHeader>
        <ProductMark />
        <ViewSwitch className="mx-2 mt-1 flex" />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => {
                const active = pathname.startsWith(item.to)
                const badge = badges[item.to]
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild isActive={active}>
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
      <SidebarFooter className="border-t p-3">
        <StatusBlock />
      </SidebarFooter>
    </Sidebar>
  )
}
