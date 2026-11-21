import type { ReactNode } from "react"
import { num } from "@/lib/format"
import { cn } from "@/lib/utils"

/** A round filter button with a count. Active is filled. */
export function FilterChip({
  active,
  onClick,
  children,
  count,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
  count: number
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
        active ? "border-foreground bg-foreground text-background hover:bg-foreground/90" : "text-foreground",
      )}
    >
      {children}
      <span className={cn("tabular-nums", active ? "text-background/70" : "text-muted-foreground")}>{num(count)}</span>
    </button>
  )
}

/** Two or three options side by side, one of them on. Same look as the view switch in the sidebar. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (value: T) => void
  label: string
}) {
  return (
    <div className="inline-flex rounded-lg border bg-muted/50 p-0.5 text-xs" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium whitespace-nowrap text-muted-foreground tabular-nums outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            value === option.value && "bg-background text-foreground shadow-xs",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
