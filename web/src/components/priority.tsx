import type { Priority } from "@shared/api.ts"
import { PRIORITY } from "@/lib/queue"
import { cn } from "@/lib/utils"

// Three bars like a signal meter: urgent fills all three in red, important two in amber, normal one in grey,
// later none. The colour sits on the bars only, never behind text.

const LIT: Record<Priority, { bars: number; color: string }> = {
  urgent: { bars: 3, color: "fill-lost" },
  high: { bars: 2, color: "fill-uncertain" },
  normal: { bars: 1, color: "fill-muted-foreground" },
  low: { bars: 0, color: "fill-muted-foreground" },
}

export function PriorityIcon({ priority, className }: { priority: Priority; className?: string }) {
  const { bars, color } = LIT[priority]
  return (
    <svg
      viewBox="0 0 14 14"
      role="img"
      aria-label={PRIORITY[priority].label}
      className={cn("size-3.5 shrink-0", className)}
    >
      <title>{PRIORITY[priority].label}</title>
      {[4, 7, 10].map((height, index) => (
        <rect
          key={height}
          x={1 + index * 4.5}
          y={13 - height}
          width={3}
          height={height}
          rx={0.75}
          className={index < bars ? color : "fill-muted-foreground/25"}
        />
      ))}
    </svg>
  )
}
