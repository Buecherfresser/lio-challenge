import type { EditionStatus } from "../../shared/api.ts";
import { packingHoursLeft } from "../clock.ts";
import { fmtHours, fmtQty, fmtTime } from "./settings.ts";
import { supplyTotals } from "./world.ts";
import type { PartState, ProductState, SupplyClass, World } from "./world.ts";

// Copies per edition. Two runs over the same state: one with safe supply only, one with safe plus uncertain.
// In each run the parts are handed to the products (by priority rank, or in proportion to need), and a product can
// pack min over its parts of floor(units / units per copy), limited by what the line packs after the parts arrive.

interface Piece { qty: number; at: number; cls: SupplyClass }
type Lists = Map<string, Piece[]>;

export type Binding =
  | { kind: "demand" }
  | { kind: "part"; part_id: string }
  | { kind: "capacity" }
  | { kind: "late"; part_id: string; at: number };

interface RunResult { copies: number; binding: Binding }

const EPS = 1e-6;
const order = (a: Piece, b: Piece) => a.at - b.at || (a.cls === b.cls ? 0 : a.cls === "safe" ? -1 : 1);

/** What one product can pack from the given units, with the line's rate and the time the units arrive. */
function evaluate(p: ProductState, lists: Lists): RunResult {
  let best: RunResult = { copies: p.remaining, binding: { kind: "demand" } };
  const take = (copies: number, binding: Binding) => { if (copies < best.copies) best = { copies: Math.max(0, copies), binding }; };
  const eff = (at: number) => Math.max(at, p.packedAt);
  const hours = (t: number) => packingHoursLeft(new Date(t));

  // all units that come in time
  for (const { part_id, qty_per } of p.parts) {
    const total = (lists.get(part_id) ?? []).reduce((s, x) => s + x.qty, 0);
    take(Math.floor(total / qty_per + EPS), { kind: "part", part_id });
  }
  // the line: from each arrival time on, only rate x remaining hours can still be packed
  const times = [...new Set([p.packedAt, ...p.parts.flatMap((x) => (lists.get(x.part_id) ?? []).map((i) => eff(i.at)))])].sort((a, b) => a - b);
  for (const t of times) {
    let before = Infinity, limiting = "";
    if (t > p.packedAt) {
      for (const { part_id, qty_per } of p.parts) {
        const c = Math.floor((lists.get(part_id) ?? []).filter((i) => eff(i.at) < t).reduce((s, x) => s + x.qty, 0) / qty_per + EPS);
        if (c < before) { before = c; limiting = part_id; }
      }
    } else before = 0;
    const h = hours(t);
    const after = h <= 0 ? 0 : p.rate === null ? Infinity : p.rate * h;
    if (!Number.isFinite(before + after)) continue;
    take(Math.floor(before + after + EPS), t > p.packedAt ? { kind: "late", part_id: limiting, at: t } : { kind: "capacity" });
  }
  return best;
}

/** Take `units` from a list, earliest first. Returns the pieces taken, the list keeps the rest. */
function consume(list: Piece[], units: number): Piece[] {
  list.sort(order);
  const taken: Piece[] = [];
  let left = units;
  while (left > EPS && list.length) {
    const x = list[0];
    const q = Math.min(x.qty, left);
    taken.push({ ...x, qty: q });
    x.qty -= q; left -= q;
    if (x.qty <= EPS) list.shift();
  }
  return taken;
}

