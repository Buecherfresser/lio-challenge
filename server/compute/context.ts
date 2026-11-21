import type { Fact } from "../../shared/api.ts";
import { config } from "../config.ts";
import { all } from "../db.ts";
import { packingHoursLeft } from "../clock.ts";
import { VOCAB } from "../vocab.ts";
import { fmtTime } from "./settings.ts";
import { listFacts, loadSnapshot } from "./state.ts";
import type { Snapshot } from "./state.ts";
import { currentWorld, editionDetails, partDetail, partRows } from "./parts.ts";
import { openIssues } from "./rows.ts";

// Compact, read-only views of the state for the agents. Every fact carries its id so it can be cited.

export interface FactLine { id: number; object: string; field: string; value: string; unit: string | null; part_id: string | null; source: string; date: string | null; origin: string; confidence: number }
export const factLine = (f: Fact): FactLine => ({ id: f.id, object: `${f.object_type}:${f.object_id}`, field: f.field, value: f.value.length > 600 ? `${f.value.slice(0, 600)}…` : f.value, unit: f.unit, part_id: f.part_id, source: f.source_path, date: f.observed_at, origin: f.origin, confidence: f.confidence });

const FACT_COLS = "id, object_type, object_id, field, value, unit, part_id, source_path, source_version, observed_at, recorded_at, origin, confidence, quote";

/** Fields that hold free text or several values per document. */
const TEXT_FIELDS: { type: string; field: string }[] = Object.entries(VOCAB).flatMap(([type, def]) =>
  Object.entries(def!.fields).filter(([, d]) => d.kind === "text" || d.kind === "json").map(([field]) => ({ type, field })));
const LIST_FIELDS = new Set(Object.entries(VOCAB).flatMap(([type, def]) => Object.entries(def!.fields).filter(([, d]) => d.compare === false).map(([field]) => `${type}.${field}`)));

/** What the sources currently say about one object: the latest value per field and source, and every entry of list fields. */
export function objectFacts(type: string, id: string, snap: Snapshot = loadSnapshot()): Fact[] {
  const out = new Map<number, Fact>();
  for (const f of snap.fx.ofObject(type, id)) out.set(f.id, f);
  for (const key of LIST_FIELDS) {
    const [t, field] = key.split(".");
    if (t === type) for (const f of listFacts(snap, t, field)) if (f.object_id === id) out.set(f.id, f);
  }
  return [...out.values()].sort((a, b) => a.id - b.id);
}

export function overviewForAgent(snap: Snapshot = loadSnapshot()) {
  return {
    now: fmtTime(snap.now), now_iso: new Date(snap.now).toISOString(),
    deadline: fmtTime(snap.deadline), deadline_iso: config.deadline,
    packing_hours_left_from_now: Math.round(packingHoursLeft(new Date(snap.now)) * 10) / 10,
    shifts: config.shifts,
    editions: editionDetails(snap).map((e) => ({
      product_id: e.product_id, name: e.name, day_one_demand: e.demand, packed: e.packed, still_to_pack: e.remaining, safe: e.safe, uncertain: e.uncertain, lost: e.lost,
      bottleneck_part_id: e.bottleneck_part_id, bottleneck: e.bottleneck_reason, pack_rate_per_hour: e.rate, packing_hours_counted: Math.round(e.hours_left * 10) / 10, line_capacity_copies: e.capacity, priority_rank: e.rank, fact_ids: e.fact_ids,
    })),
    parts: partRows(snap).map((r) => ({
      part_id: r.part_id, description: r.description, category: r.category, status: r.status, used_in: r.products.map((p) => `${p.product_id} x${p.qty_per}`), suppliers: r.suppliers.map((s) => `${s.supplier_id} ${s.name}`),
      need: r.need, stock_per_stock_list: r.stock, usable_now: r.usable, safe: r.available_safe, uncertain: r.available_uncertain, gap: r.gap, open_order_quantity: r.ordered, on_open_shipments: r.in_transit, open_issues: r.open_issues,
    })),
    suppliers: [...snap.suppliers.values()].map((s) => ({ supplier_id: s.supplier_id, name: s.name, country: s.country, status: snap.fx.val("supplier", s.supplier_id, "status") ?? s.status, qualification: snap.fx.val("supplier", s.supplier_id, "qualification_status") ?? s.qualification_status })),
  };
}

