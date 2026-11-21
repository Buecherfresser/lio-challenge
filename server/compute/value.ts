import type { Settings } from "../../shared/api.ts";
import { json, kv } from "../db.ts";
import { fmtQty, fmtTime, settings } from "./settings.ts";
import { loadSnapshot } from "./state.ts";
import type { Snapshot } from "./state.ts";
import { normalizeScenario } from "./scenario.ts";
import type { Scenario } from "./scenario.ts";
import { simulateAction } from "./simulate.ts";
import type { CopiesByProduct } from "./simulate.ts";

// What copies are worth in money, and what waiting costs.
// The value of a copy and the autonomy limit come from .env and can be changed while the app runs.
// Nothing about a customer is written down here.

const KEY_LIMIT = "setting.autonomy_limit_eur";
const KEY_VALUE = "setting.value_per_copy_eur";
const HOUR = 3_600_000;

/** EUR per copy that makes day one, by product id. Empty when nothing is configured. */
export function valuePerCopy(): Record<string, number> {
  const stored = json<Record<string, number> | null>(kv.get(KEY_VALUE), null);
  return stored && Object.keys(stored).length ? stored : settings.valuePerCopyEur;
}

/** Below this cost the action agent carries out a binding option itself. 0 = a person approves every one. */
export function autonomyLimit(): number {
  const stored = kv.get(KEY_LIMIT);
  const n = stored === null ? NaN : Number(stored);
  return Number.isFinite(n) && n >= 0 ? n : settings.autonomyLimitEur;
}

export const currentSettings = (): Settings => ({ autonomy_limit_eur: autonomyLimit(), value_per_copy_eur: valuePerCopy() });

export function saveSettings(patch: Partial<Settings>): Settings {
  if (typeof patch.autonomy_limit_eur === "number" && Number.isFinite(patch.autonomy_limit_eur) && patch.autonomy_limit_eur >= 0) kv.set(KEY_LIMIT, String(patch.autonomy_limit_eur));
  if (patch.value_per_copy_eur && typeof patch.value_per_copy_eur === "object") {
    const clean = Object.fromEntries(Object.entries(patch.value_per_copy_eur).filter(([k, v]) => k.trim() && typeof v === "number" && Number.isFinite(v) && v >= 0));
    kv.set(KEY_VALUE, JSON.stringify(clean));
  }
  return currentSettings();
}

/** Copies in EUR. Null when no product with copies has a value, so a card never shows a made-up amount. */
export function valueOf(byProduct: CopiesByProduct[]): number | null {
  const values = valuePerCopy();
  let total = 0, known = false;
  for (const x of byProduct) {
    if (!x.copies) continue;
    const v = values[x.product_id];
    if (v === undefined) continue;
    known = true;
    total += x.copies * v;
  }
  return known ? Math.round(total * 100) / 100 : null;
}

export interface Timing {
  decide_by: string | null;            // ISO
  wait_copies_per_hour: number | null; // copies lost in the first hour after decide_by
  wait_eur_per_hour: number | null;
  basis: string | null;                // one sentence a person can check
}

const NO_TIMING: Timing = { decide_by: null, wait_copies_per_hour: null, wait_eur_per_hour: null, basis: null };
const timed = (sc: Scenario) => sc.changes.some((c) => (c.type === "add_supply" || c.type === "move_shipment") && c.arrival);
const shifted = (sc: Scenario, hours: number): Scenario => ({
  changes: sc.changes.map((c) => ((c.type === "add_supply" || c.type === "move_shipment") && c.arrival ? { ...c, arrival: new Date(new Date(c.arrival).getTime() + hours * HOUR).toISOString() } : c)),
});

/**
 * How long a decision can wait. An option that brings supply in at a stated time is worth less once that time slips
 * past what the line can still pack. The latest start without a loss is found by running the same what-if with
 * later and later arrivals. An offer that runs out earlier wins.
 */
export function timingOf(riskScenario: unknown, actionScenario: unknown, opts: { expiresAt?: string | null; snap?: Snapshot } = {}): Timing {
  const snap = opts.snap ?? loadSnapshot();
  const action = normalizeScenario(actionScenario).scenario;
  const expires = opts.expiresAt && !Number.isNaN(new Date(opts.expiresAt).getTime()) ? new Date(opts.expiresAt).getTime() : null;
  const expiry = (t: Timing): Timing => {
    if (expires === null) return t;
    const byOffer = t.decide_by === null || expires < new Date(t.decide_by).getTime();
    return byOffer ? { ...t, decide_by: new Date(expires).toISOString(), basis: `The offer behind this option runs out on ${fmtTime(expires)}.${t.basis ? ` ${t.basis}` : ""}` } : t;
  };
  if (!timed(action)) return expiry(NO_TIMING);

  const saved = (hours: number) => simulateAction(riskScenario, shifted(action, hours), snap);
  const base = saved(0);
  if (!base.valid || base.copies_saved <= 0) return expiry(NO_TIMING);
  const horizon = Math.max(0, (snap.deadline - snap.now) / HOUR);
  if (horizon <= 0) return expiry(NO_TIMING);
  // Copies saved only fall as the arrival slips, so the last hour without a loss is found by halving the interval.
  let lo = 0, hi = horizon;
  if (saved(hi).copies_saved >= base.copies_saved) lo = hi;
  else for (let i = 0; i < 9 && hi - lo > 0.1; i++) { const mid = (lo + hi) / 2; if (saved(mid).copies_saved >= base.copies_saved) lo = mid; else hi = mid; }
  const slack = Math.floor(lo * 12) / 12; // five-minute steps
  const decideBy = snap.now + slack * HOUR;
  const after = saved(slack + 1);
  const lostCopies = Math.max(0, base.copies_saved - after.copies_saved);
  const lostByProduct = base.copies_saved_by_product.map((x) => ({ product_id: x.product_id, copies: Math.max(0, x.copies - (after.copies_saved_by_product.find((y) => y.product_id === x.product_id)?.copies ?? 0)) }));
  const lostEur = lostCopies ? valueOf(lostByProduct) : null;
  const basis = lo >= horizon
    ? "The supply still saves every copy if it is ordered at any time before the deadline."
    : `Ordered by ${fmtTime(decideBy)}, the supply reaches the line in time for all ${fmtQty(base.copies_saved)} copies. One hour later it saves ${fmtQty(after.copies_saved)}.`;
  return expiry({ decide_by: new Date(decideBy).toISOString(), wait_copies_per_hour: lostCopies || null, wait_eur_per_hour: lostEur, basis });
}
