import { loadSnapshot, memo } from "./state.ts";
import type { Snapshot } from "./state.ts";

// How a supplier delivered in the past: promised against actual date from both purchase order exports,
// ordered against received quantity and the remarks from the goods receipts.

export interface Reliability {
  supplier_id: string;
  name: string;
  part_id: string | null;         // null = all parts of the supplier
  deliveries: number;             // delivered order lines with a promised and an actual date
  on_time_share: number | null;   // 0..1
  avg_delay_days: number | null;  // over all deliveries, early and on time count as 0
  avg_delay_when_late_days: number | null;
  max_delay_days: number | null;
  late_last_10: number | null;    // of the ten most recent deliveries, how many were late
  receipts: number;               // goods receipts with ordered and received quantity
  short_share: number | null;     // share of receipts with less than ordered
  over_share: number | null;
  remarks: { remark: string; count: number }[];
  open_lines: number;
  open_lines_past_promised: number; // open order lines whose promised date has passed
  first_delivery: string | null;
  last_delivery: string | null;
}

const days = (a: string, b: string) => Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
const share = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 1000) / 1000 : null);
const round1 = (x: number) => Math.round(x * 10) / 10;

export function supplierReliability(supplierId: string, partId: string | null = null, snap: Snapshot = loadSnapshot()): Reliability | null {
  const supplier = snap.suppliers.get(supplierId);
  const lines = snap.poLines.filter((l) => l.supplier_id === supplierId && (!partId || l.part_id === partId));
  const receipts = snap.receipts.filter((r) => r.supplier_id === supplierId && (!partId || r.part_id === partId));
  if (!supplier && !lines.length && !receipts.length) return null;

  const delivered = lines.filter((l) => l.promised_date && l.actual_delivery_date && (l.quantity ?? 0) > 0).sort((a, b) => a.actual_delivery_date!.localeCompare(b.actual_delivery_date!));
  const delays = delivered.map((l) => Math.max(0, days(l.promised_date!, l.actual_delivery_date!)));
  const late = delays.filter((d) => d > 0);
  const counted = receipts.filter((r) => r.qty_ordered !== null && r.qty_received !== null && r.qty_ordered > 0);
  const remarks = new Map<string, number>();
  for (const r of receipts) if (r.remark) remarks.set(r.remark, (remarks.get(r.remark) ?? 0) + 1);
  const today = new Date(snap.now).toISOString().slice(0, 10);
  const open = lines.filter((l) => !l.actual_delivery_date && !["delivered", "cancelled"].includes((l.status ?? "").toLowerCase()) && (l.quantity ?? 0) > 0);

  return {
    supplier_id: supplierId, name: supplier?.name ?? supplierId, part_id: partId,
    deliveries: delivered.length,
    on_time_share: share(delays.length - late.length, delays.length),
    avg_delay_days: delays.length ? round1(delays.reduce((a, b) => a + b, 0) / delays.length) : null,
    avg_delay_when_late_days: late.length ? round1(late.reduce((a, b) => a + b, 0) / late.length) : null,
    max_delay_days: delays.length ? Math.max(...delays) : null,
    late_last_10: delays.length ? delays.slice(-10).filter((d) => d > 0).length : null,
    receipts: counted.length,
    short_share: share(counted.filter((r) => r.qty_received! < r.qty_ordered!).length, counted.length),
    over_share: share(counted.filter((r) => r.qty_received! > r.qty_ordered!).length, counted.length),
    remarks: [...remarks].map(([remark, count]) => ({ remark, count })).sort((a, b) => b.count - a.count),
    open_lines: open.length,
    open_lines_past_promised: open.filter((l) => l.promised_date && l.promised_date < today).length,
    first_delivery: delivered[0]?.actual_delivery_date ?? null,
    last_delivery: delivered[delivered.length - 1]?.actual_delivery_date ?? null,
  };
}

/** All suppliers, and per supplier each part it delivers. */
export function allReliability(snap: Snapshot = loadSnapshot()): Reliability[] {
  return memo(snap, "reliability", () => {
    const out: Reliability[] = [];
    for (const id of [...snap.suppliers.keys()].sort()) {
      const total = supplierReliability(id, null, snap);
      if (total) out.push(total);
      for (const part of [...new Set(snap.poLines.filter((l) => l.supplier_id === id).map((l) => l.part_id))].sort()) {
        const r = supplierReliability(id, part, snap);
        if (r) out.push(r);
      }
    }
    return out;
  });
}
