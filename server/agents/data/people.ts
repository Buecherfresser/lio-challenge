import type { Fact } from "../../../shared/api.ts";
import { config } from "../../config.ts";
import { all, json } from "../../db.ts";
import { now } from "../../clock.ts";
import { currentFacts } from "../../facts.ts";
import { factOrder, localDay, sayDate } from "./rows.ts";

// People at Soony as the documents describe them: roles from the organisation chart, approval rules from
// the policies, who stands in when a seat is empty, and by when a supplier should answer. Code only.

export interface RoleInfo { role: string; person: string | null; deputy: string | null; reports_to: string | null; available_from: string | null; responsibility: string[]; fact_ids: number[] }

const newestOf = (rows: Fact[]): Fact | null => (rows.length ? rows.reduce((a, b) => (factOrder(b) > factOrder(a) ? b : a)) : null);
const EMPTY_SEAT = /^(vacant|tbd|tba|n\/?a|open|unknown|none|-+|\?+)$/i;

/** The organisation as the documents describe it right now. */
export function loadRoles(): Map<string, RoleInfo> {
  const byRole = new Map<string, Fact[]>();
  for (const f of currentFacts("object_type = 'role'")) { if (!byRole.has(f.object_id)) byRole.set(f.object_id, []); byRole.get(f.object_id)!.push(f); }
  const out = new Map<string, RoleInfo>();
  for (const [role, facts] of byRole) {
    const pick = (field: string) => newestOf(facts.filter((f) => f.field === field));
    const person = pick("person"), deputy = pick("deputy"), reports = pick("reports_to"), from = pick("available_from");
    out.set(role, {
      role, person: person?.value ?? null, deputy: deputy?.value ?? null, reports_to: reports?.value ?? null, available_from: from?.value ?? null,
      responsibility: facts.filter((f) => f.field === "responsibility").map((f) => f.value),
      fact_ids: [person, deputy, reports, from].filter((f): f is Fact => Boolean(f)).map((f) => f.id),
    });
  }
  return out;
}

export interface ApprovalRule { policy: string; kind: string; role: string; limit_eur: number | null; scope: string; text: string; fact_id: number }
export function loadApprovalRules(): ApprovalRule[] {
  // A policy states many rules, so take every rule of the latest reading of each source.
  const rows = all<Fact & { v: number }>(
    `SELECT f.id, f.object_type, f.object_id, f.field, f.value, f.unit, f.part_id, f.source_path, f.source_version, f.observed_at, f.recorded_at, f.origin, f.confidence, f.quote,
            (SELECT MAX(g.source_version) FROM facts g WHERE g.source_path = f.source_path AND g.object_type = 'policy' AND g.field = 'approval_rule') AS v
     FROM facts f WHERE f.object_type = 'policy' AND f.field = 'approval_rule' ORDER BY f.id`).filter((f) => f.source_version === f.v);
  const out: ApprovalRule[] = [];
  const seen = new Set<string>();
  for (const f of rows) {
    const r = json<{ kind?: string; role?: string; limit_eur?: number | null; scope?: string; text?: string } | null>(f.value, null);
    if (!r?.role || seen.has(`${f.object_id}|${f.value}`)) continue;
    seen.add(`${f.object_id}|${f.value}`);
    out.push({ policy: f.object_id, kind: r.kind ?? "other", role: r.role, limit_eur: typeof r.limit_eur === "number" ? r.limit_eur : null, scope: r.scope ?? "", text: r.text ?? "", fact_id: f.id });
  }
  return out;
}

const sameRole = (a: string, b: string) => a.trim().toLowerCase().replace(/\s+/g, " ") === b.trim().toLowerCase().replace(/\s+/g, " ");
const findRole = (roles: Map<string, RoleInfo>, title: string | null): RoleInfo | null => (title ? ([...roles.values()].find((r) => sameRole(r.role, title)) ?? null) : null);

export interface Assignee { role: string; person: string | null; note: string | null; fact_ids: number[] }

/**
 * Who gets a task for a role today. If the seat is empty or the person has not started yet, the deputy stands in,
 * and without a deputy it goes up the reporting line to the first role that has someone.
 */
export function assigneeFor(roleTitle: string, roles: Map<string, RoleInfo> = loadRoles(), today: string = localDay(now())): Assignee {
  const start = findRole(roles, roleTitle);
  if (!start) return { role: roleTitle, person: null, note: null, fact_ids: [] };
  const present = (r: RoleInfo) => Boolean(r.person && !EMPTY_SEAT.test(r.person.trim()) && (!r.available_from || r.available_from.slice(0, 10) <= today));
  if (present(start)) return { role: start.role, person: start.person, note: null, fact_ids: start.fact_ids };
  const why = start.person && !EMPTY_SEAT.test(start.person.trim()) && start.available_from
    ? `${start.person} only starts as ${start.role} on ${sayDate(start.available_from.slice(0, 10))}`
    : `The role ${start.role} has nobody in it right now`;
  if (start.deputy && !EMPTY_SEAT.test(start.deputy.trim())) return { role: start.role, person: start.deputy, note: `${why}, so this goes to ${start.deputy}, who stands in.`, fact_ids: start.fact_ids };
  const factIds = [...start.fact_ids];
  let cur: RoleInfo | null = start;
  for (let hop = 0; hop < 6 && cur; hop++) {
    const up: RoleInfo | null = findRole(roles, cur.reports_to);
    if (!up || up === cur) break;
    factIds.push(...up.fact_ids);
    if (present(up)) return { role: up.role, person: up.person, note: `${why}, so this goes one level up to ${up.person} (${up.role}).`, fact_ids: [...new Set(factIds)] };
    cur = up;
  }
  return { role: start.role, person: null, note: `${why}, and I found nobody above it on the organisation chart.`, fact_ids: factIds };
}

/** When a supplier should have answered: soon enough to still act before the deadline. Computed here, never by the model. */
export function replyBy(from: Date = now()): string {
  const left = (new Date(config.deadline).getTime() - from.getTime()) / 3_600_000;
  const hours = Math.min(24, Math.max(2, left / 8));
  const t = new Date(from.getTime() + hours * 3_600_000);
  t.setUTCMinutes(0, 0, 0);
  t.setUTCHours(t.getUTCHours() + 1);
  return t.toISOString();
}