/** Hand the parts of the given classes to the products and compute the copies each can pack. */
function run(world: World, classes: SupplyClass[]): Map<string, RunResult> {
  const constraining = (part_id: string) => { const part = world.parts.get(part_id); return !!part && !part.unlimited && !part.supplied_within; };
  const pool: Lists = new Map();
  for (const part of world.parts.values()) {
    if (!constraining(part.part_id)) continue;
    pool.set(part.part_id, part.items.filter((i) => classes.includes(i.cls) && i.qty > 0 && Number.isFinite(i.at)).map((i) => ({ qty: i.qty, at: i.at, cls: i.cls })).sort(order));
  }
  const out = new Map<string, RunResult>();
  const active = world.products.filter((p) => p.demandKnown && p.remaining > 0).map((p) => ({ ...p, parts: p.parts.filter((x) => constraining(x.part_id)) }));
  for (const p of world.products) if (!active.some((a) => a.product_id === p.product_id)) out.set(p.product_id, { copies: 0, binding: { kind: "demand" } });

  // groups in order of priority rank. Products without a rank come last and share in proportion to need.
  const ranks = [...new Set(active.map((p) => p.rank ?? Infinity))].sort((a, b) => a - b);
  for (const rank of ranks) {
    const group = active.filter((p) => (p.rank ?? Infinity) === rank);
    const mine = new Map<string, Lists>(group.map((p) => [p.product_id, new Map()]));
    const copies = new Map<string, number>(group.map((p) => [p.product_id, 0]));
    for (let round = 0; round < 6; round++) {
      const hungry = group.filter((p) => copies.get(p.product_id)! < p.remaining);
      if (!hungry.length) break;
      // offer every hungry product its share of what is left of each part
      const offer = new Map<string, Lists>(hungry.map((p) => [p.product_id, new Map()]));
      for (const [part_id, list] of pool) {
        const users = hungry.map((p) => ({ p, qty_per: p.parts.find((x) => x.part_id === part_id)?.qty_per ?? 0 })).filter((u) => u.qty_per > 0);
        if (!users.length || !list.length) continue;
        const demand = users.map((u) => (u.p.remaining - copies.get(u.p.product_id)!) * u.qty_per);
        const total = demand.reduce((a, b) => a + b, 0);
        if (total <= 0) continue;
        users.forEach((u, k) => offer.get(u.p.product_id)!.set(part_id, list.map((x) => ({ ...x, qty: x.qty * (demand[k] / total) }))));
        pool.set(part_id, []);
      }
      let improved = false;
      for (const p of hungry) {
        const lists: Lists = new Map();
        for (const { part_id } of p.parts) lists.set(part_id, [...(mine.get(p.product_id)!.get(part_id) ?? []), ...(offer.get(p.product_id)!.get(part_id) ?? [])].sort(order));
        const r = evaluate(p, lists);
        if (r.copies > copies.get(p.product_id)!) improved = true;
        copies.set(p.product_id, r.copies);
        out.set(p.product_id, r);
        // keep what the copies need, hand the rest back
        for (const { part_id, qty_per } of p.parts) {
          const list = lists.get(part_id)!;
          mine.get(p.product_id)!.set(part_id, consume(list, r.copies * qty_per));
          pool.set(part_id, [...(pool.get(part_id) ?? []), ...list].sort(order));
        }
      }
      if (!improved) break;
    }
  }
  return out;
}

export interface EditionDetail extends EditionStatus {
  binding: Binding;
  capacity: number | null;      // copies the line can still pack, null = rate unknown
  hours_left: number;
  rate: number | null;
  rank: number | null;
  fact_ids: number[];
}

