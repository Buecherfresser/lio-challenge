import crypto from "node:crypto";
import type { Fact, IssueType, ObjectType } from "../../../shared/api.ts";
import { config } from "../../config.ts";
import { all, get, json, run, tx } from "../../db.ts";
import { hoursBetween, now } from "../../clock.ts";
import { logEvent } from "../../events.ts";
import { currentFacts } from "../../facts.ts";
import { fieldDef, sameValue } from "../../vocab.ts";
import { factOrder, localDay, sayDate, sayHours, sayNumber, sayQty } from "./rows.ts";
import type { IssueDb } from "./rows.ts";

// Step 2 of the data agent. No model here: code compares what the sources say with what Soony expects
// and with each other, and keeps the list of deviations (issues) up to date.
//
// Scope, to keep the list short: only things that can still matter for the launch. Order lines that are open,
// shipments on the open list, lots that are in stock, parts of products in their launch, and their suppliers.

/** Statements a model was less sure about than this are not used to raise a deviation. */
const MIN_CONFIDENCE = 0.5;
/** A notice older than this is history, not news. */
const NOTICE_MAX_AGE_DAYS = 45;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------
// State: the base tables and the current facts, loaded once per run
// ---------------------------------------------------------------------------------------------

interface PoLineRow { po_line_id: string; po_number: string; po_line: number; supplier_id: string | null; part_id: string | null; quantity: number | null; unit_price: number | null; currency: string | null; order_date: string | null; requested_date: string | null; promised_date: string | null; status: string | null; incoterm: string | null }
interface ShipmentRow { shipment_id: string; mode: string | null; reference: string | null; supplier_id: string | null; po_numbers: string[]; part_ids: string[]; origin: string | null; destination: string | null; etd: string | null; eta: string | null; status: string | null; updated_at: string | null }
interface ReceiptRow { gr_number: string; gr_date: string | null; po_number: string | null; po_line: number | null; supplier_id: string | null; part_id: string | null; qty_ordered: number | null; qty_received: number | null; delivery_note: string | null; remark: string | null }
interface SupplierRow { supplier_id: string; name: string; language: string | null; incoterm: string | null; status: string | null; qualification_status: string | null; contact_email: string | null }

export interface RuleState {
  now: Date;
  today: string;          // calendar day in Hamburg
  deadline: string;       // ISO timestamp
  deadlineDay: string;
  year: number;
  facts: Fact[];
  byKey: Map<string, Fact[]>;
  parts: Map<string, { description: string | null; drawing_rev: string | null }>;
  suppliers: Map<string, SupplierRow>;
  products: Map<string, { name: string; lifecycle: string | null }>;
  launchProducts: Set<string>;
  bom: { parent_id: string; child_id: string; qty_per: number }[];
  liveParts: Set<string>;
  liveSuppliers: Set<string>;
  poLines: Map<string, PoLineRow>;
  liveLines: PoLineRow[];
  shipments: Map<string, ShipmentRow>;
  liveShipments: ShipmentRow[];
  receipts: Map<string, ReceiptRow>;
  lotStock: Map<string, { part_id: string; quantity: number }>;   // lots that are in stock
  partStock: Map<string, number>;
  productStock: Map<string, number>;                              // packed copies per the stock list
  stockDate: string | null;
}

const fk = (type: string, id: string, field: string) => `${type}|${id}|${field}`;
const parseList = (s: string | null): string[] => json<string[]>(s, []);
const numOf = (f: Fact | null | undefined): number | null => (f && Number.isFinite(Number(f.value)) ? Number(f.value) : null);
const stamp = factOrder;

export function loadState(): RuleState {
  const t = now();
  const facts = currentFacts().filter((f) => f.confidence >= MIN_CONFIDENCE);
  const byKey = new Map<string, Fact[]>();
  for (const f of facts) {
    const k = fk(f.object_type, f.object_id, f.field);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(f);
  }

  const today = localDay(t);
  const products = new Map(all<{ product_id: string; name: string; lifecycle: string | null }>("SELECT product_id, name, lifecycle FROM products").map((p) => [p.product_id, { name: p.name, lifecycle: p.lifecycle }]));
  const launch = [...products].filter(([, p]) => (p.lifecycle ?? "").toLowerCase() === "launch").map(([id]) => id);
  // No product marked as launch: then every product counts, so the rules still say something.
  const launchProducts = new Set(launch.length ? launch : products.keys());
  const bom = all<{ parent_id: string; child_id: string; qty_per: number | null; valid_from: string | null; valid_to: string | null }>("SELECT parent_id, child_id, qty_per, valid_from, valid_to FROM bom")
    .filter((b) => (!b.valid_from || b.valid_from <= today) && (!b.valid_to || b.valid_to >= today))
    .map((b) => ({ parent_id: b.parent_id, child_id: b.child_id, qty_per: b.qty_per ?? 1 }));
  const liveParts = new Set(bom.filter((b) => launchProducts.has(b.parent_id)).map((b) => b.child_id));

  const poLines = new Map(all<PoLineRow>("SELECT po_line_id, po_number, po_line, supplier_id, part_id, quantity, unit_price, currency, order_date, requested_date, promised_date, status, incoterm FROM po_lines").map((l) => [l.po_line_id, l]));
  const liveLines = [...poLines.values()].filter((l) => (l.status === "open" || l.status === "awaiting_approval") && l.part_id !== null && liveParts.has(l.part_id));

  const shipments = new Map(all<Omit<ShipmentRow, "po_numbers" | "part_ids"> & { po_numbers: string | null; part_ids: string | null }>(
    "SELECT shipment_id, mode, reference, supplier_id, po_numbers, part_ids, origin, destination, etd, eta, status, updated_at FROM shipments")
    .map((s) => [s.shipment_id, { ...s, po_numbers: parseList(s.po_numbers), part_ids: parseList(s.part_ids) }]));
  const liveShipments = [...shipments.values()].filter((s) => s.part_ids.some((p) => liveParts.has(p)));

  const receipts = new Map(all<ReceiptRow>("SELECT gr_number, gr_date, po_number, po_line, supplier_id, part_id, qty_ordered, qty_received, delivery_note, remark FROM goods_receipts").map((r) => [r.gr_number, r]));
  const lotStock = new Map<string, { part_id: string; quantity: number }>();
  const partStock = new Map<string, number>();
  const productStock = new Map<string, number>();
  let stockDate: string | null = null;
  for (const s of all<{ material_id: string; batch: string | null; quantity: number | null; snapshot_date: string | null }>("SELECT material_id, batch, quantity, snapshot_date FROM stock")) {
    const q = s.quantity ?? 0;
    if (s.snapshot_date && (!stockDate || s.snapshot_date > stockDate)) stockDate = s.snapshot_date;
    if (products.has(s.material_id)) { productStock.set(s.material_id, (productStock.get(s.material_id) ?? 0) + q); continue; }
    partStock.set(s.material_id, (partStock.get(s.material_id) ?? 0) + q);
    if (s.batch && q > 0) lotStock.set(s.batch, { part_id: s.material_id, quantity: (lotStock.get(s.batch)?.quantity ?? 0) + q });
  }

  const suppliers = new Map(all<SupplierRow>("SELECT supplier_id, name, language, incoterm, status, qualification_status, contact_email FROM suppliers").map((s) => [s.supplier_id, s]));
  const liveSuppliers = new Set<string>();
  for (const sp of all<{ supplier_id: string; part_id: string }>("SELECT supplier_id, part_id FROM supplier_parts")) if (liveParts.has(sp.part_id)) liveSuppliers.add(sp.supplier_id);
  for (const l of liveLines) if (l.supplier_id) liveSuppliers.add(l.supplier_id);

  return {
    now: t, today, deadline: config.deadline, deadlineDay: localDay(config.deadline), year: Number(today.slice(0, 4)),
    facts, byKey,
    parts: new Map(all<{ part_id: string; description: string | null; drawing_rev: string | null }>("SELECT part_id, description, drawing_rev FROM components").map((p) => [p.part_id, { description: p.description, drawing_rev: p.drawing_rev }])),
    suppliers, products, launchProducts, bom, liveParts, liveSuppliers, poLines, liveLines, shipments, liveShipments, receipts, lotStock, partStock, productStock, stockDate,
  };
}

/** What the sources currently say about one field of one object. */
function said(s: RuleState, type: string, id: string, field: string, partId?: string | null): Fact[] {
  const rows = s.byKey.get(fk(type, id, field)) ?? [];
  return partId === undefined ? rows : rows.filter((f) => (f.part_id ?? null) === (partId ?? null));
}
/** The newest statement: by the date of the source, then by when it was stored. */
function newest(s: RuleState, type: string, id: string, field: string, partId?: string | null): Fact | null {
  const rows = said(s, type, id, field, partId);
  return rows.length ? rows.reduce((a, b) => (stamp(b) > stamp(a) ? b : a)) : null;
}