export function partForAgent(partId: string, snap: Snapshot = loadSnapshot()) {
  const d = partDetail(partId, snap);
  const part = currentWorld(snap).parts.get(partId);
  if (!d || !part) return { error: `${partId} is not a part of a launch product.` };
  const supplierIds = [...new Set([...part.suppliers.map((s) => s.supplier_id), ...part.lines.map((l) => l.supplier_id), ...part.lots.map((l) => l.supplier_id)].filter((x): x is string => !!x))];
  return {
    part_id: d.part_id, description: d.description, category: d.category, critical: d.critical, released_revision: d.drawing_rev, blocked_revision: part.use_up_old_rev ? null : part.blocked_rev,
    status: d.status, need: d.need, safe: d.available_safe, uncertain: d.available_uncertain, gap: d.gap, used_in: d.products,
    // everything that counts, and of what comes too late only the nearest misses
    where_the_numbers_come_from: [...d.sources.filter((s) => s.confidence !== "lost"), ...d.sources.filter((s) => s.confidence === "lost").slice(0, 8)].map((s) => ({ label: s.label, quantity: s.quantity, confidence: s.confidence, detail: s.detail, when: s.when, object: s.object ? `${s.object.type}:${s.object.id}` : null, fact_ids: s.fact_ids.slice(0, 12) })),
    lots: part.lots.map((l) => ({ lot_id: l.lot_id, quantity_per_stock_list: l.erp_qty, class: l.cls, reason: l.reason, received: l.received, supplier_id: l.supplier_id, order_line: l.po_line_id, revision: l.revision, inspection: l.inspection, quality_status: l.quality, lowest_quantity_stated: l.disputed_low })),
    supply_too_late_or_unusable_in_total: Math.round(d.sources.filter((s) => s.confidence === "lost").reduce((a, s) => a + (s.quantity ?? 0), 0)),
    open_shipments: [...part.inbound].sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity)).slice(0, 12).map((i) => ({ shipment_id: i.shipment_id, quantity: Math.round(i.qty), quantity_stated_by_a_document: i.stated, status: i.status, mode: i.mode, eta: i.eta, eta_is_at: i.destination, at_distribution_center: i.at === null ? null : fmtTime(i.at), at_distribution_center_iso: i.at === null ? null : new Date(i.at).toISOString(), overdue: i.overdue, class: i.cls, reason: i.reason, order_lines: i.lines })),
    open_order_lines_total: part.lines.length,
    open_order_lines: [...part.lines].sort((a, b) => (a.promised ?? "9").localeCompare(b.promised ?? "9")).slice(0, 15).map((l) => ({ order_line: l.po_line_id, supplier_id: l.supplier_id, status: l.status, ordered: l.ordered, confirmed: l.confirmed, shipped: l.shipped, received: l.received, promised: l.promised, revision: l.artwork_rev, balance: l.balance_qty, balance_eta: l.balance_eta, supplier_condition: l.release_condition, shipments: l.shipments })),
    suppliers: supplierIds.map((id) => {
      const s = snap.suppliers.get(id); const sp = snap.supplierParts.find((x) => x.supplier_id === id && x.part_id === partId);
      return { supplier_id: id, name: s?.name ?? id, country: s?.country ?? null, language: snap.fx.val("supplier", id, "language") ?? s?.language ?? null,
        price_list: sp ? { unit_price: sp.unit_price, currency: sp.currency, lead_time_days: sp.lead_time_days, minimum_order: sp.moq, share: sp.share, primary: !!sp.is_primary, note: sp.note } : null,
        facts: objectFacts("supplier", id, snap).map(factLine) };
    }),
    open_issues: d.issues.filter((i) => i.status !== "resolved").map((i) => ({ id: i.id, type: i.type, status: i.status, title: i.title, detail: i.detail, expected: i.expected, actual: i.actual, object: `${i.object.type}:${i.object.id}`, fact_ids: i.fact_ids })),
    facts_about_the_part: objectFacts("part", partId, snap).map(factLine),
    facts_about_lots: part.lots.flatMap((l) => objectFacts("lot", l.lot_id, snap)).map(factLine).slice(0, 120),
  };
}

export const issuesForAgent = () => openIssues().slice(0, 150).map((i) => ({ id: i.id, type: i.type, status: i.status, title: i.title, detail: i.detail, expected: i.expected, actual: i.actual, object: `${i.object.type}:${i.object.id}`, part_id: i.part_id, supplier_id: i.supplier_id, addressee: i.addressee, question: i.question, fact_ids: i.fact_ids }));

/** Text search over notices, offers, contract terms, capacity notes, other free-text facts and the summaries of documents. */
export function searchFacts(query: string, limit = 40): { facts: FactLine[]; documents: { path: string; type: string | null; date: string | null; summary: string }[] } {
  const words = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2))].slice(0, 8);
  if (!words.length) return { facts: [], documents: [] };
  const like = words.map((w) => `%${w}%`);
  const fieldCond = TEXT_FIELDS.map(() => "(object_type = ? AND field = ?)").join(" OR ");
  const wordCond = words.map(() => "(LOWER(value) LIKE ? OR LOWER(IFNULL(quote, '')) LIKE ? OR LOWER(object_id) LIKE ? OR LOWER(IFNULL(part_id, '')) LIKE ?)").join(" OR ");
  const rows = all<Fact>(`SELECT ${FACT_COLS} FROM facts WHERE (${fieldCond}) AND (${wordCond}) ORDER BY id DESC LIMIT 400`, ...TEXT_FIELDS.flatMap((f) => [f.type, f.field]), ...like.flatMap((l) => [l, l, l, l]));
  const score = (text: string) => words.filter((w) => text.toLowerCase().includes(w)).length;
  const seen = new Set<string>();
  const facts = rows.map((f) => ({ f, s: score(`${f.value} ${f.quote ?? ""} ${f.object_id} ${f.part_id ?? ""}`) }))
    .filter(({ f }) => { const k = `${f.object_type}|${f.object_id}|${f.field}|${f.value}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => b.s - a.s || b.f.id - a.f.id).slice(0, limit).map(({ f }) => factLine(f));
  const docCond = words.map(() => "(LOWER(summary) LIKE ? OR LOWER(path) LIKE ?)").join(" OR ");
  const docs = all<{ path: string; doc_type: string | null; doc_date: string | null; summary: string }>(`SELECT path, doc_type, doc_date, summary FROM documents WHERE current = 1 AND summary IS NOT NULL AND (${docCond}) LIMIT 200`, ...like.flatMap((l) => [l, l]));
  const documents = docs.map((d) => ({ d, s: score(`${d.summary} ${d.path}`) })).sort((a, b) => b.s - a.s).slice(0, 15).map(({ d }) => ({ path: d.path, type: d.doc_type, date: d.doc_date, summary: d.summary }));
  return { facts, documents };
}
