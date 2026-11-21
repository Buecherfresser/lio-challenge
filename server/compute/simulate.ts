import type { EditionStatus } from "../../shared/api.ts";
import { loadSnapshot } from "./state.ts";
import type { Snapshot } from "./state.ts";
import { buildWorld } from "./world.ts";
import { computeEditions, toEditionStatus } from "./editions.ts";
import { currentWorld, editions, withPlan } from "./parts.ts";
import { normalizeScenario } from "./scenario.ts";
import type { Scenario } from "./scenario.ts";

// What-if: the copies per edition under changed assumptions, next to the current state.
// A pure function of the database state and the scenario. Nothing is stored.

export interface CopiesByProduct { product_id: string; copies: number }

export interface Simulation {
  valid: boolean;                 // false = the scenario is malformed or points at things that do not exist
  problems: string[];
  scenario: Scenario;
  baseline: EditionStatus[];
  result: EditionStatus[];
  /** result minus baseline per product */
  diff: { product_id: string; safe: number; uncertain: number; lost: number }[];
  /** Copies that can be packed today (safe or uncertain) and cannot be packed any more under the scenario,
   *  plus, for already_short parts, the copies those parts cost as things stand. */
  copies_at_risk: number;
  copies_at_risk_by_product: CopiesByProduct[];
  /** Copies the scenario adds or secures: per product the larger of the gain in safe and the gain in safe + uncertain. */
  copies_gained: number;
  copies_gained_by_product: CopiesByProduct[];
}

const possible = (e: EditionStatus) => e.safe + e.uncertain;
const byId = (list: EditionStatus[]) => new Map(list.map((e) => [e.product_id, e]));
const sum = (list: CopiesByProduct[]) => list.reduce((s, x) => s + x.copies, 0);

function editionsUnder(snap: Snapshot, scenario: Scenario, unlimitedParts?: Set<string>): { editions: EditionStatus[]; problems: string[] } {
  const world = buildWorld(snap, withPlan(snap, scenario), { unlimitedParts });
  return { editions: computeEditions(world).map(toEditionStatus), problems: world.problems };
}

/** Per product: the larger of the gain in safe copies and the gain in safe + uncertain copies from `from` to `to`. */
export function gain(from: EditionStatus[], to: EditionStatus[]): CopiesByProduct[] {
  const a = byId(from);
  return to.map((e) => { const b = a.get(e.product_id); return { product_id: e.product_id, copies: b ? Math.max(0, possible(e) - possible(b), e.safe - b.safe) : 0 }; });
}
/** Per product: the copies that could be packed in `from` and cannot in `to`. */
export function loss(from: EditionStatus[], to: EditionStatus[]): CopiesByProduct[] {
  const b = byId(to);
  return from.map((e) => { const r = b.get(e.product_id); return { product_id: e.product_id, copies: r ? Math.max(0, possible(e) - possible(r)) : 0 }; });
}

export function simulate(input: unknown, snap: Snapshot = loadSnapshot()): Simulation {
  const { scenario, problems } = normalizeScenario(input);
  const baseline = editions(snap);
  const happening: Scenario = { changes: scenario.changes.filter((c) => c.type !== "already_short") };
  const short = new Set(scenario.changes.filter((c) => c.type === "already_short").map((c) => c.part_id!));

  const res = happening.changes.length ? editionsUnder(snap, happening) : { editions: baseline, problems: [] as string[] };
  problems.push(...res.problems);
  const atRisk = loss(baseline, res.editions);
  if (short.size) {
    // What the short parts cost today: the copies we could pack if these parts were no limit.
    const free = editionsUnder(snap, { changes: [] }, short);
    for (const id of short) if (!currentWorld(snap).parts.has(id)) problems.push(`${id} is not a part of a launch product.`);
    const cost = new Map(free.editions.map((e) => [e.product_id, Math.max(0, possible(e) - possible(byId(baseline).get(e.product_id)!))]));
    for (const x of atRisk) x.copies += cost.get(x.product_id) ?? 0;
  }
  const gained = gain(baseline, res.editions);
  const base = byId(baseline);
  return {
    valid: problems.length === 0 && scenario.changes.length > 0,
    problems: [...new Set(scenario.changes.length ? problems : [...problems, "The scenario has no changes."])],
    scenario,
    baseline,
    result: res.editions,
    diff: res.editions.map((e) => { const b = base.get(e.product_id)!; return { product_id: e.product_id, safe: e.safe - b.safe, uncertain: e.uncertain - b.uncertain, lost: e.lost - b.lost }; }),
    copies_at_risk: sum(atRisk),
    copies_at_risk_by_product: atRisk,
    copies_gained: sum(gained),
    copies_gained_by_product: gained,
  };
}

/**
 * What an action is worth against a risk: the state with the risk happening, with and without the action.
 * The action's changes come after the risk's, so they win where both touch the same lot, shipment or part.
 */
export function simulateAction(riskScenario: unknown, actionScenario: unknown, snap: Snapshot = loadSnapshot()): { valid: boolean; problems: string[]; without: EditionStatus[]; with: EditionStatus[]; copies_saved: number; copies_saved_by_product: CopiesByProduct[] } {
  const risk = normalizeScenario(riskScenario).scenario;
  const action = normalizeScenario(actionScenario);
  const riskHappening = risk.changes.filter((c) => c.type !== "already_short");
  const actionChanges = action.scenario.changes.filter((c) => c.type !== "already_short");
  const without = riskHappening.length ? editionsUnder(snap, { changes: riskHappening }).editions : editions(snap);
  const withAction = editionsUnder(snap, { changes: [...riskHappening, ...actionChanges] });
  const problems = [...action.problems, ...withAction.problems.filter((p) => !riskHappening.length || actionChanges.some((c) => (c.lot_id && p.includes(c.lot_id)) || (c.shipment_id && p.includes(c.shipment_id)) || (c.part_id && p.includes(c.part_id))))];
  if (!actionChanges.length) problems.push("The option has no change that the what-if tool can compute.");
  const saved = gain(without, withAction.editions);
  return { valid: problems.length === 0, problems: [...new Set(problems)], without, with: withAction.editions, copies_saved: sum(saved), copies_saved_by_product: saved };
}
