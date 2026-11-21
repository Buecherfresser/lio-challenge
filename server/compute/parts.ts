import type { EditionStatus, Fact, ObjectRef, PartDetail, PartRow, PartSourceLine, PartStatus } from "../../shared/api.ts";
import { eventsForObjects } from "../events.ts";
import { fmtQty } from "./settings.ts";
import { loadSnapshot, memo } from "./state.ts";
import type { Snapshot } from "./state.ts";
import { buildWorld, supplyTotals } from "./world.ts";
import type { PartState, World } from "./world.ts";
import { computeEditions, toEditionStatus } from "./editions.ts";
import type { EditionDetail } from "./editions.ts";
import { EMPTY_SCENARIO } from "./scenario.ts";
import { issuesFor, riskRows, toRisk } from "./rows.ts";

// The parts view and the copies per edition for the current state. Cached with the snapshot.

export const currentWorld = (snap: Snapshot = loadSnapshot()): World => memo(snap, "world", () => buildWorld(snap, EMPTY_SCENARIO));
export const editionDetails = (snap: Snapshot = loadSnapshot()): EditionDetail[] => memo(snap, "editions", () => computeEditions(currentWorld(snap)));
/** Copies per edition: safe, uncertain, lost. */
export const editions = (snap: Snapshot = loadSnapshot()): EditionStatus[] => editionDetails(snap).map(toEditionStatus);

/** Orders, shipments and lots that belong to a part, for issues and history. */
function refsOf(part: PartState): ObjectRef[] {
  return [
    { type: "part", id: part.part_id },
    ...part.lines.map((l): ObjectRef => ({ type: "po_line", id: l.po_line_id })),
    ...part.lots.map((l): ObjectRef => ({ type: "lot", id: l.lot_id })),
    ...[...new Set(part.inbound.map((i) => i.shipment_id))].map((id): ObjectRef => ({ type: "shipment", id })),
  ];
}

/** Supply of a part that is fitted into another part follows that part. */
function hostCover(world: World, part: PartState): { safe: number; uncertain: number } | null {
  const host = part.supplied_within ? world.parts.get(part.supplied_within) : undefined;
  if (!host) return null;
  const t = supplyTotals(host);
  const share = (x: number) => (host.need > 0 ? Math.min(1, x / host.need) : 1);
  const safe = Math.round(part.need * share(t.safe));
  return { safe, uncertain: Math.round(part.need * share(t.safe + t.uncertain)) - safe };
}

function toRow(world: World, part: PartState): PartRow {
  const t = supplyTotals(part);
  const host = hostCover(world, part);
  const safe = host ? host.safe : t.safe, uncertain = host ? host.uncertain : t.uncertain;
  const issues = issuesFor(part.part_id, refsOf(part), false);
  const status: PartStatus = part.need <= safe ? "ok" : part.need <= safe + uncertain ? "uncertain" : "lost";
  const shipped = part.lines.reduce((s, l) => s + (l.shipped ?? part.inbound.filter((i) => i.departed && i.lines.includes(l.po_line_id)).reduce((a, i) => a + i.qty / Math.max(1, i.lines.length), 0)), 0);
  return {
    part_id: part.part_id, description: part.description, category: part.category, status, products: part.products, suppliers: part.suppliers,
    need: Math.round(part.need),
    ordered: Math.round(part.lines.reduce((s, l) => s + Math.max(0, l.ordered - l.received), 0)),
    confirmed: Math.round(part.lines.reduce((s, l) => s + (l.confirmed ?? 0), 0)),
    shipped: Math.round(shipped),
    in_transit: Math.round(part.inbound.reduce((s, i) => s + i.qty, 0)),
    arrived: Math.round(part.arrived),
    stock: Math.round(part.erp_stock),
    usable: Math.round(t.usable_stock),
    available_safe: Math.round(safe),
    available_uncertain: Math.round(uncertain),
    gap: Math.max(0, Math.round(part.need - safe - uncertain)),
    open_issues: issues.length,
    open_questions: issues.filter((i) => i.question && (i.status === "open" || i.status === "asked")).length,
  };
}

