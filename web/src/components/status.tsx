import { cn } from "@/lib/utils"

/** Everything that carries one of the three states. "ok" and "safe" look the same. */
export type Level = "ok" | "safe" | "uncertain" | "lost" | "info"

const LEVEL_LABEL: Record<Level, string> = {
  ok: "OK",
  safe: "Safe",
  uncertain: "Uncertain",
  lost: "Lost",
  info: "Info",
}

const DOT: Record<Level, string> = {
  ok: "bg-foreground",
  safe: "bg-foreground",
  uncertain: "bg-uncertain",
  lost: "bg-lost",
  info: "border border-muted-foreground/60",
}

export function StatusDot({ level, className }: { level: Level; className?: string }) {
  return (
    <span
      role="img"
      aria-label={LEVEL_LABEL[level]}
      title={LEVEL_LABEL[level]}
      className={cn("inline-block size-2 shrink-0 rounded-full", DOT[level], className)}
    />
  )
}

export function StatusBadge({ level, className }: { level: Level; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border px-2 text-xs font-medium",
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", DOT[level])} />
      {LEVEL_LABEL[level]}
    </span>
  )
}
