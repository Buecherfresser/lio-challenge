import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

export function EmptyState({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex min-h-24 items-center justify-center rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  )
}

/** Shown when a request fails and there is nothing older to show. Polling keeps trying. */
export function ErrorState({ what, className }: { what: string; className?: string }) {
  return (
    <EmptyState className={className}>
      <span>
        <span className="font-medium text-foreground">We can't load {what}.</span> We try again every 5 seconds.
      </span>
    </EmptyState>
  )
}