/** One row per part of the launch products. */
export function partRows(snap: Snapshot = loadSnapshot()): PartRow[] {
  return memo(snap, "partRows", () => {
    const world = currentWorld(snap);
    const rank: Record<PartStatus, number> = { lost: 0, uncertain: 1, ok: 2 };
    return [...world.parts.values()].map((p) => toRow(world, p)).sort((a, b) => rank[a.status] - rank[b.status] || b.gap - a.gap || a.part_id.localeCompare(b.part_id));
  });
}

function sourceLines(world: World, part: PartState): PartSourceLine[] {
  const lines: PartSourceLine[] = [];
  const productOf = (id: string) => world.products.find((p) => p.product_id === id)!;
  lines.push({
    label: "Need", quantity: Math.round(part.need), confidence: "info", when: null, object: { type: "part", id: part.part_id },
    detail: part.products.map((u) => { const p = productOf(u.product_id); return p.demandKnown ? `${p.name}: ${fmtQty(p.remaining)} still to pack x ${u.qty_per}` : `${p.name}: day-one demand unknown`; }).join(", "),
    fact_ids: [...new Set(part.products.flatMap((u) => productOf(u.product_id).fact_ids))],
  });
  if (part.supplied_within) {
    const host = world.parts.get(part.supplied_within);
    lines.push({ label: "Supplied inside another part", quantity: null, confidence: "info", when: null, object: host ? { type: "part", id: host.part_id } : null,
      detail: `Comes fitted into ${host ? `${host.description} (${host.part_id})` : part.supplied_within} and follows its supply. It is not ordered, received or stocked on its own.`, fact_ids: part.fact_ids });
  }
  if (part.blocked_rev && !part.use_up_old_rev) {
    lines.push({ label: "Revision", quantity: null, confidence: "info", when: null, object: { type: "part", id: part.part_id },
      detail: `Released revision ${part.drawing_rev ?? "unknown"}. Revision ${part.blocked_rev} must not be packed any more.`, fact_ids: part.fact_ids });
  }
  const byClass = { safe: 0, uncertain: 1, lost: 2 };
  const stock = part.items.filter((i) => i.kind === "lot").sort((a, b) => byClass[a.cls] - byClass[b.cls] || (a.when ?? "").localeCompare(b.when ?? ""));
  for (const i of stock) lines.push({ label: i.label, quantity: Math.round(i.qty), detail: i.detail, when: i.when, confidence: i.cls, object: i.object, fact_ids: i.fact_ids });
  if (part.consumed > 0) {
    lines.push({ label: "Used since the stock count", quantity: -Math.round(part.consumed), confidence: "info", when: null, object: { type: "part", id: part.part_id },
      detail: `Stock per the stock list is ${fmtQty(part.erp_stock)}. Copies packed since then used ${fmtQty(part.consumed)}, taken off usable lots first (oldest first).`, fact_ids: [...new Set(part.consumed_fact_ids)] });
  }
  const rest = part.items.filter((i) => i.kind !== "lot").sort((a, b) => byClass[a.cls] - byClass[b.cls] || a.at - b.at);
  for (const i of rest) lines.push({ label: i.cls === "lost" && i.kind !== "gap" ? `${i.label}, not in time` : i.label, quantity: Math.round(i.qty), detail: i.detail, when: i.when, confidence: i.cls, object: i.object, fact_ids: i.fact_ids });
  return lines;
}

/** Everything about one part: the row, where each number comes from, facts, issues, risks and history. */
export function partDetail(partId: string, snap: Snapshot = loadSnapshot()): PartDetail | null {
  const world = currentWorld(snap);
  const part = world.parts.get(partId);
  if (!part) return null;
  const refs = refsOf(part);
  const seen = new Map<number, Fact>();
  for (const r of refs) for (const f of snap.fx.ofObject(r.type, r.id)) seen.set(f.id, f);
  for (const u of part.products) for (const f of snap.fx.ofObject("product", u.product_id)) seen.set(f.id, f);
  const facts = [...seen.values()].sort((a, b) => b.id - a.id).slice(0, 400);
  return {
    ...toRow(world, part),
    drawing_rev: part.drawing_rev,
    critical: part.critical,
    sources: sourceLines(world, part),
    facts,
    issues: issuesFor(partId, refs),
    risks: riskRows("part_id = ? AND status != 'closed'", partId).map((r) => toRisk(r, { trace: false })),
    history: eventsForObjects(refs, 60),
  };
}