export function computeEditions(world: World): EditionDetail[] {
  const safeRun = run(world, ["safe"]);
  const possibleRun = run(world, ["safe", "uncertain"]);
  const ranked = world.products.filter((p) => p.rank !== null).sort((a, b) => a.rank! - b.rank!);

  return world.products.map((p) => {
    const base = { product_id: p.product_id, name: p.name, demand: p.demand, packed: p.packed, remaining: p.remaining, rate: p.rate, rank: p.rank, hours_left: p.hoursLeft,
      capacity: p.rate === null ? null : Math.floor(p.rate * p.hoursLeft), fact_ids: p.fact_ids };
    if (!p.demandKnown) {
      return { ...base, safe: 0, uncertain: 0, lost: 0, bottleneck_part_id: null, binding: { kind: "demand" } as Binding,
        bottleneck_reason: "The launch plan has not been read yet, so the day-one demand of this edition is unknown." };
    }
    const s = safeRun.get(p.product_id)!, q = possibleRun.get(p.product_id)!;
    // The second run is the world in which everything uncertain comes through. A part that an edition with a higher
    // priority claims in that world is not safe for this one, so safe is what holds in both runs.
    const possible = q.copies, safe = Math.min(s.copies, q.copies);
    const lost = p.remaining - possible, uncertain = possible - safe;
    const binding: Binding = lost > 0 ? q.binding : uncertain > 0 ? s.binding : { kind: "demand" };
    return { ...base, safe, uncertain, lost, binding, bottleneck_part_id: binding.kind === "part" || binding.kind === "late" ? binding.part_id : null,
      bottleneck_reason: reason(world, p, binding, { safe, uncertain, lost }, ranked) };
  });
}

function reason(world: World, p: ProductState, b: Binding, n: { safe: number; uncertain: number; lost: number }, ranked: ProductState[]): string {
  if (b.kind === "demand") return p.remaining === 0 ? "Everything is packed." : `All ${fmtQty(p.remaining)} remaining copies are covered by usable stock.`;
  if (b.kind === "capacity") {
    return `Packing capacity: ${fmtQty(p.rate ?? 0)} copies per hour over ${fmtHours(p.hoursLeft)} packing hours gives ${fmtQty((p.rate ?? 0) * p.hoursLeft)} copies for ${fmtQty(p.remaining)} still to pack.`;
  }
  const part = world.parts.get(b.part_id);
  if (!part) return "";
  if (b.kind === "late") {
    const h = packingHoursLeft(new Date(b.at));
    return `${part.description} (${part.part_id}): the next units are at the distribution center ${fmtTime(b.at)}, which leaves ${fmtHours(h)} packing hours${p.rate !== null ? ` at ${fmtQty(p.rate)} copies per hour` : ""}.`;
  }
  return partSentence(part, p, ranked, n);
}

function partSentence(part: PartState, p: ProductState, ranked: ProductState[], n: { safe: number; uncertain: number; lost: number }): string {
  const t = supplyTotals(part);
  const shared = part.products.filter((u) => u.product_id !== p.product_id);
  const first = shared.length && p.rank !== null ? ranked.find((r) => r.rank! < p.rank! && shared.some((u) => u.product_id === r.product_id)) : undefined;
  // the largest uncertain piece, and the piece that misses the deadline by the least
  const unc = part.items.filter((i) => i.cls === "uncertain").sort((a, b) => b.qty - a.qty)[0];
  const lostItem = part.items.filter((i) => i.cls === "lost").sort((a, b) => a.at - b.at || b.qty - a.qty)[0];
  const bits = [
    `${part.description} (${part.part_id}): ${fmtQty(t.safe)} usable now${t.uncertain > 0 ? ` and ${fmtQty(t.uncertain)} uncertain` : ""} for ${fmtQty(part.need)} needed${shared.length ? " across the editions" : ""}.`,
    first ? `${first.name} is served first.` : shared.length && p.rank === null ? "The editions share it in proportion to need." : null,
    n.uncertain > 0 && unc ? `Uncertain: ${fmtQty(unc.qty)} (${unc.detail}).` : null,
    n.lost > 0 && lostItem && part.need > t.safe + t.uncertain ? `Not usable in time: ${fmtQty(lostItem.qty)} (${lostItem.detail}).` : null,
  ];
  return bits.filter(Boolean).join(" ");
}

export const toEditionStatus = (e: EditionDetail): EditionStatus => ({
  product_id: e.product_id, name: e.name, demand: e.demand, packed: e.packed, remaining: e.remaining, safe: e.safe, uncertain: e.uncertain, lost: e.lost,
  bottleneck_part_id: e.bottleneck_part_id, bottleneck_reason: e.bottleneck_reason,
});