// ---- names for texts ----
const partName = (s: RuleState, id: string | null) => (id ? (s.parts.get(id)?.description ?? id) : "an unknown part");
const supplierName = (s: RuleState, id: string | null) => (id ? (s.suppliers.get(id)?.name ?? id) : "the supplier");
const lineName = (l: { po_number: string; po_line: number }) => `order ${l.po_number} line ${l.po_line}`;
const d = (s: RuleState, iso: string | null | undefined) => sayDate(iso, s.year);
const sourceName = (path: string) => (path.startsWith("mail:") ? "a supplier mail" : path === "human" ? `a note from ${config.customer.name}` : (path.split("/").pop() ?? path));
const ids = (...fs: (Fact | null | undefined)[]) => [...new Set(fs.filter((f): f is Fact => Boolean(f)).map((f) => f.id))];
const day = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : localDay(iso));
const plural = (n: number, one: string, many = `${one}s`) => `${sayNumber(n)} ${n === 1 ? one : many}`;
const money = (n: number, cur: string | null) => `${sayNumber(n)}${cur ? ` ${cur}` : ""}`;
const hash = (text: string) => crypto.createHash("sha256").update(text).digest("hex").slice(0, 10);

// ---------------------------------------------------------------------------------------------
// Expected values ("Soll"). Other code may call these.
// ---------------------------------------------------------------------------------------------

export interface PartCoverage {
  part_id: string;
  need: number | null;      // pieces for the copies that were still to pack when the stock list was taken. null if demand is unknown
  stock: number;            // pieces in stock per the stock list
  held: number;             // of those: in lots that are blocked or must not be packed (rejected, or a blocked revision)
  usable: number;
  covered: boolean | null;  // null if the need is unknown
  fact_ids: number[];
}

/**
 * Whether stock covers what the remaining pack-out needs of a part. Need and stock are taken at the same moment:
 * the copies still to pack when the stock list was taken (day-one demand minus packed copies on that list).
 */
export function partCoverage(partId: string, s: RuleState = loadState()): PartCoverage {
  let need: number | null = 0;
  const used: Fact[] = [];
  for (const b of s.bom.filter((x) => x.child_id === partId && s.launchProducts.has(x.parent_id))) {
    const demand = newest(s, "product", b.parent_id, "day_one_demand");
    const packed = s.productStock.get(b.parent_id);
    if (!demand || numOf(demand) === null || packed === undefined) { need = null; break; }
    used.push(demand);
    need += Math.max(0, numOf(demand)! - packed) * b.qty_per;
  }
  const stock = s.partStock.get(partId) ?? 0;
  let held = 0;
  // Not usable: blocked lots, and lots that should be blocked (rejected at inspection, or a revision that must not be packed).
  for (const [lot, st] of s.lotStock) if (st.part_id === partId && (lotBlocked(s, lot) || lotHold(s, lot).length)) held += st.quantity;
  const usable = Math.max(0, stock - held);
  return { part_id: partId, need, stock, held, usable, covered: need === null ? null : usable >= need, fact_ids: ids(...used) };
}

export interface PoLineExpectation {
  po_line_id: string; po_number: string; po_line: number; part_id: string | null; supplier_id: string | null; status: string | null;
  ordered_qty: number | null; unit_price: number | null; currency: string | null;
  requested_date: string | null;       // what Soony asked for
  promised_date: string | null;        // what the ERP holds
  confirmed_qty: number | null;        // what the supplier confirmed
  confirmed_date: string | null;
  confirmed_unit_price: number | null;
  shipped_qty: number | null; balance_qty: number | null; balance_eta: string | null;
  received_qty: number;                // booked at goods receipt so far
  shipments: { shipment_id: string; eta: string | null; status: string | null }[];
  expected_qty: number | null;         // confirmed quantity if the supplier confirmed one, else the ordered quantity
  expected_date: string | null;        // confirmed date if there is one, else the ERP's promised date, else the requested date
  expected_basis: "supplier confirmation" | "ERP promised date" | "requested date" | null;
  expected_arrival: string | null;     // best current knowledge: the last shipment that carries it, a later date for the rest, else expected_date
  fact_ids: number[];
}

function lineShipments(s: RuleState, l: PoLineRow): ShipmentRow[] {
  return [...s.shipments.values()].filter((sh) => sh.po_numbers.includes(l.po_number) && (l.part_id === null || !sh.part_ids.length || sh.part_ids.includes(l.part_id)));
}

/** What Soony should get for an order line, and when. null if the line is not in the ERP. */
export function expectedForPoLine(poLineId: string, s: RuleState = loadState()): PoLineExpectation | null {
  const l = s.poLines.get(poLineId);
  if (!l) return null;
  const cq = newest(s, "po_line", l.po_line_id, "confirmed_qty"), cd = newest(s, "po_line", l.po_line_id, "confirmed_date"), cp = newest(s, "po_line", l.po_line_id, "confirmed_unit_price");
  const sq = newest(s, "po_line", l.po_line_id, "shipped_qty"), bq = newest(s, "po_line", l.po_line_id, "balance_qty"), be = newest(s, "po_line", l.po_line_id, "balance_eta");
  const ships = lineShipments(s, l).map((sh) => {
    const eta = newest(s, "shipment", sh.shipment_id, "eta"), status = newest(s, "shipment", sh.shipment_id, "status");
    return { shipment_id: sh.shipment_id, eta: eta?.value ?? sh.eta, status: status?.value ?? sh.status, facts: [eta, status] };
  });
  const received = [...s.receipts.values()].filter((r) => r.po_number === l.po_number && r.po_line === l.po_line).reduce((a, r) => a + (r.qty_received ?? 0), 0);
  const expectedDate = cd?.value ?? l.promised_date ?? l.requested_date;
  const etas = ships.map((x) => x.eta).filter((x): x is string => Boolean(x)).sort();
  let arrival = etas.length ? etas[etas.length - 1] : expectedDate;
  if (be && (!arrival || be.value > arrival)) arrival = be.value;
  return {
    po_line_id: l.po_line_id, po_number: l.po_number, po_line: l.po_line, part_id: l.part_id, supplier_id: l.supplier_id, status: l.status,
    ordered_qty: l.quantity, unit_price: l.unit_price, currency: l.currency, requested_date: l.requested_date, promised_date: l.promised_date,
    confirmed_qty: numOf(cq), confirmed_date: cd?.value ?? null, confirmed_unit_price: numOf(cp),
    shipped_qty: numOf(sq), balance_qty: numOf(bq), balance_eta: be?.value ?? null, received_qty: received,
    shipments: ships.map(({ shipment_id, eta, status }) => ({ shipment_id, eta, status })),
    expected_qty: numOf(cq) ?? l.quantity,
    expected_date: expectedDate, expected_basis: cd ? "supplier confirmation" : l.promised_date ? "ERP promised date" : l.requested_date ? "requested date" : null,
    expected_arrival: arrival,
    fact_ids: ids(cq, cd, cp, sq, bq, be, ...ships.flatMap((x) => x.facts),
      newest(s, "po_line", l.po_line_id, "qty_ordered"), newest(s, "po_line", l.po_line_id, "requested_date"), newest(s, "po_line", l.po_line_id, "promised_date")),
  };
}

export interface ShipmentExpectation {
  shipment_id: string; mode: string | null; status: string | null;
  eta: string | null;                  // newest stated arrival date
  first_eta: string | null;            // the first arrival date the same source stated, if it has changed since
  under_way: boolean;                  // left and not yet delivered
  last_update: string | null;
  max_update_age_hours: number | null; // how often tracking should be refreshed for this mode
  update_age_hours: number | null;
  next_update_due: string | null;
  stale: boolean;
  fact_ids: number[];
}

const codeOf = (v: string | null | undefined) => (v ?? "").toLowerCase().replace(/[\s\-]+/g, "_");
/** Statuses in which a shipment is not moving: nothing to track yet, or nothing to track any more. */
const AT_REST = new Set(["delivered", "arrived", "arrived_port", "cancelled", "received"]);

