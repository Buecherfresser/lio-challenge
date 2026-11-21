import { Clock, RefreshCw } from "lucide-react"
import { Outlet, useLocation } from "react-router"
import { AppSidebar } from "@/components/app-sidebar"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { duration, timeOnly, weekdayTime } from "@/lib/format"
import { NAV_ITEMS } from "@/lib/nav"
import { useOverview } from "@/lib/queries"

function pageTitle(pathname: string): string {
  const match = NAV_ITEMS.find((item) => (item.to === "/" ? pathname === "/" : pathname.startsWith(item.to)))
  return match?.label ?? ""
}

function Countdown() {
  const { data, isPending, isError } = useOverview()
  if (isPending) return <Skeleton className="h-4 w-48" />
  if (!data) return null

  const msLeft = new Date(data.deadline).getTime() - new Date(data.now).getTime()
  const sync = data.last_sync
  return (
    <div className="flex min-w-0 items-center gap-4 text-sm">
      <span className="flex items-center gap-1.5 truncate">
        <Clock className="size-3.5 shrink-0 text-muted-foreground" />
        {msLeft > 0 ? (
          <span className="truncate">
            <span className="font-semibold tabular-nums">{duration(msLeft)}</span>
            <span className="text-muted-foreground"> to {weekdayTime(data.deadline)}</span>
          </span>
        ) : (
          <span className="truncate font-semibold">The deadline has passed ({weekdayTime(data.deadline)})</span>
        )}
      </span>
      <span className="hidden items-center gap-1.5 whitespace-nowrap text-muted-foreground lg:flex">
        <RefreshCw className="size-3.5 shrink-0" />
        {isError ? (
          <span className="font-medium text-foreground">No connection. Numbers may be old.</span>
        ) : (
          <>
            {sync ? `Last sync ${timeOnly(sync.at)}` : "No sync yet"}
            <span className="rounded-full border px-1.5 text-xs leading-4.5">{data.mode.source}</span>
          </>
        )}
      </span>
    </div>
  )
}

export function AppLayout() {
  const { pathname } = useLocation()
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="h-svh min-w-0">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1.5" />
          <Separator orientation="vertical" className="mr-1 data-vertical:h-4 data-vertical:self-center" />
          <h1 className="text-sm font-medium">{pageTitle(pathname)}</h1>
          <div className="ml-auto min-w-0 pl-4">
            <Countdown />
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

/** Standard page frame. The inbox brings its own because it fills the height. */
export function Page({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-[1400px] space-y-6 p-4 md:p-6">{children}</div>
}
