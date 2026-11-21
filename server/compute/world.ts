import type { Fact, ObjectRef } from "../../shared/api.ts";
import { all, json } from "../db.ts";
import { packingHoursLeft } from "../clock.ts";
import { fmtDate, fmtHours, fmtQty, fmtTime, settings, toTime } from "./settings.ts";
import { newestFact } from "./state.ts";
import type { PoLineRow, ReceiptRow, ShipmentRow, Snapshot } from "./state.ts";
import type { Scenario } from "./scenario.ts";

// The state of the launch as the compute tools see it: per part every piece of supply with its class
// (safe, uncertain, lost) and the time it is at the line. A scenario changes pieces before they are classified.
// Pure function of a snapshot and a scenario. No database access in here.

/** A part id as a document states it, matched to a part we know regardless of case and separator. */
let knownParts: Map<string, string> | null = null;
function partIdOf(raw: string | null | undefined): string | null {
  const key = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!raw?.trim()) return null;
  knownParts ??= new Map(all<{ part_id: string }>("SELECT part_id FROM components").map((r) => [key(r.part_id), r.part_id]));
  return knownParts.get(key(raw)) ?? raw.trim();
}

export type SupplyClass = "safe" | "uncertain" | "lost";

export interface SupplyItem {
  key: string;
  kind: "lot" | "shipment" | "order" | "gap" | "added";
  part_id: string;
  qty: number;
  cls: SupplyClass;
  at: number;              // when the units are at the line (ms). 0 = already in the building
  label: string;
  detail: string;
  when: string | null;     // ISO time shown with the line (receipt date, expected arrival)
  object: ObjectRef | null;
  fact_ids: number[];
}

export interface ProductState {
  product_id: string;
  name: string;
  demandKnown: boolean;
  demand: number;
  packed: number;
  remaining: number;
  rate: number | null;     // copies per hour, null = unknown
  rank: number | null;     // 1 = gets short parts first
  packedAt: number;        // the time the packed figure is from: packing hours count from here
  hoursLeft: number;
  parts: { part_id: string; qty_per: number }[];
  fact_ids: number[];
}

export interface LineState {
  po_line_id: string;
  supplier_id: string | null;
  status: string;
  ordered: number;
  confirmed: number | null;
  shipped: number | null;
  shipped_at: string | null;   // date of the document that states the shipped quantity
  received: number;
  open: number;
  promised: string | null;
  artwork_rev: string | null;
  balance_qty: number | null;
  balance_eta: string | null;
  release_condition: string | null; // what the supplier wants before it ships this line
  shipments: string[];
  fact_ids: number[];
}

export interface LotState {
  lot_id: string;
  part_id: string;
  erp_qty: number;          // per the stock list
  qty: number;              // after a scenario override
  received: string | null;
  supplier_id: string | null;
  po_line_id: string | null;
  revision: string | null;
  quality: string | null;
  inspection: string | null;
  cls: SupplyClass;
  reason: string;
  disputed_low: number | null; // lowest quantity a source states for this lot, when sources disagree
  fact_ids: number[];
}

export interface InboundState {
  shipment_id: string;
  part_id: string;
  qty: number;
  stated: boolean;          // true = a document states the quantity, false = derived from the open order quantity
  split: boolean;           // true = an order line is spread over several shipments and nothing says how
  status: string;
  mode: string | null;
  eta: string | null;
  destination: string | null;
  at: number | null;        // expected time at the line
  overdue: boolean;
  departed: boolean;
  lines: string[];
  cls: SupplyClass;
  reason: string;
  fact_ids: number[];
}

export interface PartState {
  part_id: string;
  description: string;
  category: string;
  critical: boolean;
  drawing_rev: string | null;
  blocked_rev: string | null;
  use_up_old_rev: boolean;
  products: { product_id: string; name: string; qty_per: number }[];
  suppliers: { supplier_id: string; name: string }[];
  need: number;
  lines: LineState[];
  lots: LotState[];
  inbound: InboundState[];
  erp_stock: number;
  arrived: number;          // received so far on orders that still have an open line
  consumed: number;         // used since the stock count
  consumed_fact_ids: number[];
  data_gap: boolean;
  supplied_within: string | null;
  unlimited: boolean;       // what-if: the part is taken out of the equation
  items: SupplyItem[];
  fact_ids: number[];
}

export interface World {
  snap: Snapshot;
  now: number;
  deadline: number;
  products: ProductState[];
  parts: Map<string, PartState>;
  problems: string[];       // things in the scenario that do not match the data
}

