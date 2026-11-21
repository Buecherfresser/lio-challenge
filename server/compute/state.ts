import { VOCAB } from "../vocab.ts";
import type { Fact } from "../../shared/api.ts";
import { config } from "../config.ts";
import { all, get, kv } from "../db.ts";
import { now } from "../clock.ts";
import { currentFacts } from "../facts.ts";
import { settings } from "./settings.ts";

// Everything the compute tools read from the database, loaded once and kept for a few seconds.
// Base tables give the skeleton. Facts lie on top: where a fact exists, its latest value wins over the base table.

export interface FactIndex {
  /** What each source currently says about a field. */
  current(type: string, id: string, field: string, partId?: string | null): Fact[];
  /** The newest statement across sources (by document date, then by when it was recorded). */
  latest(type: string, id: string, field: string, partId?: string | null): Fact | null;
  val(type: string, id: string, field: string, partId?: string | null): string | null;
  num(type: string, id: string, field: string, partId?: string | null): number | null;
  ofObject(type: string, id: string): Fact[];
  ofField(type: string, field: string): Fact[];
}

// A date without a time counts as the start of that day, so it sorts before a timestamp of the same day.
const factKey = (f: Fact) => `${!f.observed_at ? "" : f.observed_at.length === 10 ? `${f.observed_at}T00:00:00.000Z` : f.observed_at}#${String(f.id).padStart(12, "0")}`;
export const newestFact = (rows: Fact[]): Fact | null => (rows.length ? rows.reduce((a, b) => (factKey(b) > factKey(a) ? b : a)) : null);

// Free-text fields where one source can make several separate statements, which all stand.
const VOCAB_FREE = new Set(Object.values(VOCAB).flatMap((t) => Object.entries(t!.fields).filter(([, d]) => d.compare === false).map(([k]) => k)));

export function makeFactIndex(facts: Fact[]): FactIndex {
  const byKey = new Map<string, Fact[]>(), byObject = new Map<string, Fact[]>(), byField = new Map<string, Fact[]>();
  const push = (m: Map<string, Fact[]>, k: string, f: Fact) => { const a = m.get(k); if (a) a.push(f); else m.set(k, [f]); };
  for (const f of facts) {
    push(byKey, `${f.object_type}|${f.object_id}|${f.field}`, f);
    push(byObject, `${f.object_type}|${f.object_id}`, f);
    push(byField, `${f.object_type}|${f.field}`, f);
  }
  // What each source says now: of several statements by the same source about the same thing, the last one counts.
  const current = (type: string, id: string, field: string, partId?: string | null) => {
    const rows = (byKey.get(`${type}|${id}|${field}`) ?? []).filter((f) => !partId || f.part_id === partId);
    const last = new Map<string, Fact>();
    for (const f of rows) {
      const k = `${f.source_path}|${f.part_id ?? ""}|${VOCAB_FREE.has(field) ? f.value : ""}`;
      const prev = last.get(k);
      if (!prev || f.id > prev.id) last.set(k, f);
    }
    return [...last.values()];
  };
  const latest = (type: string, id: string, field: string, partId?: string | null) => newestFact(current(type, id, field, partId));
  return {
    current, latest,
    val: (t, i, f, p) => latest(t, i, f, p)?.value ?? null,
    num: (t, i, f, p) => { const v = latest(t, i, f, p)?.value; return v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v); },
    ofObject: (t, i) => byObject.get(`${t}|${i}`) ?? [],
    ofField: (t, f) => byField.get(`${t}|${f}`) ?? [],
  };
}

export interface ProductRow { product_id: string; name: string | null; lifecycle: string | null }
export interface BomRow { parent_id: string; child_id: string; qty_per: number; valid_from: string | null; valid_to: string | null }
export interface ComponentRow { part_id: string; description: string | null; category: string | null; critical: number | null; drawing_rev: string | null }
export interface SupplierRow { supplier_id: string; name: string | null; country: string | null; currency: string | null; status: string | null; qualification_status: string | null; contact_name: string | null; contact_email: string | null; language: string | null; category: string | null }
export interface SupplierPartRow { supplier_id: string; part_id: string; share: number | null; unit_price: number | null; currency: string | null; lead_time_days: number | null; moq: number | null; is_primary: number | null; note: string | null }
export interface PoLineRow { po_line_id: string; po_number: string; po_line: number; supplier_id: string | null; part_id: string; quantity: number | null; unit_price: number | null; currency: string | null; order_date: string | null; requested_date: string | null; promised_date: string | null; actual_delivery_date: string | null; status: string | null }
export interface ReceiptRow { gr_number: string; gr_date: string | null; po_number: string | null; po_line: number | null; supplier_id: string | null; part_id: string; qty_ordered: number | null; qty_received: number | null; delivery_note: string | null; remark: string | null }
export interface StockRow { snapshot_date: string | null; material_id: string; batch: string | null; quantity: number | null }
export interface ShipmentRow { shipment_id: string; mode: string | null; reference: string | null; supplier_id: string | null; po_numbers: string | null; part_ids: string | null; route_id: string | null; origin: string | null; destination: string | null; via: string | null; dest_site: string | null; etd: string | null; eta: string | null; status: string | null; note: string | null; updated_at: string | null; last_lat: number | null; last_lon: number | null }
export interface RouteRow { route_id: string; origin: string | null; destination: string | null; mode: string | null; transit_days: number | null }

