import type { ReactNode } from "react"
import { Link } from "react-router"
import { ArrowRight } from "lucide-react"
import type { MapReplacement, MapShipment } from "@shared/api.ts"
import { StatusDot } from "@/components/status"
import { dateTime, eur, num } from "@/lib/format"
import { cn } from "@/lib/utils"
import { MODE_LABEL } from "./modes"

// The small info cards that open on a vehicle or a replacement route.

function money(value: MapShipment["value"], valueEur: number | null): string {
  if (valueEur !== null) return eur(valueEur)
  if (!value) return "no price"
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: value.currency, maximumFractionDigits: 0 }).format(
      value.amount,
    )
  } catch {
    return `${num(value.amount)} ${value.currency}`
  }
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function ShipmentCard({ shipment: s, variant }: { shipment: MapShipment; variant: "management" | "buyer" }) {
  const names = s.parts.map((p) => p.description).join(", ") || s.shipment_id
  const part = s.parts.find((p) => p.status !== "ok") ?? s.parts[0]
  return (
    <div className="space-y-2.5">
      <div className="space-y-0.5">
        <div className="flex items-center gap-2 font-medium">
          <StatusDot level={s.status_class} />
          <span className="min-w-0 truncate">{names}</span>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {MODE_LABEL[s.mode]} · {s.supplier?.name ?? "Unknown supplier"}
        </p>
      </div>
      <Facts
        rows={[
          ["At the distribution center", dateTime(s.at_line ?? s.eta)],
          ["Quantity", num(s.quantity)],
          ["Value", money(s.value, s.value_eur)],
        ]}
      />
      {variant === "buyer" && part && (
        <Link
          to={`/parts/${encodeURIComponent(part.part_id)}`}
          className="inline-flex items-center gap-1 text-xs font-medium hover:underline"
        >
          Open part
          <ArrowRight className="size-3" />
        </Link>
      )}
    </div>
  )
}

export function ReplacementCard({ replacement: r }: { replacement: MapReplacement }) {
  const approved = r.status === "approved"
  return (
    <div className="space-y-2.5">
      <div className="space-y-0.5">
        <p className="font-medium leading-snug">{r.title}</p>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className={cn(
              "inline-flex h-4 items-center rounded-full px-1.5 text-[10px] font-medium",
              approved ? "bg-decision text-decision-foreground" : "border border-dashed border-decision text-decision",
            )}
          >
            {approved ? "Approved" : "Proposed"}
          </span>
          {MODE_LABEL[r.mode]}
        </p>
      </div>
      <Facts
        rows={[
          ["Arrival", dateTime(r.arrival)],
          ["Quantity", r.quantity === null ? "n/a" : num(r.quantity)],
          ["Copies saved", num(r.copies_saved)],
          ["Cost", r.cost_eur === null ? "n/a" : eur(r.cost_eur)],
        ]}
      />
    </div>
  )
}