const lower = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
const normRev = (s: string | null | undefined): string | null => {
  const t = (s ?? "").trim().replace(/^rev(ision)?\.?\s*/i, "").toUpperCase();
  return t || null;
};
const ids = (...facts: (Fact | null | undefined)[]): number[] => facts.filter((f): f is Fact => !!f).map((f) => f.id);
const uniq = <T>(a: T[]): T[] => [...new Set(a)];
const day = (s: string | null | undefined) => (s ?? "").slice(0, 10);
const HOUR = 3_600_000;

const CLOSED_LINE = new Set(["delivered", "cancelled", "canceled", "closed"]);
const CLOSED_SHIPMENT = new Set(["delivered", "received", "cancelled", "canceled"]);
const NOT_DEPARTED = new Set(["booked", "planned", ""]);

export interface BuildOptions { unlimitedParts?: Set<string> }

export function buildWorld(snap: Snapshot, scenario: Scenario, opts: BuildOptions = {}): World {
  const { fx } = snap;
  const problems: string[] = [];
  const hoursFrom = (t: number) => packingHoursLeft(new Date(t));

  // ---- products of the launch ----
  const today = new Date(snap.now).toISOString().slice(0, 10);
  const launch = snap.products.filter((p) => lower(p.lifecycle) === "launch");
  const products: ProductState[] = launch.map((p) => {
    const demandF = fx.latest("product", p.product_id, "day_one_demand");
    const packedF = fx.latest("product", p.product_id, "packed");
    const rateF = fx.latest("product", p.product_id, "pack_rate_per_hour");
    const rankF = fx.latest("product", p.product_id, "priority_rank");
    const numOf = (f: Fact | null) => (f && Number.isFinite(Number(f.value)) ? Number(f.value) : null);
    const demand = numOf(demandF), packed = numOf(packedF) ?? 0;
    let packedAt = snap.now;
    if (settings.capacityFrom === "packed_fact" && packedF) packedAt = Math.min(snap.now, toTime(packedF.observed_at) ?? snap.now);
    const bom = snap.bom.filter((b) => b.parent_id === p.product_id && (!b.valid_from || b.valid_from <= today) && (!b.valid_to || b.valid_to >= today) && b.qty_per > 0);
    return {
      product_id: p.product_id, name: p.name ?? p.product_id, demandKnown: demand !== null, demand: demand ?? 0, packed,
      remaining: demand === null ? 0 : Math.max(0, demand - packed),
      rate: numOf(rateF) !== null && numOf(rateF)! > 0 ? numOf(rateF) : null, rank: numOf(rankF), packedAt, hoursLeft: hoursFrom(packedAt),
      parts: bom.map((b) => ({ part_id: b.child_id, qty_per: b.qty_per })),
      fact_ids: ids(demandF, packedF, rateF, rankF),
    };
  });
  const productById = new Map(products.map((p) => [p.product_id, p]));

  // ---- the scenario, indexed. The position in the list decides which change wins. ----
  const lotOverride = new Map<string, { type: "block" | "release"; i: number }>();
  const lotQty = new Map<string, number>();
  const shipRemove = new Map<string, { part: string | null; i: number }[]>();
  const shipMove = new Map<string, { arrival: number | null; delay: number | null; i: number }>();
  const partDown = new Map<string, number>();
  const dropUncertain = new Map<string, number>();
  const added: { part: string; qty: number; at: number; cls: "safe" | "uncertain"; i: number }[] = [];
  const unlimited = new Set(opts.unlimitedParts ?? []);
  scenario.changes.forEach((c, i) => {
    switch (c.type) {
      case "block_lot": lotOverride.set(c.lot_id!, { type: "block", i }); break;
      case "release_lot": lotOverride.set(c.lot_id!, { type: "release", i }); break;
      case "set_lot_quantity": lotQty.set(c.lot_id!, Math.max(0, c.quantity ?? 0)); break;
      case "remove_shipment": shipRemove.set(c.shipment_id!, [...(shipRemove.get(c.shipment_id!) ?? []), { part: c.part_id, i }]); shipMove.delete(c.shipment_id!); break;
      case "move_shipment": shipMove.set(c.shipment_id!, { arrival: c.arrival ? new Date(c.arrival).getTime() : null, delay: c.delay_hours, i }); shipRemove.delete(c.shipment_id!); break;
      case "part_unavailable": partDown.set(c.part_id!, i); break;
      case "drop_uncertain": dropUncertain.set(c.part_id!, i); break;
      case "add_supply": added.push({ part: c.part_id!, qty: c.quantity ?? 0, at: c.arrival ? new Date(c.arrival).getTime() : 0, cls: c.certainty === "safe" ? "safe" : "uncertain", i }); break;
      case "already_short": break; // measured by the what-if tool, it does not change the state
    }
  });
  const seenLots = new Set<string>(), seenShipments = new Set<string>();

  // ---- parts of the launch products ----
  const partIds = uniq(products.flatMap((p) => p.parts.map((x) => x.part_id)));
  const receiptsByLine = new Map<string, ReceiptRow[]>();
  for (const r of snap.receipts) if (r.po_number && r.po_line !== null) { const k = `${r.po_number}/${r.po_line}`; receiptsByLine.set(k, [...(receiptsByLine.get(k) ?? []), r]); }
  const receiptById = new Map(snap.receipts.map((r) => [r.gr_number, r]));
  const stockDate = snap.stock.reduce((m, r) => (r.snapshot_date && r.snapshot_date > m ? r.snapshot_date : m), "");

  // open shipments with the overlay of facts
  interface Ship { row: ShipmentRow; status: string; eta: string | null; mode: string | null; pos: string[]; parts: string[]; fact_ids: number[] }
  const ships: Ship[] = snap.shipments.map((row) => {
    const st = fx.latest("shipment", row.shipment_id, "status"), eta = fx.latest("shipment", row.shipment_id, "eta"), mode = fx.latest("shipment", row.shipment_id, "mode");
    const qtyParts = fx.ofObject("shipment", row.shipment_id).filter((f) => f.field === "qty" && f.part_id).map((f) => f.part_id!);
    return { row, status: lower(st?.value ?? row.status), eta: eta?.value ?? row.eta, mode: mode?.value ?? row.mode, pos: json<string[]>(row.po_numbers, []),
      parts: uniq([...json<string[]>(row.part_ids, []), ...qtyParts]), fact_ids: ids(st, eta, mode) };
  }).filter((s) => !CLOSED_SHIPMENT.has(s.status));

  const packable = (part: PartState, at: number): number => {
    // Units arriving at `at` can only be packed during the packing hours that are left after it.
    let units = 0;
    for (const u of part.products) {
      const p = productById.get(u.product_id)!;
      if (p.demandKnown && p.remaining <= 0) continue;
      const h = hoursFrom(Math.max(at, p.packedAt));
      if (h <= 0) continue;
      if (p.rate === null || !p.demandKnown) return Infinity;
      units += p.rate * h * u.qty_per;
    }
    return units;
  };

  const parts = new Map<string, PartState>();
  for (const partId of partIds) {
    const comp = snap.components.get(partId);
    const revF = fx.latest("part", partId, "drawing_rev"), critF = fx.latest("part", partId, "critical");
    const blockedF = fx.latest("part", partId, "blocked_rev"), useUpF = fx.latest("part", partId, "use_up_old_rev");
    const withinF = fx.latest("part", partId, "supplied_within");
    const useUp = useUpF?.value === "true";
    const blockedRev = useUp ? null : normRev(blockedF?.value);
    const users = products.flatMap((p) => p.parts.filter((x) => x.part_id === partId).map((x) => ({ product_id: p.product_id, name: p.name, qty_per: x.qty_per })));
    const supplierIds = uniq(snap.supplierParts.filter((sp) => sp.part_id === partId).map((sp) => sp.supplier_id));
    const part: PartState = {
      part_id: partId, description: comp?.description ?? partId, category: comp?.category ?? "",
      critical: critF ? critF.value === "true" : Boolean(comp?.critical),
      drawing_rev: revF?.value ?? comp?.drawing_rev ?? null, blocked_rev: normRev(blockedF?.value), use_up_old_rev: useUp,
      products: users, suppliers: supplierIds.map((id) => ({ supplier_id: id, name: snap.suppliers.get(id)?.name ?? id })),
      need: users.reduce((s, u) => s + productById.get(u.product_id)!.remaining * u.qty_per, 0),
      lines: [], lots: [], inbound: [], erp_stock: 0, arrived: 0, consumed: 0, consumed_fact_ids: [], data_gap: false,
      supplied_within: partIdOf(withinF?.value), unlimited: unlimited.has(partId), items: [],
      fact_ids: ids(revF, critF, blockedF, useUpF, withinF),
    };
    parts.set(partId, part);
    const down = partDown.get(partId) ?? -1;
    const supplierName = (id: string | null) => (id ? (snap.suppliers.get(id)?.name ?? id) : "unknown supplier");

    // ---- open order lines ----
    const allLines = snap.poLines.filter((l) => l.part_id === partId);
    const lineState = (l: PoLineRow): LineState => {
      const f = (field: string) => fx.latest("po_line", l.po_line_id, field);
      const statusF = f("erp_status"), orderedF = f("qty_ordered"), confF = f("confirmed_qty"), shipF = f("shipped_qty"), recF = f("received_qty");
      const promF = f("promised_date"), confDateF = f("confirmed_date"), revLineF = f("artwork_rev"), balF = f("balance_qty"), balEtaF = f("balance_eta"), condF = f("release_condition");
      const num = (x: Fact | null) => (x && Number.isFinite(Number(x.value)) ? Number(x.value) : null);
      const ordered = num(orderedF) ?? l.quantity ?? 0;
      const booked = (receiptsByLine.get(l.po_line_id) ?? []).reduce((s, r) => s + (r.qty_received ?? 0), 0);
      const received = Math.max(booked, num(recF) ?? 0);
      const confirmed = num(confF), shipped = num(shipF);
      return {
        po_line_id: l.po_line_id, supplier_id: l.supplier_id, status: lower(statusF?.value ?? l.status), ordered, confirmed, shipped, shipped_at: shipF?.observed_at ?? null, received,
        open: Math.max(0, (confirmed ?? ordered) - received),
        promised: newestFact([promF, confDateF].filter((x): x is Fact => !!x))?.value ?? l.promised_date,
        artwork_rev: normRev(revLineF?.value), balance_qty: num(balF), balance_eta: balEtaF?.value ?? null, release_condition: condF?.value ?? null, shipments: [],
        fact_ids: ids(statusF, orderedF, confF, shipF, recF, promF, confDateF, revLineF, balF, balEtaF, condF),
      };
    };
    part.lines = allLines.map(lineState).filter((l) => !CLOSED_LINE.has(l.status) && l.ordered > 0);
    const openPos = new Set(part.lines.map((l) => l.po_line_id.split("/")[0]));
    part.arrived = snap.receipts.filter((r) => r.part_id === partId && r.po_number && openPos.has(r.po_number)).reduce((s, r) => s + (r.qty_received ?? 0), 0);

    // ---- lots in stock ----
    const lotRows = new Map<string, { qty: number; date: string | null }>();
    for (const r of snap.stock.filter((s) => s.material_id === partId)) {
      if (r.batch) lotRows.set(r.batch, { qty: r.quantity ?? 0, date: r.snapshot_date });
      else if ((r.quantity ?? 0) > 0) lotRows.set(`${partId}:unbatched`, { qty: r.quantity ?? 0, date: r.snapshot_date });
    }
    // lots that only a document knows about, if it is newer than the stock list
    for (const f of fx.ofField("lot", "stock_qty")) {
      if (f.part_id !== partId || lotRows.has(f.object_id)) continue;
      if (day(f.observed_at) >= stockDate && fx.latest("lot", f.object_id, "stock_qty")?.id === f.id) lotRows.set(f.object_id, { qty: Number(f.value) || 0, date: f.observed_at });
    }
    let stockFact: Fact | null = null;
    for (const [lotId, row] of lotRows) {
      const stockF = fx.latest("lot", lotId, "stock_qty");
      if (stockF && (!stockFact || (stockF.observed_at ?? "") > (stockFact.observed_at ?? ""))) stockFact = stockF;
      const erpQty = stockF && Number.isFinite(Number(stockF.value)) ? Number(stockF.value) : row.qty;
      const gr = receiptById.get(lotId);
      const lineId = gr?.po_number && gr.po_line !== null ? `${gr.po_number}/${gr.po_line}` : null;
      const lotRevF = fx.latest("lot", lotId, "revision"), lineRevF = lineId ? fx.latest("po_line", lineId, "artwork_rev") : null;
      const qualF = fx.latest("lot", lotId, "quality_status"), inspF = fx.latest("lot", lotId, "inspection_result");
      const revision = normRev(lotRevF?.value) ?? normRev(lineRevF?.value);
      const quality = qualF ? lower(qualF.value) : null, inspection = inspF ? lower(inspF.value) : null;
      const rejected = !!inspection && inspection.startsWith("reject");
      // A lot that failed inspection stays blocked until a later document says it is unrestricted.
      const releasedLater = quality === "unrestricted" && !!inspF && (qualF!.observed_at ?? "") > (inspF.observed_at ?? "");
      const qualityBlocked = quality === "blocked" || quality === "concession_required" || (rejected && !releasedLater);
      const qtyFacts = fx.current("lot", lotId, "qty").filter((f) => Number.isFinite(Number(f.value)));
      const stated = uniq(qtyFacts.map((f) => Number(f.value)));
      const override = lotOverride.get(lotId);
      const scenQty = lotQty.get(lotId);
      const qty = scenQty ?? erpQty;
      const low = scenQty === undefined && stated.length > 1 && Math.min(...stated) < erpQty ? Math.min(...stated) : null;
      seenLots.add(lotId);

      let cls: SupplyClass = "safe", reason = "usable";
      if (blockedRev && revision === blockedRev) { cls = "lost"; reason = `revision ${revision} must not be packed any more`; }
      else if (qualityBlocked) { cls = "uncertain"; reason = rejected ? "failed the incoming inspection, usable only if it is released" : `quality status ${quality!.replace(/_/g, " ")}, usable only if it is released`; }
      else if (blockedRev && !revision) { cls = "uncertain"; reason = `revision unknown while revision ${blockedRev} is blocked`; }
      if (override && override.i > down) {
        if (override.type === "block") { cls = "lost"; reason = "assumed blocked in this what-if"; }
        else { cls = "safe"; reason = "assumed released in this what-if"; }
      } else if (down >= 0) { cls = "lost"; reason = "part assumed unavailable in this what-if"; }
      else if (cls === "uncertain" && dropUncertain.has(partId)) { cls = "lost"; reason = `${reason}; assumed not released in this what-if`; }

      part.lots.push({
        lot_id: lotId, part_id: partId, erp_qty: erpQty, qty, received: gr?.gr_date ?? fx.val("lot", lotId, "received_date"), supplier_id: gr?.supplier_id ?? null, po_line_id: lineId,
        revision, quality, inspection, cls, reason, disputed_low: override?.type === "release" ? null : low,
        fact_ids: uniq([...ids(stockF, lotRevF, lineRevF, qualF, inspF), ...(low !== null ? qtyFacts.map((f) => f.id) : [])]),
      });
    }
    part.lots.sort((a, b) => (a.received ?? "").localeCompare(b.received ?? "") || a.lot_id.localeCompare(b.lot_id));
    part.erp_stock = part.lots.reduce((s, l) => s + l.erp_qty, 0);

    // ---- parts used since the stock count ----
    if (settings.adjustStockForPacking && part.lots.length) {
      const stockDay = day(stockFact?.observed_at) || stockDate;
      for (const u of users) {
        const p = productById.get(u.product_id)!;
        const packedNow = fx.latest("product", u.product_id, "packed");
        if (!packedNow) continue;
        const cur = fx.current("product", u.product_id, "packed");
        const ref = newestFact(cur.filter((f) => stockFact && f.source_path === stockFact.source_path)) ?? newestFact(cur.filter((f) => stockDay && day(f.observed_at) && day(f.observed_at) <= stockDay));
        if (!ref || ref.id === packedNow.id) continue;
        const used = Math.max(0, p.packed - Number(ref.value)) * u.qty_per;
        if (used > 0) { part.consumed += used; part.consumed_fact_ids.push(ref.id, packedNow.id); }
      }
    }

    // lots → supply pieces. What was packed since the count is taken off usable stock first (oldest lot first).
    interface Piece { lot: LotState; qty: number; cls: SupplyClass; note: string }
    const pieces: Piece[] = [];
    for (const lot of part.lots) {
      if (lot.cls === "safe" && lot.disputed_low !== null) {
        pieces.push({ lot, qty: Math.min(lot.qty, lot.disputed_low), cls: "safe", note: "" });
        const rest = lot.qty - Math.min(lot.qty, lot.disputed_low);
        const dropped = dropUncertain.has(partId);
        if (rest > 0) pieces.push({ lot, qty: rest, cls: dropped ? "lost" : "uncertain", note: `the stock list shows ${fmtQty(lot.erp_qty)} but another document states ${fmtQty(lot.disputed_low)} for this lot` });
      } else pieces.push({ lot, qty: lot.qty, cls: lot.cls, note: "" });
    }
    let toTake = part.consumed;
    for (const cls of ["safe", "uncertain", "lost"] as const) for (const pc of pieces) {
      if (toTake <= 0 || pc.cls !== cls) continue;
      const take = Math.min(pc.qty, toTake); pc.qty -= take; toTake -= take;
    }
    for (const pc of pieces) {
      if (pc.qty <= 0) continue;
      const { lot } = pc;
      const label = pc.cls === "safe" ? "Stock" : pc.cls === "uncertain" ? "Stock on hold" : "Stock not usable";
      const bits = [`Lot ${lot.lot_id}`, lot.received ? `received ${fmtDate(lot.received)}` : null, lot.supplier_id ? `from ${supplierName(lot.supplier_id)}` : null, lot.po_line_id ? `order ${lot.po_line_id}` : null,
        lot.revision ? `revision ${lot.revision}` : null, pc.note || (pc.cls === "safe" ? null : lot.reason)].filter(Boolean);
      part.items.push({ key: `lot:${lot.lot_id}:${pc.cls}`, kind: "lot", part_id: partId, qty: pc.qty, cls: pc.cls, at: 0, label, detail: bits.join(", "), when: lot.received, object: { type: "lot", id: lot.lot_id }, fact_ids: lot.fact_ids });
    }

    // ---- inbound shipments ----
    const partShips = ships.filter((s) => s.parts.includes(partId) || s.pos.some((po) => part.lines.some((l) => l.po_line_id.startsWith(`${po}/`)) && s.parts.length === 0));
    const linesOf = (s: Ship) => part.lines.filter((l) => s.pos.includes(l.po_line_id.split("/")[0]));
    const qtyFactOf = (s: Ship) => { const f = fx.latest("shipment", s.row.shipment_id, "qty", partId); return f && Number.isFinite(Number(f.value)) ? f : null; };
    for (const s of partShips) for (const l of linesOf(s)) l.shipments.push(s.row.shipment_id);
    // What a line still has to deliver, and how much of it documents already place on a shipment.
    const lineAvail = (l: LineState) => (l.shipped !== null && l.shipments.length === 1 ? Math.min(l.shipped, l.open) : l.open);
    const statedOnLine = (l: LineState): number => partShips.filter((s) => l.shipments.includes(s.row.shipment_id) && qtyFactOf(s)).reduce((sum, s) => {
      const ls = linesOf(s); const total = ls.reduce((a, x) => a + x.open, 0);
      return sum + (total > 0 ? Math.min(l.open, Number(qtyFactOf(s)!.value) * (l.open / total)) : 0);
    }, 0);
    const placed = new Map<string, number>(); // per line: units placed on shipments
    for (const s of partShips) {
      const sid = s.row.shipment_id;
      const qf = qtyFactOf(s);
      const ls = linesOf(s);
      let qty = 0, split = false;
      if (qf) {
        qty = Number(qf.value);
        // A newer document of the supplier about the only order line on this shipment wins over an older plan.
        const only = ls.length === 1 && ls[0].shipments.length === 1 ? ls[0] : null;
        if (only && only.shipped !== null && (only.shipped_at ?? "") > (qf.observed_at ?? "")) qty = Math.min(qty, only.shipped);
        const total = ls.reduce((a, x) => a + x.open, 0);
        for (const l of ls) placed.set(l.po_line_id, (placed.get(l.po_line_id) ?? 0) + (total > 0 ? qty * (l.open / total) : 0));
      } else {
        for (const l of ls) {
          const unstated = l.shipments.filter((id) => { const o = partShips.find((x) => x.row.shipment_id === id); return o && !qtyFactOf(o); }).length;
          const share = Math.max(0, lineAvail(l) - statedOnLine(l)) / Math.max(1, unstated);
          if (unstated > 1) split = true;
          qty += share; placed.set(l.po_line_id, (placed.get(l.po_line_id) ?? 0) + share);
        }
      }
      seenShipments.add(sid);
      if (qty <= 0) continue;

      // arrival at the distribution center: ETA at the shipment's destination plus the onward leg
      const etaMs = toTime(s.eta);
      const dest = s.row.destination, site = s.row.dest_site;
      let legHours = 0, legNote = "";
      if (dest && site && dest !== site) {
        const leg = snap.routes.filter((r) => r.origin === dest && r.destination === site && r.transit_days !== null).sort((a, b) => a.transit_days! - b.transit_days!)[0];
        legHours = leg ? leg.transit_days! * 24 : settings.unknownOnwardLegHours;
        legNote = leg ? `${leg.mode ?? "onward"} leg ${dest} to ${site} ${fmtQty(leg.transit_days!)} day${leg.transit_days === 1 ? "" : "s"}` : `no route ${dest} to ${site} on file, ${fmtHours(settings.unknownOnwardLegHours)} h assumed`;
      }
      let at = etaMs === null ? null : etaMs + (legHours + settings.inboundHandlingHours) * HOUR;
      let overdue = false;
      if (at !== null && at < snap.now) {
        // Expected by now but not booked in: assume it still needs the rest of its way from this moment.
        overdue = true;
        at = snap.now + ((s.status === "in_delivery" ? 0 : legHours) + settings.inboundHandlingHours) * HOUR;
      }
      const move = shipMove.get(sid);
      if (move && at !== null) at = move.arrival ?? at + (move.delay ?? 0) * HOUR;
      else if (move && move.arrival !== null) at = move.arrival;

      // revision of the load: what a document says about the shipment, else what the order lines were made to
      const shipRevF = fx.latest("shipment", sid, "revision", partId);
      const revs = shipRevF ? [normRev(shipRevF.value)] : ls.map((l) => l.artwork_rev);
      let cls: SupplyClass = "uncertain", reason = "on its way, not received yet";
      const removed = (shipRemove.get(sid) ?? []).find((r) => !r.part || r.part === partId);
      if (blockedRev && revs.length && revs.every((r) => r === blockedRev)) { cls = "lost"; reason = `made to revision ${blockedRev}, which must not be packed any more`; }
      else if (at === null) { cls = "lost"; reason = "no arrival date on file"; }
      else if (at > snap.deadline || hoursFrom(at) <= 0) { cls = "lost"; reason = "at the distribution center after the last packing hour"; }
      if (removed && removed.i > down) { cls = "lost"; reason = "assumed not to arrive in this what-if"; }
      else if (down > (move?.i ?? -1) && down >= 0) { cls = "lost"; reason = "part assumed unavailable in this what-if"; }
      else if (cls === "uncertain" && (dropUncertain.get(partId) ?? -1) > (move?.i ?? -1)) { cls = "lost"; reason = "assumed not to arrive in this what-if"; }

      const inbound: InboundState = {
        shipment_id: sid, part_id: partId, qty, stated: !!qf, split, status: s.status, mode: s.mode, eta: s.eta, destination: dest, at, overdue, departed: !NOT_DEPARTED.has(s.status),
        lines: ls.map((l) => l.po_line_id), cls, reason, fact_ids: uniq([...s.fact_ids, ...ids(qf, shipRevF), ...ls.flatMap((l) => l.fact_ids)]),
      };
      part.inbound.push(inbound);

      const line0 = ls[0];
      const short = line0 && ls.length === 1 && line0.shipments.length === 1 && line0.shipped !== null && line0.shipped < line0.open ? `supplier shipped ${fmtQty(line0.shipped)} of ${fmtQty(line0.open)}` : null;
      const bits = [sid, s.mode, s.row.supplier_id ? supplierName(s.row.supplier_id) : null, ls.length ? `order ${ls.map((l) => l.po_line_id).join(", ")}` : null,
        s.eta ? `ETA ${fmtDate(s.eta)}${dest && dest !== site ? ` at ${dest}` : ""}` : "no ETA", legNote || null,
        at !== null ? `${overdue ? "overdue, " : ""}at the distribution center ${overdue ? "at the earliest " : "by "}${fmtTime(at)}` : null,
        short, ...ls.filter((l) => l.release_condition).map((l) => `supplier's condition for ${l.po_line_id}: ${l.release_condition}`), qf ? null : split ? "quantity split evenly over the shipments of the order, nothing states the split" : "quantity from the open order quantity",
        cls === "lost" ? reason : null].filter(Boolean);
      const label = s.status === "booked" ? "Booked" : s.status === "delayed" ? "Delayed in transit" : s.status === "arrived_port" ? "At the port" : s.status === "in_delivery" ? "In delivery" : "In transit";
      const base = { kind: "shipment" as const, part_id: partId, at: at ?? Infinity, label, when: at !== null ? new Date(at).toISOString() : null, object: { type: "shipment" as const, id: sid }, fact_ids: inbound.fact_ids };
      if (cls === "uncertain") {
        const fits = Math.min(qty, packable(part, at!));
        if (fits > 0) part.items.push({ ...base, key: `shipment:${sid}`, qty: fits, cls: "uncertain", detail: bits.join(", ") });
        if (qty - fits > 0.5) part.items.push({ ...base, key: `shipment:${sid}:late`, qty: qty - fits, cls: "lost", detail: [...bits, `only ${fmtHours(hoursFrom(at!))} packing hours are left after it arrives`].join(", ") });
      } else part.items.push({ ...base, key: `shipment:${sid}`, qty, cls, detail: bits.join(", ") });
    }

    // ---- what is ordered but on no shipment ----
    for (const l of part.lines) {
      const rest = l.open - (placed.get(l.po_line_id) ?? 0);
      if (rest <= 0.5) continue;
      const isBalance = l.shipments.length > 0;
      const dateStr = isBalance ? (l.balance_eta ?? null) : l.promised;
      const at = toTime(dateStr);
      let cls: SupplyClass = "lost", reason = "";
      if (at === null) reason = "no date on file";
      else if (at < snap.now) reason = `was due ${fmtDate(dateStr)} and no shipment is on file`;
      else if (at > snap.deadline || hoursFrom(at) <= 0) reason = "due after the last packing hour";
      else if (blockedRev && l.artwork_rev === blockedRev) reason = `made to revision ${blockedRev}, which must not be packed any more`;
      else if (down >= 0 || dropUncertain.has(partId)) reason = "assumed not to arrive in this what-if";
      else cls = "uncertain";
      const fits = cls === "uncertain" ? Math.min(rest, packable(part, at!)) : 0;
      const detail = [`Order ${l.po_line_id}`, supplierName(l.supplier_id), isBalance ? `balance after ${l.shipments.join(", ")}` : "no shipment on file",
        dateStr ? `${isBalance ? "supplier names" : "promised for"} ${fmtDate(dateStr)}` : null, reason || null].filter(Boolean).join(", ");
      const base = { kind: "order" as const, part_id: partId, at: at ?? Infinity, label: isBalance ? "Order balance" : "On order", detail, when: at !== null ? new Date(at).toISOString() : null, object: { type: "po_line" as const, id: l.po_line_id }, fact_ids: l.fact_ids };
      if (fits > 0) part.items.push({ ...base, key: `order:${l.po_line_id}`, qty: fits, cls: "uncertain" });
      if (rest - fits > 0.5) part.items.push({ ...base, key: `order:${l.po_line_id}:late`, qty: rest - fits, cls: "lost" });
    }

    // ---- nothing on file at all: a gap in the data, not proof that the part is missing ----
    const anyOrder = allLines.length > 0, anyReceipt = snap.receipts.some((r) => r.part_id === partId), anyShipment = snap.shipments.some((s) => json<string[]>(s.part_ids, []).includes(partId)) || fx.ofField("shipment", "qty").some((f) => f.part_id === partId);
    part.data_gap = part.erp_stock <= 0 && !anyOrder && !anyReceipt && !anyShipment && !part.supplied_within;
    if (part.data_gap && part.need > 0 && down < 0) {
      const note = snap.supplierParts.find((sp) => sp.part_id === partId && sp.note)?.note;
      const dropped = dropUncertain.has(partId);
      part.items.push({ key: `gap:${partId}`, kind: "gap", part_id: partId, qty: part.need, cls: dropped ? "lost" : "uncertain", at: 0, label: "No record",
        detail: `No stock, no order and no receipt on file for this part. This is a gap in the data, not proof that the part is missing${note ? `. Supplier list says: ${note}` : ""}.`, when: null, object: { type: "part", id: partId }, fact_ids: [] });
    }

    // ---- supply added by the what-if ----
    for (const a of added.filter((x) => x.part === partId && x.i > down)) {
      const at = a.at <= snap.now ? 0 : a.at;
      const late = at > snap.deadline || (at > 0 && hoursFrom(at) <= 0);
      const dropped = a.cls === "uncertain" && (dropUncertain.get(partId) ?? -1) > a.i;
      const fits = late || dropped ? 0 : Math.min(a.qty, at === 0 ? a.qty : packable(part, at));
      const base = { kind: "added" as const, part_id: partId, at, label: "What-if supply", when: at ? new Date(at).toISOString() : null, object: null, fact_ids: [] };
      const detail = `Assumed in this what-if: ${fmtQty(a.qty)} units${at ? `, at the distribution center ${fmtTime(at)}` : ", already in the building"}`;
      if (fits > 0) part.items.push({ ...base, key: `added:${a.i}`, qty: fits, cls: a.cls, detail });
      if (a.qty - fits > 0.5) part.items.push({ ...base, key: `added:${a.i}:late`, qty: a.qty - fits, cls: "lost", detail: `${detail}, too late to be packed` });
    }
  }

  // ---- does the scenario point at things that exist? ----
  for (const c of scenario.changes) {
    if (c.part_id && !parts.has(c.part_id)) problems.push(`${c.part_id} is not a part of a launch product.`);
    if (c.lot_id && !seenLots.has(c.lot_id)) problems.push(`Lot ${c.lot_id} is not in stock for a launch part.`);
    if (c.shipment_id && !seenShipments.has(c.shipment_id)) problems.push(`Shipment ${c.shipment_id} is not an open shipment of a launch part.`);
  }

  return { snap, now: snap.now, deadline: snap.deadline, products, parts, problems: uniq(problems) };
}

/** Totals of a part's supply by class. */
export function supplyTotals(part: PartState): { safe: number; uncertain: number; lost: number; usable_stock: number } {
  const sum = (f: (i: SupplyItem) => boolean) => part.items.filter(f).reduce((s, i) => s + i.qty, 0);
  return { safe: sum((i) => i.cls === "safe"), uncertain: sum((i) => i.cls === "uncertain"), lost: sum((i) => i.cls === "lost"), usable_stock: sum((i) => i.cls === "safe" && i.kind === "lot") };
}