/** What we expect of a shipment: when it arrives, and how fresh its tracking should be. */
export function expectedForShipment(shipmentId: string, s: RuleState = loadState()): ShipmentExpectation | null {
  const sh = s.shipments.get(shipmentId);
  if (!sh) return null;
  const eta = newest(s, "shipment", sh.shipment_id, "eta"), status = newest(s, "shipment", sh.shipment_id, "status"), etd = newest(s, "shipment", sh.shipment_id, "etd");
  const mode = codeOf(newest(s, "shipment", sh.shipment_id, "mode")?.value ?? sh.mode) || null;
  // The freshest update any source reports.
  const updates = said(s, "shipment", sh.shipment_id, "last_update").filter((f) => !Number.isNaN(new Date(f.value).getTime()));
  const last = updates.length ? updates.reduce((a, b) => (new Date(b.value) > new Date(a.value) ? b : a)) : null;
  const lastIso = last?.value ?? sh.updated_at;
  const st = codeOf(status?.value ?? sh.status);
  const departure = etd?.value ?? sh.etd;
  const underWay = !AT_REST.has(st) && (st !== "booked" || (departure !== null && day(departure) <= s.today));
  const maxAge = mode !== null && Number.isFinite(config.trackingMaxAgeHours[mode]) ? config.trackingMaxAgeHours[mode] : null;
  const age = lastIso ? hoursBetween(lastIso, s.now) : null;
  const history = etaHistory(sh.shipment_id);
  return {
    shipment_id: sh.shipment_id, mode, status: st || null, eta: eta?.value ?? sh.eta, first_eta: history?.first.value ?? null,
    under_way: underWay, last_update: lastIso, max_update_age_hours: maxAge, update_age_hours: age,
    next_update_due: lastIso && maxAge !== null ? new Date(new Date(lastIso).getTime() + maxAge * 3_600_000).toISOString() : null,
    stale: underWay && maxAge !== null && age !== null && age > maxAge,
    fact_ids: ids(eta, status, etd, last, history?.first, history?.last),
  };
}

