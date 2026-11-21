import type { Fact } from "@shared/api.ts"
import { ORIGIN_LABEL, dateTime, pct } from "@/lib/format"
import { cn } from "@/lib/utils"

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 })

/** Facts store every value as text. Dates and numbers read better formatted. */
function factValue(value: string): string {
  if (ISO_DATE_TIME.test(value)) return dateTime(value)
  if (PLAIN_NUMBER.test(value)) return decimal.format(Number(value))
  return value
}

/** One small gray line per fact: where the value comes from and who read it. */
export function FactSources({
  factIds,
  facts,
  showValue = false,
  className,
}: {
  factIds: number[]
  facts: Fact[] | undefined
  showValue?: boolean
  className?: string
}) {
  if (factIds.length === 0) return null
  const byId = new Map((facts ?? []).map((fact) => [fact.id, fact]))
  return (
    <ul className={cn("space-y-0.5 text-xs text-muted-foreground", className)}>
      {factIds.map((id) => {
        const fact = byId.get(id)
        if (!fact) return <li key={id}>Fact #{id}</li>
        return (
          <li key={id} className="break-words">
            {showValue && (
              <span className="text-foreground">
                {fact.field}: {factValue(fact.value)}
                {fact.unit ? ` ${fact.unit}` : ""}{" "}
              </span>
            )}
            <span className="font-mono text-[11px]">{fact.source_path}</span>
            {fact.source_version > 1 && ` v${fact.source_version}`} · {ORIGIN_LABEL[fact.origin]} ·{" "}
            {pct(fact.confidence)} sure
            {fact.quote && <span className="italic"> · “{fact.quote}”</span>}
          </li>
        )
      })}
    </ul>
  )
}
