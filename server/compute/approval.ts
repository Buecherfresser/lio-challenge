import type { Approver, Fact } from "../../shared/api.ts";
import { config } from "../config.ts";
import { json } from "../db.ts";
import { fmtDate, fmtQty, toTime } from "./settings.ts";
import { listFacts, loadSnapshot } from "./state.ts";
import type { FactIndex, Snapshot } from "./state.ts";

// Who has to approve an action. Reads the rules of the approval policy and the organisation chart from facts.
// Nothing about the policy is written down here: without those facts the answer is "not read yet".

export type ApprovalKind = "po_value" | "air_freight" | "supplier_release" | "quality_concession" | "dock_slot" | "exception" | "other";
export const APPROVAL_KINDS: ApprovalKind[] = ["po_value", "air_freight", "supplier_release", "quality_concession", "dock_slot", "exception", "other"];

export interface ApprovalQuery {
  kind: ApprovalKind;
  amount?: number | null;       // value of the action
  currency?: string | null;     // of the amount, default EUR
  category?: string | null;     // part category, to pick the responsible lead or buyer
  part_id?: string | null;      // alternative to category
}
export interface ApprovalAnswer { approver: Approver; amount_eur: number | null; fact_ids: number[] }

interface Rule { kind: string; role: string; limit_eur: number | null; scope: string; text: string; policy: string; fact: Fact }
interface Role { title: string; person: string | null; vacant: boolean; deputy: string | null; reports_to: string | null; available_from: string | null; fact_ids: number[] }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const tokens = (s: string) => new Set(norm(s).split(" ").filter((t) => t.length > 2));
const VACANT = /^(vacant|tbd|n\/?a|open|unfilled|none|-|—|\?)?$/i;

function loadRules(snap: Snapshot): Rule[] {
  const rules: Rule[] = [];
  for (const f of listFacts(snap, "policy", "approval_rule")) {
    const o = json<Record<string, unknown> | null>(f.value, null);
    if (!o || typeof o.role !== "string" || !o.role.trim()) continue;
    const limit = typeof o.limit_eur === "number" && Number.isFinite(o.limit_eur) ? o.limit_eur : null;
    rules.push({ kind: String(o.kind ?? "other"), role: o.role.trim(), limit_eur: limit, scope: String(o.scope ?? ""), text: String(o.text ?? ""), policy: f.object_id, fact: f });
  }
  // The same rule read from two versions of the policy: keep the newest per kind, role and scope.
  const newest = new Map<string, Rule>();
  for (const r of rules.sort((a, b) => a.fact.id - b.fact.id)) newest.set(`${r.policy}|${r.kind}|${norm(r.role)}|${r.limit_eur ?? ""}`, r);
  return [...newest.values()];
}

function loadRoles(fx: FactIndex, now: number): Map<string, Role> {
  const titles = new Set(["person", "reports_to", "available_from", "deputy"].flatMap((field) => fx.ofField("role", field).map((f) => f.object_id)));
  const roles = new Map<string, Role>();
  for (const title of titles) {
    const person = fx.latest("role", title, "person"), reports = fx.latest("role", title, "reports_to"), deputy = fx.latest("role", title, "deputy");
    // A start date only counts if it belongs to the person who is in the role now.
    const fromAll = fx.latest("role", title, "available_from");
    const from = fromAll && person && (fromAll.observed_at ?? "") >= (person.observed_at ?? "") ? fromAll : null;
    const name = person?.value.trim() ?? "";
    const vacant = !person || VACANT.test(name);
    roles.set(title, { title, person: vacant ? null : name, vacant, deputy: deputy && !VACANT.test(deputy.value.trim()) ? deputy.value.trim() : null, reports_to: reports?.value.trim() || null, available_from: from && (toTime(from.value) ?? 0) > now ? from.value : null,
      fact_ids: [person, reports, from, deputy].filter((f): f is Fact => !!f).map((f) => f.id) });
  }
  return roles;
}

/** Find the role on the organisation chart that a policy rule means, e.g. "Category Lead" for a part category. */
function resolveRole(name: string, category: string | null, roles: Map<string, Role>): { role: Role | null; candidates: string[] } {
  const want = norm(name);
  const exact = [...roles.values()].filter((r) => norm(r.title) === want);
  if (exact.length === 1) return { role: exact[0], candidates: [] };
  // Titles that contain the rule's role as whole words ("Category Lead" fits every category lead). The part category decides.
  const cands = [...roles.values()].filter((r) => ` ${norm(r.title)} `.includes(` ${want} `));
  if (cands.length === 1) return { role: cands[0], candidates: [] };
  if (cands.length > 1 && category) {
    const cat = tokens(category);
    const scored = cands.map((r) => ({ r, score: [...tokens(r.title)].filter((t) => cat.has(t)).length })).sort((a, b) => b.score - a.score);
    if (scored[0].score > 0 && scored[0].score > (scored[1]?.score ?? 0)) return { role: scored[0].r, candidates: [] };
  }
  return { role: null, candidates: cands.map((r) => r.title) };
}

/** The next role up the reporting line that has a person who can sign today. */
function escalation(role: Role, roles: Map<string, Role>): Role | null {
  const seen = new Set<string>([role.title]);
  let up = role.reports_to;
  while (up) {
    const next = [...roles.values()].find((r) => norm(r.title) === norm(up!));
    if (!next || seen.has(next.title)) return null;
    if (!next.vacant && !next.available_from) return next;
    seen.add(next.title);
    up = next.reports_to;
  }
  return null;
}

