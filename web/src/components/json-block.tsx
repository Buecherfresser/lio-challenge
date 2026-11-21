import { ChevronRight } from "lucide-react"
import { useState } from "react"
import { pretty } from "@/lib/format"
import { cn } from "@/lib/utils"

/** A labelled value that stays folded until someone wants to read the raw data. */
export function JsonBlock({
  label,
  value,
  defaultOpen = false,
  className,
}: {
  label: string
  value: unknown
  defaultOpen?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  if (value === null || value === undefined) return null
  return (
    <div className={cn("min-w-0", className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        {label}
      </button>
      {open && (
        <pre className="mt-1 max-h-72 overflow-auto rounded-md border bg-muted/50 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
          {pretty(value)}
        </pre>
      )}
    </div>
  )
}