export interface Snapshot {
  loadedAt: number;
  signature: string;
  now: number;
  deadline: number;
  fx: FactIndex;
  products: ProductRow[];
  bom: BomRow[];
  components: Map<string, ComponentRow>;
  suppliers: Map<string, SupplierRow>;
  supplierParts: SupplierPartRow[];
  poLines: PoLineRow[];
  receipts: ReceiptRow[];
  stock: StockRow[];
  shipments: ShipmentRow[];
  routes: RouteRow[];
  /** What-if changes of approved decisions that are in flight (ordered, not delivered yet), oldest first. See planOf in parts.ts. */
  planned: { decision_id: number; scenario: string }[];
  /** Results computed from this snapshot, so one request (and the next few seconds) computes each table once. */
  memo: Map<string, unknown>;
}

/** Changes whenever the data the compute tools read may have changed. */
export function dataSignature(): string {
  const f = get<{ m: number | null }>("SELECT MAX(id) AS m FROM facts")?.m ?? 0;
  return `${f}|${kv.get("last_sync") ?? ""}|${kv.get(PLAN_REV) ?? "0"}`;
}

const PLAN_REV = "plan_rev";
/** Call after a decision was approved, closed or withdrawn, so the numbers are computed again with the new plan. */
export function planChanged() { kv.set(PLAN_REV, String(Number(kv.get(PLAN_REV) ?? "0") + 1)); cached = null; }

let cached: Snapshot | null = null;

export function loadSnapshot(fresh = false): Snapshot {
  const t = Date.now();
  if (!fresh && cached && t - cached.loadedAt < settings.cacheSeconds * 1000 && cached.signature === dataSignature()) return cached;
  const signature = dataSignature();
  cached = {
    loadedAt: t,
    signature,
    now: now().getTime(),
    deadline: new Date(config.deadline).getTime(),
    fx: makeFactIndex(currentFacts()),
    products: all<ProductRow>("SELECT product_id, name, lifecycle FROM products ORDER BY product_id"),
    bom: all<BomRow>("SELECT parent_id, child_id, qty_per, valid_from, valid_to FROM bom"),
    components: new Map(all<ComponentRow>("SELECT part_id, description, category, critical, drawing_rev FROM components").map((r) => [r.part_id, r])),
    suppliers: new Map(all<SupplierRow>("SELECT supplier_id, name, country, currency, status, qualification_status, contact_name, contact_email, language, category FROM suppliers").map((r) => [r.supplier_id, r])),
    supplierParts: all<SupplierPartRow>("SELECT supplier_id, part_id, share, unit_price, currency, lead_time_days, moq, is_primary, note FROM supplier_parts"),
    poLines: all<PoLineRow>("SELECT po_line_id, po_number, po_line, supplier_id, part_id, quantity, unit_price, currency, order_date, requested_date, promised_date, actual_delivery_date, status FROM po_lines"),
    receipts: all<ReceiptRow>("SELECT gr_number, gr_date, po_number, po_line, supplier_id, part_id, qty_ordered, qty_received, delivery_note, remark FROM goods_receipts"),
    stock: all<StockRow>("SELECT snapshot_date, material_id, batch, quantity FROM stock ORDER BY id"),
    shipments: all<ShipmentRow>("SELECT shipment_id, mode, reference, supplier_id, po_numbers, part_ids, route_id, origin, destination, via, dest_site, etd, eta, status, note, updated_at, last_lat, last_lon FROM shipments ORDER BY shipment_id"),
    routes: all<RouteRow>("SELECT route_id, origin, destination, mode, transit_days FROM routes"),
    planned: all<{ decision_id: number; scenario: string }>("SELECT id AS decision_id, scenario FROM decisions WHERE status = 'approved' AND stage IN ('approved', 'ordered') ORDER BY id"),
    memo: new Map(),
  };
  return cached;
}

/** Compute something once per snapshot. */
export function memo<T>(snap: Snapshot, key: string, fn: () => T): T {
  if (!snap.memo.has(key)) snap.memo.set(key, fn());
  return snap.memo.get(key) as T;
}

const FACT_COLS = "id, object_type, object_id, field, value, unit, part_id, source_path, source_version, observed_at, recorded_at, origin, confidence, quote";

/**
 * Fields that hold several values per document (approval rules, offers, notices, contract terms):
 * every statement of the newest version of each source, without repeats.
 */
export function listFacts(snap: Snapshot, type: string, field: string): Fact[] {
  return memo(snap, `list:${type}:${field}`, () => {
    const rows = all<Fact>(
      `SELECT ${FACT_COLS} FROM facts f WHERE object_type = ? AND field = ?
         AND source_version = (SELECT MAX(g.source_version) FROM facts g WHERE g.source_path = f.source_path AND g.object_type = f.object_type AND g.field = f.field)
       ORDER BY id`, type, field);
    const seen = new Map<string, Fact>();
    for (const f of rows) seen.set(`${f.object_id}|${f.part_id ?? ""}|${f.source_path}|${f.value}`, f);
    return [...seen.values()];
  });
}