const inclusive = (r: Rule) => /up to|at most|not exceeding|≤|<=|or less|including/i.test(`${r.text} ${r.scope}`);

export function approvalFor(q: ApprovalQuery, snap: Snapshot = loadSnapshot()): ApprovalAnswer {
  const { fx } = snap;
  const rules = loadRules(snap);
  const roles = loadRoles(fx, snap.now);
  const category = q.category ?? (q.part_id ? (snap.components.get(q.part_id)?.category ?? null) : null);

  const currency = (q.currency ?? "EUR").toUpperCase();
  const rate = config.fxToEur[currency];
  const amountEur = q.amount === null || q.amount === undefined ? null : rate ? Math.round(q.amount * rate * 100) / 100 : null;
  const fxText = q.amount !== null && q.amount !== undefined && currency !== "EUR"
    ? (rate ? ` ${currency} ${fmtQty(q.amount)} is EUR ${fmtQty(amountEur!)} at 1 ${currency} = ${rate} EUR.` : ` No exchange rate for ${currency} is configured, so the amount could not be compared with the limits.`)
    : "";

  if (!rules.length) {
    return { approver: { role: "unknown", person: null, rule: "The approval policy has not been read yet.", available: false, note: "I cannot name an approver before the policy is read." }, amount_eur: amountEur, fact_ids: [] };
  }

  let pool = rules.filter((r) => r.kind === q.kind);
  let fallback = "";
  if (!pool.length) {
    pool = rules.filter((r) => r.kind === "exception");
    fallback = `The policy has no rule for ${q.kind.replace(/_/g, " ")}, so the rule for exceptions applies. `;
    if (!pool.length) {
      return { approver: { role: "unknown", person: null, rule: `The policy facts on file have no rule for ${q.kind.replace(/_/g, " ")} and none for exceptions.`, available: false, note: null }, amount_eur: amountEur, fact_ids: [] };
    }
  }

  // Pick by value: the lowest limit the amount stays under. Rules without a limit apply above all limits.
  const limited = pool.filter((r) => r.limit_eur !== null).sort((a, b) => a.limit_eur! - b.limit_eur!);
  const open = pool.filter((r) => r.limit_eur === null);
  let chosen: Rule[]; let valueNote = "";
  if (!limited.length) chosen = open;
  else if (amountEur === null) {
    chosen = [limited[0]];
    valueNote = `The cost is not known yet. Up to EUR ${fmtQty(limited[0].limit_eur!)} this is the approver, above it the approval moves up.`;
  } else {
    const hit = limited.find((r) => (inclusive(r) ? amountEur <= r.limit_eur! : amountEur < r.limit_eur!));
    chosen = hit ? [hit] : open.length ? open : [limited[limited.length - 1]];
    if (!hit && !open.length) valueNote = `EUR ${fmtQty(amountEur)} is above the highest limit on file (EUR ${fmtQty(limited[limited.length - 1].limit_eur!)}).`;
  }

  // A rule can name several roles that sign together.
  const signers: { name: string; role: Role | null; candidates: string[] }[] = [];
  for (const r of chosen) {
    const whole = resolveRole(r.role, category, roles);
    const names = whole.role || whole.candidates.length ? [r.role] : r.role.split(/\s+(?:and|und|plus|together with)\s+|\s*[,;+/]\s*/i).map((x) => x.replace(/\b(jointly|the responsible|responsible|the)\b/gi, "").trim()).filter(Boolean);
    for (const name of names) {
      const res = names.length === 1 ? whole : resolveRole(name, category, roles);
      if (!signers.some((s) => (s.role?.title ?? s.name) === (res.role?.title ?? name))) signers.push({ name, ...res });
    }
  }

  const notes: string[] = [];
  if (valueNote) notes.push(valueNote);
  let available = true;
  const people: string[] = [];
  for (const s of signers) {
    if (!s.role) {
      available = false;
      notes.push(s.candidates.length ? `"${s.name}" fits several roles (${s.candidates.join(", ")}) and the part category does not decide it.` : roles.size ? `The role "${s.name}" is not on the organisation chart on file.` : "The organisation chart has not been read yet.");
      continue;
    }
    if (s.role.person) people.push(s.role.person);
    if (s.role.vacant || s.role.available_from) {
      available = false;
      const up = escalation(s.role, roles);
      const why = s.role.vacant ? `The role ${s.role.title} is vacant.` : `${s.role.person} starts as ${s.role.title} on ${fmtDate(s.role.available_from)}.`;
      notes.push(`${why} ${s.role.deputy ? `The deputy is ${s.role.deputy}.` : up ? `${s.role.vacant ? "It" : "Until then it"} goes to ${up.title} (${up.person}).` : "The organisation chart on file names nobody above this role who can sign."}`);
    }
  }

  const ruleText = fallback + chosen.map((r) => `${r.policy}: ${r.text || `${r.role} approves ${r.kind.replace(/_/g, " ")}`}${r.limit_eur !== null ? ` (limit EUR ${fmtQty(r.limit_eur)})` : ""}`).join(" ") + fxText;
  return {
    approver: {
      role: signers.map((s) => s.role?.title ?? s.name).join(" + ") || "unknown",
      person: people.length ? people.join(" + ") : null,
      rule: ruleText.trim(),
      available: available && signers.length > 0,
      note: notes.length ? notes.join(" ") : null,
    },
    amount_eur: amountEur,
    fact_ids: [...new Set([...chosen.map((r) => r.fact.id), ...signers.flatMap((s) => s.role?.fact_ids ?? [])])],
  };
}