/** The first and the latest arrival date one source has stated for a shipment, if that source moved the date. */
function etaHistory(shipmentId: string): { first: Fact; last: Fact } | null {
  const rows = all<Fact>("SELECT id, object_type, object_id, field, value, unit, part_id, source_path, source_version, observed_at, recorded_at, origin, confidence, quote FROM facts WHERE object_type = 'shipment' AND object_id = ? AND field = 'eta' AND confidence >= ? ORDER BY id", shipmentId, MIN_CONFIDENCE);
  const bySource = new Map<string, Fact[]>();
  for (const f of rows) { if (!bySource.has(f.source_path)) bySource.set(f.source_path, []); bySource.get(f.source_path)!.push(f); }
  let best: { first: Fact; last: Fact } | null = null;
  for (const list of bySource.values()) {
    const first = list[0], last = list[list.length - 1];
    if (first.value === last.value) continue;
    if (!best || last.id > best.last.id) best = { first, last };
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Quality: which lots must not be packed
// ---------------------------------------------------------------------------------------------

interface RevisionRule { blocked: Fact | null; current: Fact | null; useUp: Fact | null }
function revisionRule(s: RuleState, partId: string): RevisionRule {
  return { blocked: newest(s, "part", partId, "blocked_rev"), current: newest(s, "part", partId, "drawing_rev"), useUp: newest(s, "part", partId, "use_up_old_rev") };
}
/** A revision that must not go into a copy: it is blocked, or it is not the released one and old stock may not be used up. */
function revisionHeld(rule: RevisionRule, revision: string): boolean {
  const def = fieldDef("part", "blocked_rev")!;
  if (rule.blocked && sameValue(def, rule.blocked.value, revision)) return true;
  return Boolean(rule.useUp?.value === "false" && rule.current && !sameValue(def, rule.current.value, revision));
}

const lotBlocked = (s: RuleState, lot: string) => codeOf(newest(s, "lot", lot, "quality_status")?.value) === "blocked";

/**
 * Reasons why a lot must not be packed although it is in stock and not blocked: this is the deviation.
 * Empty if there is no reason, or if the lot is already blocked (then the books are right).
 */
function lotHold(s: RuleState, lot: string): { reason: "inspection" | "revision"; facts: Fact[] }[] {
  const st = s.lotStock.get(lot);
  if (!st || lotBlocked(s, lot)) return [];
  const status = newest(s, "lot", lot, "quality_status");
  const out: { reason: "inspection" | "revision"; facts: Fact[] }[] = [];
  const result = newest(s, "lot", lot, "inspection_result");
  if (result && /^(reject|rejected|fail|failed|not_ok|nok)$/.test(codeOf(result.value))) out.push({ reason: "inspection", facts: [result, ...(status ? [status] : []), ...said(s, "lot", lot, "defect_note")] });
  const revision = newest(s, "lot", lot, "revision");
  if (revision) {
    const rule = revisionRule(s, st.part_id);
    if (revisionHeld(rule, revision.value)) out.push({ reason: "revision", facts: [revision, ...[rule.blocked, rule.current, rule.useUp].filter((f): f is Fact => Boolean(f))] });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------------------------

export interface IssueDraft {
  key: string;
  type: IssueType;
  title: string;
  detail: string;
  expected: string | null;
  actual: string | null;
  object: { type: ObjectType; id: string };
  part_id: string | null;
  supplier_id: string | null;
  fact_ids: number[];
}

const KEY_PREFIX = "rule:";
const tol = (a: number, b: number) => Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 0.005;
const incotermCode = (v: string | null | undefined) => (v ?? "").trim().toUpperCase().match(/^[A-Z]{3}\b/)?.[0] ?? (v ?? "").trim().toUpperCase();

/** Order lines: quantity, price, dates. */
function orderLineRules(s: RuleState, out: IssueDraft[]) {
  const heldArtwork = new Map<string, { lines: PoLineRow[]; facts: Fact[] }>();
  for (const l of s.liveLines) {
    const e = expectedForPoLine(l.po_line_id, s)!;
    const part = partName(s, l.part_id), sup = supplierName(s, l.supplier_id), name = lineName(l);
    const base = { object: { type: "po_line" as const, id: l.po_line_id }, part_id: l.part_id, supplier_id: l.supplier_id };
    const ordered = newest(s, "po_line", l.po_line_id, "qty_ordered");

    // Confirmed quantity differs from the order.
    const cq = newest(s, "po_line", l.po_line_id, "confirmed_qty");
    if (cq && l.quantity !== null && !tol(numOf(cq)!, l.quantity)) {
      const diff = numOf(cq)! - l.quantity;
      out.push({ ...base, key: `${KEY_PREFIX}quantity:po_line:${l.po_line_id}:confirmed`, type: "quantity",
        title: `${sup} confirmed ${sayQty(numOf(cq))} instead of ${sayQty(l.quantity)} on ${name}`,
        detail: `${config.customer.name} ordered ${sayQty(l.quantity)} of ${part} on ${name}. ${sup} confirmed ${sayQty(numOf(cq))} in ${sourceName(cq.source_path)}, which is ${sayQty(Math.abs(diff))} ${diff < 0 ? "less" : "more"}.`,
        expected: sayQty(l.quantity), actual: sayQty(numOf(cq)), fact_ids: ids(ordered, cq) });
    }

    // Shipped quantity differs from what should have left.
    const sq = newest(s, "po_line", l.po_line_id, "shipped_qty");
    const wantedForLaunch = l.requested_date !== null && l.requested_date <= s.deadlineDay;
    const cover = l.part_id ? partCoverage(l.part_id, s) : null;
    const coverSentence = cover && cover.need !== null ? ` The remaining pack-out needed ${sayQty(cover.need)} of this part when stock was last listed, and ${sayQty(cover.usable)} were in stock and usable.` : "";
    let restLateSaid = false;
    if (sq && e.expected_qty !== null && !tol(numOf(sq)!, e.expected_qty)) {
      const bq = newest(s, "po_line", l.po_line_id, "balance_qty"), be = newest(s, "po_line", l.po_line_id, "balance_eta");
      const short = numOf(sq)! < e.expected_qty;
      const rest = numOf(bq) ?? Math.abs(e.expected_qty - numOf(sq)!);
      // The rest comes after the launch although the line was wanted before it: say it here, in the same issue.
      restLateSaid = short && Boolean(be) && wantedForLaunch && day(be!.value) > s.deadlineDay && cover?.covered !== true;
      out.push({ ...base, key: `${KEY_PREFIX}quantity:po_line:${l.po_line_id}:shipped`, type: "quantity",
        title: short ? `${sup} shipped ${sayQty(numOf(sq))} of ${sayQty(e.expected_qty)} for ${name}` : `${sup} shipped ${sayQty(numOf(sq))} for ${name}, more than the ${sayQty(e.expected_qty)} expected`,
        detail: `${sup} says in ${sourceName(sq.source_path)} that ${sayQty(numOf(sq))} of ${part} left for ${name}. ${cq ? "The supplier confirmed" : `${config.customer.name} ordered`} ${sayQty(e.expected_qty)}.`
          + (short ? ` ${sayQty(rest)} are still owed${be ? `, and the supplier names ${d(s, be.value)} for them to arrive` : ", and the supplier gives no date for them"}.` : "")
          + (restLateSaid ? ` ${config.customer.name} asked for this line by ${d(s, l.requested_date)}, and the launch deadline is ${d(s, s.deadline)}, so the rest comes too late for the launch.${coverSentence}` : ""),
        expected: sayQty(e.expected_qty), actual: sayQty(numOf(sq)), fact_ids: [...new Set([...ids(ordered, cq, sq, bq, be), ...(restLateSaid ? (cover?.fact_ids ?? []) : [])])] });
    }

    // Confirmed price differs from the order price.
    const cp = newest(s, "po_line", l.po_line_id, "confirmed_unit_price");
    if (cp && l.unit_price !== null) {
      const price = numOf(cp)!;
      const otherCurrency = Boolean(cp.unit && l.currency && cp.unit.toUpperCase() !== l.currency.toUpperCase());
      if (otherCurrency || !tol(price, l.unit_price)) {
        const delta = !otherCurrency && l.quantity !== null ? (price - l.unit_price) * l.quantity : null;
        out.push({ ...base, key: `${KEY_PREFIX}price:po_line:${l.po_line_id}`, type: "price",
          title: `${sup} confirmed ${money(price, cp.unit ?? l.currency)} per piece instead of ${money(l.unit_price, l.currency)} on ${name}`,
          detail: `The order price for ${part} on ${name} is ${money(l.unit_price, l.currency)} per piece. ${sup} confirmed ${money(price, cp.unit ?? l.currency)} in ${sourceName(cp.source_path)}.`
            + (delta !== null ? ` For ${sayQty(l.quantity)} that is ${money(Math.abs(Math.round(delta * 100) / 100), l.currency)} ${delta > 0 ? "more" : "less"} than ordered.` : ""),
          expected: money(l.unit_price, l.currency), actual: money(price, cp.unit ?? l.currency), fact_ids: ids(newest(s, "po_line", l.po_line_id, "unit_price"), cp) });
      }
    }

    // The supplier names a condition before it ships.
    for (const rc of said(s, "po_line", l.po_line_id, "release_condition")) {
      out.push({ ...base, key: `${KEY_PREFIX}supplier_notice:po_line:${l.po_line_id}:condition:${hash(rc.source_path)}`, type: "supplier_notice",
        title: `${sup} holds ${name} until a condition is met`,
        detail: `${sup} writes in ${sourceName(rc.source_path)} about ${name} (${sayQty(l.quantity)} of ${part}): ${rc.value}`,
        expected: "shipped without conditions", actual: rc.value.slice(0, 200), fact_ids: ids(rc) });
    }

    // Dates. A line that Soony wanted before the launch and that now arrives after it is the one that can stop a line.
    const cd = newest(s, "po_line", l.po_line_id, "confirmed_date");
    const arrival = e.expected_arrival;
    // If the only thing that is late is the rest of a short shipment, the quantity issue above already says so.
    const lateWithoutRest = e.shipments.some((x) => x.eta && day(x.eta) > s.deadlineDay) || (!e.shipments.some((x) => x.eta) && e.expected_date !== null && day(e.expected_date) > s.deadlineDay);
    if (wantedForLaunch && arrival !== null && day(arrival) > s.deadlineDay && cover?.covered !== true && !(restLateSaid && !lateWithoutRest)) {
      const ships = e.shipments.filter((x) => x.eta);
      const be = newest(s, "po_line", l.po_line_id, "balance_eta");
      const sentences = [
        `${config.customer.name} asked for ${sayQty(l.quantity)} of ${part} from ${sup} by ${d(s, l.requested_date)} on ${name}.`,
        cd ? `${sup} confirmed ${d(s, cd.value)}${l.promised_date && l.promised_date !== cd.value ? `, the ERP holds ${d(s, l.promised_date)}` : ""}.` : l.promised_date ? `The ERP holds ${d(s, l.promised_date)} as promised.` : "",
        ships.length ? `It travels on ${ships.map((x) => `${x.shipment_id} (due ${d(s, x.eta)}, ${codeOf(x.status).replace(/_/g, " ") || "no status"})`).join(" and ")}.` : "No shipment is booked for it yet.",
        be ? `The supplier names ${d(s, be.value)} for the rest of a partial shipment.` : "",
        `The launch deadline is ${d(s, s.deadline)}.`,
        coverSentence.trim(),
      ];
      out.push({ ...base, key: `${KEY_PREFIX}date_eta:po_line:${l.po_line_id}:deadline`, type: "date_eta",
        title: `${name} (${part}) arrives after the launch`, detail: sentences.filter(Boolean).join(" "),
        expected: `by ${d(s, l.requested_date)}`, actual: d(s, arrival),
        fact_ids: [...new Set([...e.fact_ids, ...(cover?.fact_ids ?? [])])] });
    } else if (cd && (l.promised_date ?? l.requested_date) !== null && cd.value > (l.promised_date ?? l.requested_date)!) {
      const held = l.promised_date ?? l.requested_date;
      out.push({ ...base, key: `${KEY_PREFIX}date_eta:po_line:${l.po_line_id}:confirmed`, type: "date_eta",
        title: `${sup} confirmed ${d(s, cd.value)} for ${name}, later than the ${d(s, held)} ${config.customer.name} plans with`,
        detail: `${sup} confirmed ${d(s, cd.value)} for ${sayQty(l.quantity)} of ${part} on ${name} in ${sourceName(cd.source_path)}. ${l.promised_date ? `The ERP holds ${d(s, l.promised_date)} as promised` : `${config.customer.name} asked for ${d(s, l.requested_date)}`}, so planning runs on a date the supplier does not confirm.`,
        expected: d(s, held), actual: d(s, cd.value), fact_ids: ids(cd, newest(s, "po_line", l.po_line_id, "promised_date"), newest(s, "po_line", l.po_line_id, "requested_date")) });
    }

    // Produced to a revision that must not be packed. Collected per order and part, so one order gives one issue.
    const art = newest(s, "po_line", l.po_line_id, "artwork_rev");
    if (art && l.part_id && revisionHeld(revisionRule(s, l.part_id), art.value)) {
      const k = `${l.po_number}|${l.part_id}|${art.value.toUpperCase()}`;
      const g = heldArtwork.get(k) ?? { lines: [], facts: [] };
      g.lines.push(l); g.facts.push(art);
      heldArtwork.set(k, g);
    }
  }

  for (const g of heldArtwork.values()) {
    const lines = g.lines.sort((a, b) => a.po_line - b.po_line), l = lines[0], art = g.facts[0];
    const rule = revisionRule(s, l.part_id!);
    const part = partName(s, l.part_id), sup = supplierName(s, l.supplier_id);
    const total = lines.reduce((a, x) => a + (x.quantity ?? 0), 0);
    const which = `order ${l.po_number} ${lines.length === 1 ? `line ${l.po_line}` : `lines ${lines.map((x) => x.po_line).join(" and ")}`}`;
    out.push({ object: { type: "po_line", id: l.po_line_id }, part_id: l.part_id, supplier_id: l.supplier_id,
      key: `${KEY_PREFIX}quality_hold:po:${l.po_number}:${l.part_id}:revision`, type: "quality_hold",
      title: `${sup} produces ${part} for ${which} to revision ${art.value}, which must not be packed`,
      detail: `${sup} states revision ${art.value} for ${sayQty(total)} of ${part} on ${which} in ${sourceName(art.source_path)}. ${rule.current ? `The released revision is ${rule.current.value}. ` : ""}${rule.blocked ? `Revision ${rule.blocked.value} is blocked. ` : "Stock of the old revision may not be used up. "}These parts cannot go into a copy as they are.`,
      expected: rule.current ? `revision ${rule.current.value}` : "a released revision", actual: `revision ${art.value}`, fact_ids: ids(...g.facts, rule.blocked, rule.current, rule.useUp) });
  }
}

/** Lots in stock: booked quantity against the order and the delivery note, and quality holds. */
function lotRules(s: RuleState, out: IssueDraft[]) {
  const unknownRevision = new Map<string, { lots: string[]; quantity: number }>();
  for (const [lot, st] of s.lotStock) {
    if (!s.liveParts.has(st.part_id)) continue;
    const r = s.receipts.get(lot);
    const part = partName(s, st.part_id), sup = supplierName(s, r?.supplier_id ?? null);
    const base = { object: { type: "lot" as const, id: lot }, part_id: st.part_id, supplier_id: r?.supplier_id ?? null };
    const qtyFacts = said(s, "lot", lot, "qty");
    const erpQty = qtyFacts.find((f) => f.origin === "code") ?? null;
    const booked = r?.qty_received ?? numOf(erpQty);

    if (r && booked !== null) {
      const line = r.po_number && r.po_line !== null ? s.poLines.get(`${r.po_number}/${r.po_line}`) : undefined;
      const ordered = r.qty_ordered ?? line?.quantity ?? null;
      const papers = qtyFacts.filter((f) => f.origin !== "code" && !tol(numOf(f)!, booked));
      const sentences: string[] = [];
      if (ordered !== null && !tol(ordered, booked)) sentences.push(`The order line${r.po_number ? ` ${r.po_number}/${r.po_line ?? "?"}` : ""} is for ${sayQty(ordered)}.`);
      if (line && line.quantity !== null && r.qty_ordered !== null && !tol(line.quantity, r.qty_ordered)) sentences.push(`The purchase order itself says ${sayQty(line.quantity)} for this line.`);
      for (const p of papers) sentences.push(`${sourceName(p.source_path)} says ${sayQty(numOf(p))}${p.quote ? ` ("${p.quote}")` : ""}.`);
      if (st.quantity > booked && !tol(st.quantity, booked)) sentences.push(`The stock list shows ${sayQty(st.quantity)} for this lot, more than was booked in.`);
      if (sentences.length) {
        const want = papers.length ? numOf(papers[0]) : ordered;
        out.push({ ...base, key: `${KEY_PREFIX}quantity:lot:${lot}`, type: "quantity",
          title: `Goods receipt ${lot} (${part}): ${sayQty(booked)} booked${want !== null && !tol(want, booked) ? `, ${sayQty(want)} on ${papers.length ? "the delivery note" : "the order"}` : ""}`,
          detail: `Receiving booked ${sayQty(booked)} of ${part} from ${sup}${r.gr_date ? ` on ${d(s, r.gr_date)}` : ""}${r.delivery_note ? ` with delivery note ${r.delivery_note}` : ""}${r.remark ? ` (remark: "${r.remark}")` : ""}. ${sentences.join(" ")} ${sayQty(st.quantity)} of this lot count as stock, so the stock figure for this part may be wrong by the difference.`,
          expected: want !== null ? sayQty(want) : null, actual: sayQty(booked),
          fact_ids: ids(erpQty, ...papers, line ? newest(s, "po_line", line.po_line_id, "qty_ordered") : null, newest(s, "lot", lot, "stock_qty")) });
      }
    }

    const holds = lotHold(s, lot);
    if (holds.length) {
      const inspection = holds.find((h) => h.reason === "inspection"), revision = holds.find((h) => h.reason === "revision");
      const defect = said(s, "lot", lot, "defect_note")[0];
      const rev = newest(s, "lot", lot, "revision");
      const status = newest(s, "lot", lot, "quality_status");
      out.push({ ...base, key: `${KEY_PREFIX}quality_hold:lot:${lot}`, type: "quality_hold",
        title: `Lot ${lot} (${part}) is in stock as usable but must not be packed`,
        detail: [
          `${sayQty(st.quantity)} of ${part} from ${sup} are in stock in lot ${lot}${status ? ` with status ${codeOf(status.value).replace(/_/g, " ")}` : ""}.`,
          inspection ? `The incoming inspection rejected the lot${defect ? `: ${defect.value}` : "."}` : "",
          revision && rev ? `The lot is revision ${rev.value}, which must not be packed any more.` : "",
          "Until someone blocks or releases the lot, the stock figure counts parts that cannot go into a copy.",
        ].filter(Boolean).join(" "),
        expected: "blocked, or released under a signed concession", actual: status ? codeOf(status.value).replace(/_/g, " ") : "in stock without a block",
        fact_ids: ids(...holds.flatMap((h) => h.facts), newest(s, "lot", lot, "stock_qty")) });
    }

    // A part has a revision that must not be packed, and we do not know which revision this lot is.
    const rule = revisionRule(s, st.part_id);
    if ((rule.blocked || rule.useUp?.value === "false") && !newest(s, "lot", lot, "revision")) {
      const u = unknownRevision.get(st.part_id) ?? { lots: [], quantity: 0 };
      u.lots.push(lot); u.quantity += st.quantity;
      unknownRevision.set(st.part_id, u);
    }
  }
  for (const [partId, u] of unknownRevision) {
    const rule = revisionRule(s, partId);
    out.push({ key: `${KEY_PREFIX}quality_hold:part:${partId}:unknown_revision`, type: "quality_hold", object: { type: "part", id: partId }, part_id: partId, supplier_id: null,
      title: `${partName(s, partId)}: ${sayQty(u.quantity)} in stock with an unknown revision${rule.blocked ? `, revision ${rule.blocked.value} is blocked` : ""}`,
      detail: `${rule.blocked ? `Revision ${rule.blocked.value} of ${partName(s, partId)} must not be packed any more` : `Stock of the old revision of ${partName(s, partId)} may not be used up`}${rule.current ? `, the released revision is ${rule.current.value}` : ""}. ${plural(u.lots.length, "lot")} in stock (${u.lots.sort().join(", ")}, ${sayQty(u.quantity)} in total) ${u.lots.length === 1 ? "has" : "have"} no revision on any document I have read, so I cannot tell how much of this stock is usable.`,
      expected: rule.current ? `revision ${rule.current.value}` : "a known revision", actual: "revision unknown",
      fact_ids: ids(rule.blocked, rule.current, rule.useUp, ...u.lots.map((lot) => newest(s, "lot", lot, "stock_qty"))) });
  }
}

/** Shipments on the open list: stale tracking, arrival dates that move, and loads with a blocked revision. */
function shipmentRules(s: RuleState, out: IssueDraft[]) {
  for (const sh of s.liveShipments) {
    const e = expectedForShipment(sh.shipment_id, s)!;
    const liveParts = sh.part_ids.filter((p) => s.liveParts.has(p));
    const partId = liveParts.length === 1 ? liveParts[0] : null;
    const base = { object: { type: "shipment" as const, id: sh.shipment_id }, part_id: partId, supplier_id: sh.supplier_id };
    const cargo = `${liveParts.map((p) => partName(s, p)).join(" and ")} from ${supplierName(s, sh.supplier_id)}`;
    const lines = s.liveLines.filter((l) => sh.po_numbers.includes(l.po_number) && sh.part_ids.includes(l.part_id!));
    // Does the launch wait for it: it is due by the deadline, or it carries an order line Soony wanted by then.
    const forLaunch = (e.eta !== null && day(e.eta) <= s.deadlineDay) || lines.some((l) => l.requested_date !== null && l.requested_date <= s.deadlineDay);

    if (e.stale && forLaunch) {
      out.push({ ...base, key: `${KEY_PREFIX}tracking_stale:shipment:${sh.shipment_id}`, type: "tracking_stale",
        title: `Shipment ${sh.shipment_id} (${e.mode}) has had no tracking update since ${d(s, e.last_update)}`,
        detail: `The last update of ${sh.shipment_id} is from ${d(s, e.last_update)}, status ${(e.status ?? "unknown").replace(/_/g, " ")}. For ${e.mode} freight I expect an update at least every ${sayHours(e.max_update_age_hours!)}, so the next one was due by ${d(s, e.next_update_due)}. It carries ${cargo}${sh.po_numbers.length ? ` for ${sh.po_numbers.length === 1 ? "order" : "orders"} ${sh.po_numbers.join(", ")}` : ""}${sh.reference ? ` (${sh.reference})` : ""} and is due ${d(s, e.eta)}, so where it is right now is unknown.`,
        expected: `an update every ${sayHours(e.max_update_age_hours!)}`, actual: `last update ${d(s, e.last_update)}`,
        fact_ids: e.fact_ids });
    }

    const hist = etaHistory(sh.shipment_id);
    if (hist && hist.last.value > hist.first.value) {
      out.push({ ...base, key: `${KEY_PREFIX}date_eta:shipment:${sh.shipment_id}:moved`, type: "date_eta",
        title: `Shipment ${sh.shipment_id}: arrival moved from ${d(s, hist.first.value)} to ${d(s, hist.last.value)}`,
        detail: `${sourceName(hist.last.source_path)} first gave ${d(s, hist.first.value)} as arrival date of ${sh.shipment_id} and now gives ${d(s, hist.last.value)}. It carries ${cargo}${sh.po_numbers.length ? ` for ${sh.po_numbers.length === 1 ? "order" : "orders"} ${sh.po_numbers.join(", ")}` : ""}.${day(hist.last.value) > s.deadlineDay && day(hist.first.value) <= s.deadlineDay ? ` The new date is after the launch deadline of ${d(s, s.deadline)}.` : ""}`,
        expected: d(s, hist.first.value), actual: d(s, hist.last.value), fact_ids: ids(hist.first, hist.last) });
    }

    for (const p of liveParts) {
      const rev = newest(s, "shipment", sh.shipment_id, "revision", p);
      if (!rev) continue;
      const rule = revisionRule(s, p);
      if (!revisionHeld(rule, rev.value)) continue;
      const qty = newest(s, "shipment", sh.shipment_id, "qty", p);
      out.push({ ...base, part_id: p, key: `${KEY_PREFIX}quality_hold:shipment:${sh.shipment_id}:${p}`, type: "quality_hold",
        title: `Shipment ${sh.shipment_id} carries ${partName(s, p)} in revision ${rev.value}, which must not be packed`,
        detail: `${sourceName(rev.source_path)} states revision ${rev.value} for ${qty ? sayQty(numOf(qty)) : "the load"} of ${partName(s, p)} on ${sh.shipment_id} from ${supplierName(s, sh.supplier_id)}, due ${d(s, e.eta)}. ${rule.current ? `The released revision is ${rule.current.value}. ` : ""}${rule.blocked ? `Revision ${rule.blocked.value} is blocked. ` : ""}This load will arrive and still not be usable.`,
        expected: rule.current ? `revision ${rule.current.value}` : "a released revision", actual: `revision ${rev.value}`, fact_ids: ids(rev, qty, rule.blocked, rule.current, rule.useUp) });
    }
  }
}

const FIELD_WORDS: Record<string, string> = {
  eta: "arrival date", etd: "departure date", qty: "quantity", status: "status", mode: "transport mode", last_update: "last tracking update",
  qty_ordered: "ordered quantity", unit_price: "order price", requested_date: "requested date", promised_date: "promised date", erp_status: "order status",
  confirmed_qty: "confirmed quantity", confirmed_date: "confirmed date", confirmed_unit_price: "confirmed price", confirmed_incoterm: "delivery term",
  shipped_qty: "shipped quantity", shipped_date: "shipping date", balance_qty: "open rest", balance_eta: "date for the rest", received_qty: "received quantity",
  artwork_rev: "revision", revision: "revision", stock_qty: "stock", drawing_rev: "released revision", blocked_rev: "blocked revision",
  need_remaining: "remaining need", due_before_launch: "quantity due before the launch", lead_time_days: "lead time", day_one_demand: "day-one demand",
  packed: "packed copies", still_to_pack: "copies still to pack", pack_rate_per_hour: "packing rate", qualification_status: "qualification status",
  qualification_valid_until: "end of the conditional release", person: "person in the role", reports_to: "reporting line",
};
const fieldWords = (field: string) => FIELD_WORDS[field] ?? field.replace(/_/g, " ");

/** Two sources that currently state different values for the same thing. */
function conflictRules(s: RuleState, out: IssueDraft[]) {
  const live = (f: Fact): boolean => {
    switch (f.object_type) {
      case "po_line": return s.liveLines.some((l) => l.po_line_id === f.object_id);
      case "shipment": return s.liveShipments.some((x) => x.shipment_id === f.object_id);
      case "lot": { const st = s.lotStock.get(f.object_id); return Boolean(st && s.liveParts.has(st.part_id)); }
      case "part": return s.liveParts.has(f.object_id);
      case "supplier": return s.liveSuppliers.has(f.object_id) && (f.part_id === null || s.liveParts.has(f.part_id));
      case "product": return s.launchProducts.has(f.object_id);
      case "role": return true;
      default: return false;
    }
  };
  const groups = new Map<string, Fact[]>();
  for (const f of s.facts) {
    const def = fieldDef(f.object_type, f.field);
    if (!def?.compare) continue;
    if (f.object_type === "lot" && f.field === "qty") continue; // handled with the goods receipt
    const k = `${f.object_type}|${f.object_id}|${f.field}|${f.part_id ?? ""}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(f);
  }
  for (const [k, rows] of groups) {
    if (rows.length < 2 || !live(rows[0])) continue;
    const def = fieldDef(rows[0].object_type, rows[0].field)!;
    // Group the statements by value.
    const camps: Fact[][] = [];
    for (const f of rows) { const c = camps.find((x) => sameValue(def, x[0].value, f.value)); if (c) c.push(f); else camps.push([f]); }
    if (camps.length < 2) continue;

    if (def.changes) {
      // A value that moves over time: if the newest dated statement is clearly newer than everything that disagrees, it is a change.
      const dated = rows.filter((f) => f.observed_at);
      const top = dated.length ? dated.reduce((a, b) => (stamp(b) > stamp(a) ? b : a)) : null;
      if (top) {
        const disagree = rows.filter((f) => !sameValue(def, f.value, top.value));
        const older = (f: Fact) => {
          if (!f.observed_at) return false;
          const fTimed = f.observed_at.length > 10, topTimed = top.observed_at!.length > 10;
          if (fTimed && topTimed) return new Date(f.observed_at) < new Date(top.observed_at!);
          if (day(f.observed_at) !== day(top.observed_at!)) return day(f.observed_at) < day(top.observed_at!);
          // Same day and one of them has no time. It is older if we had it on file before the other one was even issued (a reply to a paper of that day).
          return topTimed && new Date(f.recorded_at) < new Date(top.observed_at!);
        };
        if (disagree.every(older)) continue;
      }
    }

    const first = rows[0];
    const say = (f: Fact) => {
      const v = def.kind === "date" || def.kind === "datetime" ? d(s, f.value) : def.kind === "number" ? `${sayNumber(Number(f.value))}${f.unit ? ` ${f.unit}` : ""}` : f.value.replace(/_/g, " ");
      return `${v} (${sourceName(f.source_path)}${f.observed_at ? `, as of ${d(s, f.observed_at)}` : ", undated"})`;
    };
    // Lead with what the ERP says, if it says something.
    camps.sort((a, b) => Number(b.some((f) => f.origin === "code")) - Number(a.some((f) => f.origin === "code")) || a[0].id - b[0].id);
    const reps = camps.map((c) => c.reduce((a, b) => (stamp(b) > stamp(a) ? b : a)));
    const what = fieldWords(first.field);
    const partId = first.part_id ?? (first.object_type === "part" ? first.object_id : first.object_type === "po_line" ? (s.poLines.get(first.object_id)?.part_id ?? null) : first.object_type === "lot" ? (s.lotStock.get(first.object_id)?.part_id ?? null) : null);
    const supplierId = first.object_type === "supplier" ? first.object_id : first.object_type === "po_line" ? (s.poLines.get(first.object_id)?.supplier_id ?? null)
      : first.object_type === "shipment" ? (s.shipments.get(first.object_id)?.supplier_id ?? null) : first.object_type === "lot" ? (s.receipts.get(first.object_id)?.supplier_id ?? null) : null;
    const label = first.object_type === "po_line" ? lineName(s.poLines.get(first.object_id)!) : first.object_type === "shipment" ? `shipment ${first.object_id}` : first.object_type === "lot" ? `lot ${first.object_id}`
      : first.object_type === "part" ? partName(s, first.object_id) : first.object_type === "supplier" ? supplierName(s, first.object_id) : first.object_type === "product" ? (s.products.get(first.object_id)?.name ?? first.object_id) : first.object_id;
    out.push({ key: `${KEY_PREFIX}source_conflict:${k}`, type: "source_conflict", object: { type: first.object_type, id: first.object_id }, part_id: partId, supplier_id: supplierId,
      title: `Sources disagree on the ${what} of ${label}${first.part_id && first.object_type !== "po_line" && first.object_type !== "lot" ? ` (${partName(s, first.part_id)})` : ""}`,
      detail: `For the ${what} of ${label} I have ${plural(camps.length, "different value")}: ${reps.map(say).join(", ")}. Only one of them can be right, and I cannot tell which from the documents.`,
      expected: say(reps[0]), actual: reps.slice(1).map(say).join(", "), fact_ids: ids(...rows) });
  }

  // Delivery terms: what the supplier file and the supplier's papers say against what the orders say.
  for (const supId of s.liveSuppliers) {
    const sup = s.suppliers.get(supId);
    const lines = s.liveLines.filter((l) => l.supplier_id === supId && l.incoterm);
    if (!sup || !lines.length) continue;
    const contract = newest(s, "supplier", supId, "incoterm");
    const onFile = sup.incoterm;
    const off = lines.filter((l) => {
      const conf = newest(s, "po_line", l.po_line_id, "confirmed_incoterm");
      return (onFile && incotermCode(onFile) !== incotermCode(l.incoterm)) || (contract && incotermCode(contract.value) !== incotermCode(l.incoterm)) || (conf && incotermCode(conf.value) !== incotermCode(l.incoterm));
    });
    if (!off.length) continue;
    const confirmed = off.map((l) => newest(s, "po_line", l.po_line_id, "confirmed_incoterm")).filter((f): f is Fact => Boolean(f));
    const orderTerms = [...new Set(off.map((l) => l.incoterm!))];
    const theirs = [...new Set([onFile, contract?.value, ...confirmed.map((f) => f.value)].filter((x): x is string => Boolean(x)))].filter((t) => !orderTerms.some((o) => incotermCode(o) === incotermCode(t)));
    out.push({ key: `${KEY_PREFIX}source_conflict:supplier:${supId}:incoterm`, type: "source_conflict", object: { type: "supplier", id: supId }, part_id: null, supplier_id: supId,
      title: `${sup.name}: ${plural(off.length, "open order line")} say ${orderTerms.join(" / ")}, the supplier's terms are ${theirs.join(" / ")}`,
      detail: `${plural(off.length, "open order line")} with ${sup.name} (${[...new Set(off.map((l) => l.po_number))].join(", ")}) carry the delivery term ${orderTerms.join(" / ")}. ${onFile ? `The supplier file says ${onFile}. ` : ""}${contract ? `The contract says ${contract.value}. ` : ""}${confirmed.length ? `The supplier states ${[...new Set(confirmed.map((f) => f.value))].join(" / ")} on ${plural(confirmed.length, "confirmation")}. ` : ""}Who books and pays the freight decides whether these orders move, so the two sides need the same term.`,
      expected: orderTerms.join(" / "), actual: theirs.join(" / "),
      fact_ids: ids(contract, ...confirmed) });
  }
}

/** Notices, offers, capacity notes and downtimes, and what the vendor master says about a supplier. */
function supplierRules(s: RuleState, out: IssueDraft[]) {
  const cutoff = new Date(s.now.getTime() - NOTICE_MAX_AGE_DAYS * DAY_MS).toISOString().slice(0, 10);
  const sentence = (t: string) => `${t}${/[.!?]$/.test(t) ? "" : "."}`;
  const headline = (t: string) => { const one = t.replace(/[.\s]+$/, ""); return one.length > 110 ? `${one.slice(0, 107).replace(/\s+\S*$/, "")}...` : one; };
  // Several notices can come from one source. Take all of the latest reading of each source.
  const rows = all<Fact & { v: number }>(
    `SELECT f.id, f.object_type, f.object_id, f.field, f.value, f.unit, f.part_id, f.source_path, f.source_version, f.observed_at, f.recorded_at, f.origin, f.confidence, f.quote,
            (SELECT MAX(g.source_version) FROM facts g WHERE g.source_path = f.source_path AND g.object_type = f.object_type AND g.object_id = f.object_id AND g.field = f.field AND IFNULL(g.part_id, '') = IFNULL(f.part_id, '')) AS v
     FROM facts f WHERE f.confidence >= ? AND ((f.object_type = 'supplier' AND f.field IN ('notice', 'offer', 'capacity_note')) OR (f.object_type = 'part' AND f.field IN ('notice', 'supply_delay_days')))
     ORDER BY f.id`, MIN_CONFIDENCE)
    .filter((f) => f.source_version === f.v && !(f.observed_at && day(f.observed_at) < cutoff))
    .filter((f) => {
      const partId = f.object_type === "part" ? f.object_id : f.part_id;
      return (!partId || s.liveParts.has(partId)) && (f.object_type !== "supplier" || s.liveSuppliers.has(f.object_id));
    });

  // Downtimes first: what the same paper says about capacity in that time belongs into the same issue.
  const folded = new Set<number>();
  for (const supId of s.liveSuppliers) {
    const sup = s.suppliers.get(supId);
    if (!sup) continue;
    const from = newest(s, "supplier", supId, "downtime_from"), to = newest(s, "supplier", supId, "downtime_to");
    if ((from || to) && (!to || new Date(to.value) >= s.now)) {
      const paper = (from ?? to)!.source_path;
      const capacity = rows.filter((f) => f.object_type === "supplier" && f.object_id === supId && f.field === "capacity_note" && f.source_path === paper);
      for (const f of capacity) folded.add(f.id);
      const beforeLaunch = !from || new Date(from.value) <= new Date(s.deadline);
      const span = `${from ? ` from ${d(s, from.value)}` : ""}${to ? ` to ${d(s, to.value)}` : ""}`;
      out.push({ key: `${KEY_PREFIX}supplier_notice:supplier:${supId}:downtime:${hash(`${from?.value ?? ""}|${to?.value ?? ""}`)}`, type: "supplier_notice", object: { type: "supplier", id: supId }, part_id: null, supplier_id: supId,
        title: `${sup.name} announced a downtime${span}`,
        detail: `${sup.name} announced a downtime${from ? ` from ${d(s, from.value)}` : ""}${to ? ` to ${d(s, to.value)}` : ", with no end date"} in ${sourceName(paper)}.${capacity.length ? ` ${capacity.map((f) => sentence(f.value)).join(" ")}` : ""}${beforeLaunch ? ` It starts before the launch deadline of ${d(s, s.deadline)}, so anything ${config.customer.name} still needs from this supplier for the launch has to fit around it.` : ""} ${config.customer.name} has ${plural(s.liveLines.filter((l) => l.supplier_id === supId).length, "open order line")} with this supplier for parts of the launch.`,
        expected: "production running", actual: `down${span}`, fact_ids: ids(from, to, ...capacity) });
    }

    // A conditional release that has run out. A flag in the vendor master is said in the same issue.
    const status = newest(s, "supplier", supId, "status");
    const flagged = status && !["active", "ok", "approved"].includes(codeOf(status.value)) ? status : null;
    const flagWords = flagged ? codeOf(flagged.value).replace(/_/g, " ") : "";
    const lines = s.liveLines.filter((l) => l.supplier_id === supId);
    const until = newest(s, "supplier", supId, "qualification_valid_until");
    const qual = newest(s, "supplier", supId, "qualification_status");
    const expired = Boolean(until && until.value < s.today && codeOf(qual?.value ?? sup.qualification_status) !== "qualified");
    if (expired && until) {
      const lots = [...s.lotStock].filter(([lot, st]) => s.liveParts.has(st.part_id) && s.receipts.get(lot)?.supplier_id === supId);
      const parts = [...new Set([...lines.map((l) => l.part_id!), ...lots.map(([, st]) => st.part_id)])];
      const kind = codeOf(qual?.value ?? sup.qualification_status).replace(/_/g, " ");
      out.push({ key: `${KEY_PREFIX}other:supplier:${supId}:release_expired`, type: "other", object: { type: "supplier", id: supId }, part_id: parts.length === 1 ? parts[0] : null, supplier_id: supId,
        title: `The ${kind ? `${kind} ` : ""}release of ${sup.name} ran out on ${d(s, until.value)}`,
        detail: `${sup.name} has ${kind ? `a ${kind}` : "a limited"} release that was valid until ${d(s, until.value)} (${sourceName(until.source_path)}).${flagged ? ` The vendor master now lists the supplier as "${flagWords}".` : ""} ${config.customer.name} has ${plural(lines.length, "open order line")} with this supplier and ${plural(lots.length, "lot")} of its parts in stock (${sayQty(lots.reduce((a, [, st]) => a + st.quantity, 0))})${parts.length ? `, all for ${parts.map((p) => partName(s, p)).join(" and ")}` : ""}. Someone has to extend the release or decide what happens with these parts.`,
        expected: `a release that is valid on ${d(s, s.today)}`, actual: `ran out on ${d(s, until.value)}`, fact_ids: ids(until, qual, flagged, newest(s, "supplier", supId, "qualification_released_on")) });
    } else if (flagged) {
      out.push({ key: `${KEY_PREFIX}supplier_notice:supplier:${supId}:status:${codeOf(flagged.value)}`, type: "supplier_notice", object: { type: "supplier", id: supId }, part_id: null, supplier_id: supId,
        title: `${sup.name} is now listed as "${flagWords}"`,
        detail: `${sourceName(flagged.source_path)} lists ${sup.name} as "${flagWords}"${flagged.observed_at ? ` as of ${d(s, flagged.observed_at)}` : ""}. ${config.customer.name} has ${plural(lines.length, "open order line")} with this supplier for parts of the launch.`,
        expected: "active", actual: flagWords, fact_ids: ids(flagged) });
    }
  }

  // A stated delay in days is said together with the notice of the same paper about the same part.
  const delays = rows.filter((f) => f.field === "supply_delay_days");
  const seen = new Set<string>();
  for (const f of rows) {
    if (folded.has(f.id) || f.field === "supply_delay_days") continue;
    const isPart = f.object_type === "part";
    const partId = isPart ? f.object_id : f.part_id;
    const supId = isPart ? null : f.object_id;
    const key = `${KEY_PREFIX}supplier_notice:${f.object_type}:${f.object_id}:${f.field}:${hash(`${f.source_path}|${f.part_id ?? ""}|${f.value}`)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const delay = f.field === "notice" && partId ? delays.find((x) => x.source_path === f.source_path && x.object_id === partId && !folded.has(x.id)) : undefined;
    if (delay) folded.add(delay.id);
    const who = isPart ? partName(s, f.object_id) : supplierName(s, supId);
    const kind = f.field === "offer" ? "Offer from" : f.field === "capacity_note" ? "Capacity at" : isPart ? "News about" : "Notice from";
    out.push({ key, type: "supplier_notice", object: { type: f.object_type, id: f.object_id }, part_id: partId ?? null, supplier_id: supId,
      title: `${kind} ${who}: ${headline(f.value)}`,
      detail: `${sentence(f.value)}${delay ? ` Deliveries of ${partName(s, partId)} move out by ${sayNumber(Number(delay.value))} days.` : ""} Source: ${sourceName(f.source_path)}${f.observed_at ? `, ${d(s, f.observed_at)}` : ""}.${!isPart && f.part_id ? ` It concerns ${partName(s, f.part_id)}.` : ""}`,
      expected: null, actual: headline(f.value), fact_ids: ids(f, delay) });
  }
  for (const f of delays) {
    if (folded.has(f.id)) continue;
    const who = partName(s, f.object_id);
    out.push({ key: `${KEY_PREFIX}supplier_notice:part:${f.object_id}:delay:${hash(f.source_path)}`, type: "supplier_notice", object: { type: "part", id: f.object_id }, part_id: f.object_id, supplier_id: null,
      title: `${who}: deliveries move out by ${sayNumber(Number(f.value))} days`,
      detail: `Deliveries of ${who} move out by ${sayNumber(Number(f.value))} days. Source: ${sourceName(f.source_path)}${f.observed_at ? `, ${d(s, f.observed_at)}` : ""}.`,
      expected: "deliveries as confirmed", actual: `${sayNumber(Number(f.value))} days later`, fact_ids: [f.id] });
  }
}

/** All deviations that hold right now. Pure: reads the database, writes nothing. */
export function findDeviations(s: RuleState = loadState()): IssueDraft[] {
  const out: IssueDraft[] = [];
  orderLineRules(s, out);
  lotRules(s, out);
  shipmentRules(s, out);
  conflictRules(s, out);
  supplierRules(s, out);
  // One deviation, one issue.
  const byKey = new Map<string, IssueDraft>();
  for (const x of out) if (!byKey.has(x.key)) byKey.set(x.key, { ...x, title: (x.title.charAt(0).toUpperCase() + x.title.slice(1)).replace(/(?<!\.)\.$/, ""), fact_ids: [...new Set(x.fact_ids)].sort((a, b) => a - b) });
  return [...byKey.values()];
}

export interface RulesResult { checked: { order_lines: number; shipments: number; lots: number; suppliers: number }; opened: number[]; reopened: number[]; updated: number[]; resolved: number[]; open_total: number }

/**
 * Bring the issues table in line with the deviations that hold right now.
 * A new deviation opens an issue, a known one is updated where its content changed, one that is gone is resolved.
 */
export function runRules(runId?: string): RulesResult {
  const s = loadState();
  const drafts = findDeviations(s);
  const stampNow = s.now.toISOString();
  const res: RulesResult = {
    checked: { order_lines: s.liveLines.length, shipments: s.liveShipments.length, lots: [...s.lotStock.values()].filter((x) => s.liveParts.has(x.part_id)).length, suppliers: s.liveSuppliers.size },
    opened: [], reopened: [], updated: [], resolved: [], open_total: 0,
  };
  const existing = new Map(all<IssueDb>("SELECT * FROM issues WHERE dedupe_key LIKE ?", `${KEY_PREFIX}%`).map((r) => [r.dedupe_key, r]));
  const events: (() => void)[] = [];

  tx(() => {
    for (const x of drafts) {
      const old = existing.get(x.key);
      const factIds = JSON.stringify(x.fact_ids);
      if (!old) {
        // A notice the reading agent has already turned into its own question on the same object needs no second issue.
        if (x.type === "supplier_notice" && get("SELECT 1 AS x FROM issues WHERE created_by = 'data_agent' AND status != 'resolved' AND object_type = ? AND object_id = ?", x.object.type, x.object.id)) continue;
        const id = run(
          `INSERT INTO issues (dedupe_key, type, status, title, detail, expected, actual, object_type, object_id, part_id, supplier_id, fact_ids, created_by, created_at, updated_at)
           VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'code', ?, ?)`,
          x.key, x.type, x.title, x.detail, x.expected, x.actual, x.object.type, x.object.id, x.part_id, x.supplier_id, factIds, stampNow, stampNow).lastId;
        res.opened.push(id);
        events.push(() => logEvent({ actor: "data_agent", action: "issue.opened", run_id: runId, object: { type: x.object.type, id: x.object.id }, summary: `I found a deviation: ${x.title}.`,
          input: { rule: x.key, type: x.type }, output: { issue_id: id, expected: x.expected, actual: x.actual, detail: x.detail, part_id: x.part_id, supplier_id: x.supplier_id }, fact_ids: x.fact_ids }));
        continue;
      }
      const changed = old.title !== x.title || old.detail !== x.detail || old.expected !== x.expected || old.actual !== x.actual || old.fact_ids !== factIds || old.part_id !== x.part_id || old.supplier_id !== x.supplier_id;
      if (old.status === "resolved" && old.note?.startsWith("dismissed") && !changed) continue; // closed on purpose, and nothing new
      if (old.status === "resolved") {
        // It is back. A question that was asked before stays on record, the issue is open again.
        run("UPDATE issues SET status = 'open', note = NULL, addressee = NULL, assignee_role = NULL, question = NULL, title = ?, detail = ?, expected = ?, actual = ?, part_id = ?, supplier_id = ?, fact_ids = ?, updated_at = ? WHERE id = ?",
          x.title, x.detail, x.expected, x.actual, x.part_id, x.supplier_id, factIds, stampNow, old.id);
        res.reopened.push(old.id);
        events.push(() => logEvent({ actor: "data_agent", action: "issue.reopened", run_id: runId, object: { type: x.object.type, id: x.object.id }, summary: `I opened an issue again because the deviation is back: ${x.title}.`, input: { rule: x.key }, output: { issue_id: old.id, expected: x.expected, actual: x.actual }, fact_ids: x.fact_ids }));
      } else if (changed) {
        run("UPDATE issues SET title = ?, detail = ?, expected = ?, actual = ?, part_id = ?, supplier_id = ?, fact_ids = ?, updated_at = ? WHERE id = ?",
          x.title, x.detail, x.expected, x.actual, x.part_id, x.supplier_id, factIds, stampNow, old.id);
        res.updated.push(old.id);
      }
    }
    const still = new Set(drafts.map((x) => x.key));
    for (const old of existing.values()) {
      if (old.status === "resolved" || still.has(old.dedupe_key)) continue;
      run("UPDATE issues SET status = 'resolved', updated_at = ? WHERE id = ?", stampNow, old.id);
      // A task that was created for it has nothing left to do.
      const closedTasks = run("UPDATE tasks SET status = 'done', done_at = ? WHERE issue_id = ? AND status = 'open'", stampNow, old.id).changes;
      res.resolved.push(old.id);
      events.push(() => logEvent({ actor: "data_agent", action: "issue.resolved", run_id: runId, object: { type: old.object_type as ObjectType, id: old.object_id }, summary: `I closed an issue because the deviation is gone: ${old.title}.`, input: { rule: old.dedupe_key }, output: { issue_id: old.id, was: old.status, tasks_closed: closedTasks }, fact_ids: json<number[]>(old.fact_ids, []) }));
    }
  });
  for (const e of events) e();

  res.open_total = get<{ n: number }>("SELECT COUNT(*) AS n FROM issues WHERE status != 'resolved'")?.n ?? 0;
  const c = res.checked;
  logEvent({ actor: "data_agent", action: "rules.checked", run_id: runId,
    summary: `I checked ${plural(c.order_lines, "open order line")}, ${plural(c.shipments, "shipment")} and ${plural(c.lots, "lot")} in stock against what ${config.customer.name} expects and found ${plural(res.opened.length + res.reopened.length, "new deviation")}${res.resolved.length ? `, and ${plural(res.resolved.length, "earlier one")} ${res.resolved.length === 1 ? "is" : "are"} gone` : ""}.`,
    input: { now: stampNow, deadline: s.deadline, checked: c }, output: { opened: res.opened, reopened: res.reopened, updated: res.updated, resolved: res.resolved, open_total: res.open_total } });
  return res;
}
