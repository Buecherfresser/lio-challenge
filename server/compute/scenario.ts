import { arr, enumT, nullable, numT, obj, str } from "../llm.ts";

// A what-if scenario: a list of changes applied on top of the current state, in order.
// A later change wins over an earlier one on the same lot, shipment or part.
// Every change uses the same flat shape so a model can fill it under a strict schema; fields a type does not use are null.

export const CHANGE_TYPES = [
  "remove_shipment",   // the shipment does not arrive (optionally only one part of it)
  "move_shipment",     // the shipment reaches the distribution center at `arrival`, or `delay_hours` later (negative = earlier)
  "block_lot",         // the lot cannot be used
  "release_lot",       // the lot is released and usable
  "set_lot_quantity",  // the lot holds `quantity` units
  "part_unavailable",  // no supply of the part at all
  "add_supply",        // `quantity` extra units of the part, at the line at `arrival` (null = already there), `certainty` safe or uncertain
  "drop_uncertain",    // the uncertain supply of the part does not arrive and is not released
  "already_short",     // the part is short as things stand: measure the copies it costs today
] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export interface ScenarioChange {
  type: ChangeType;
  part_id: string | null;
  lot_id: string | null;
  shipment_id: string | null;
  quantity: number | null;
  arrival: string | null;      // ISO timestamp
  delay_hours: number | null;
  certainty: "safe" | "uncertain" | null;
}
export interface Scenario { changes: ScenarioChange[] }

export const EMPTY_SCENARIO: Scenario = { changes: [] };

/** Strict JSON schema of a scenario, for tool parameters and structured output. */
export const scenarioSchema = obj({
  changes: arr(obj({
    type: enumT([...CHANGE_TYPES], "what changes"),
    part_id: nullable(str("part id, for part_unavailable, add_supply, drop_uncertain, already_short, and optionally remove_shipment")),
    lot_id: nullable(str("lot id (goods receipt number), for block_lot, release_lot, set_lot_quantity")),
    shipment_id: nullable(str("shipment id, for remove_shipment and move_shipment")),
    quantity: nullable(numT("units, for set_lot_quantity and add_supply")),
    arrival: nullable(str("ISO timestamp when the units are at the distribution center, for move_shipment and add_supply. null on add_supply = already there")),
    delay_hours: nullable(numT("hours later (negative = earlier) than currently expected, for move_shipment when no arrival is given")),
    certainty: nullable(enumT(["safe", "uncertain"], "for add_supply")),
  })),
});

/** The scenario format in words, for prompts. */
export const SCENARIO_HELP = `A scenario is {"changes": [...]}. Each change has all of these keys, null where it does not apply:
type, part_id, lot_id, shipment_id, quantity, arrival, delay_hours, certainty.
Types:
- remove_shipment: shipment_id (part_id optional). The shipment does not arrive.
- move_shipment: shipment_id plus arrival (ISO time at the distribution center) or delay_hours (negative = earlier).
- block_lot: lot_id. The lot cannot be used.
- release_lot: lot_id. A blocked or unclear lot becomes usable.
- set_lot_quantity: lot_id, quantity. The lot really holds this many units.
- part_unavailable: part_id. No supply of this part at all.
- add_supply: part_id, quantity, arrival (ISO time, null = already in the building), certainty (safe or uncertain).
- drop_uncertain: part_id. Everything uncertain for this part (blocked lots, inbound shipments) does not come.
- already_short: part_id. Use this when the part is short as things stand today. It measures how many copies the part costs right now.
Changes apply in order. A later change wins over an earlier one on the same lot, shipment or part.`;

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

/** Bring any input into the scenario shape. Unknown types are dropped and reported. */
export function normalizeScenario(input: unknown): { scenario: Scenario; problems: string[] } {
  const problems: string[] = [];
  const raw = input && typeof input === "object" && Array.isArray((input as { changes?: unknown }).changes) ? (input as { changes: unknown[] }).changes : Array.isArray(input) ? input : null;
  if (!raw) return { scenario: { changes: [] }, problems: ["The scenario has no list of changes."] };
  const changes: ScenarioChange[] = [];
  for (const [i, c] of raw.entries()) {
    const o = (c ?? {}) as Record<string, unknown>;
    const type = s(o.type) as ChangeType | null;
    if (!type || !CHANGE_TYPES.includes(type)) { problems.push(`Change ${i + 1} has an unknown type "${String(o.type)}".`); continue; }
    const ch: ScenarioChange = {
      type, part_id: s(o.part_id), lot_id: s(o.lot_id), shipment_id: s(o.shipment_id), quantity: n(o.quantity), arrival: s(o.arrival), delay_hours: n(o.delay_hours),
      certainty: o.certainty === "safe" || o.certainty === "uncertain" ? o.certainty : null,
    };
    const need = (cond: boolean, what: string) => { if (!cond) problems.push(`Change ${i + 1} (${type}) needs ${what}.`); return cond; };
    let ok = true;
    if (type === "remove_shipment") ok = need(!!ch.shipment_id, "a shipment_id");
    if (type === "move_shipment") ok = need(!!ch.shipment_id, "a shipment_id") && need(ch.arrival !== null || ch.delay_hours !== null, "an arrival time or delay_hours");
    if (type === "block_lot" || type === "release_lot") ok = need(!!ch.lot_id, "a lot_id");
    if (type === "set_lot_quantity") ok = need(!!ch.lot_id, "a lot_id") && need(ch.quantity !== null && ch.quantity >= 0, "a quantity of zero or more");
    if (type === "part_unavailable" || type === "drop_uncertain" || type === "already_short") ok = need(!!ch.part_id, "a part_id");
    if (type === "add_supply") ok = need(!!ch.part_id, "a part_id") && need(ch.quantity !== null && ch.quantity > 0, "a quantity above zero");
    if (ch.arrival !== null && Number.isNaN(new Date(ch.arrival).getTime())) { problems.push(`Change ${i + 1} has an arrival time that is not a date: "${ch.arrival}".`); ok = false; }
    if (ok) changes.push(ch);
  }
  return { scenario: { changes }, problems };
}

/** A stable identity of what a scenario is about: change types and the objects they touch, without quantities and times. */
export function scenarioSignature(sc: Scenario): string {
  return sc.changes.map((c) => `${c.type}:${c.lot_id ?? c.shipment_id ?? ""}:${c.part_id ?? ""}`).sort().join(",");
}
