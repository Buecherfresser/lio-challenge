import type { Approver, DecisionCard, DecisionReport, Issue, Message, ObjectRef, Risk, Signature, ToolCallTrace } from "../../shared/api.ts";
import { all, get, json } from "../db.ts";
import { factsById } from "../facts.ts";

// Database rows -> the shapes of shared/api.ts.

interface IssueDb {
  id: number; type: Issue["type"]; status: Issue["status"]; title: string; detail: string; expected: string | null; actual: string | null;
  object_type: string; object_id: string; part_id: string | null; supplier_id: string | null; addressee: Issue["addressee"]; assignee_role: string | null;
  question: string | null; fact_ids: string; created_at: string; updated_at: string;
}
export const toIssue = (r: IssueDb): Issue => ({
  id: r.id, type: r.type, status: r.status, title: r.title, detail: r.detail, expected: r.expected, actual: r.actual,
  object: { type: r.object_type as ObjectRef["type"], id: r.object_id }, part_id: r.part_id, supplier_id: r.supplier_id, addressee: r.addressee, assignee_role: r.assignee_role,
  question: r.question, fact_ids: json<number[]>(r.fact_ids, []), created_at: r.created_at, updated_at: r.updated_at,
});

/** Issues that are not resolved yet. */
export const openIssues = (): Issue[] => all<IssueDb>("SELECT * FROM issues WHERE status != 'resolved' ORDER BY id DESC").map(toIssue);

/** Issues about a part: raised for the part itself or for one of its orders, shipments or lots. */
export function issuesFor(partId: string, refs: { type: string; id: string }[], includeResolved = true): Issue[] {
  const cond = ["part_id = ?", ...refs.map(() => "(object_type = ? AND object_id = ?)")].join(" OR ");
  return all<IssueDb>(`SELECT * FROM issues WHERE (${cond})${includeResolved ? "" : " AND status != 'resolved'"} ORDER BY id DESC`, partId, ...refs.flatMap((r) => [r.type, r.id])).map(toIssue);
}

export interface RiskDb {
  id: number; dedupe_key: string; status: Risk["status"]; part_id: string | null; product_id: string | null; supplier_id: string | null; title: string; explanation: string;
  probability: number; copies_at_risk: number; copies_by_product: string; scenario: string; fact_ids: string; tool_calls: string; run_id: string | null; created_at: string; updated_at: string;
}
export function toRisk(r: RiskDb, opts: { facts?: boolean; trace?: boolean } = {}): Risk {
  const fact_ids = json<number[]>(r.fact_ids, []);
  return {
    id: r.id, status: r.status, part_id: r.part_id, product_id: r.product_id, supplier_id: r.supplier_id, title: r.title, explanation: r.explanation,
    probability: r.probability, copies_at_risk: r.copies_at_risk, copies_by_product: json<Risk["copies_by_product"]>(r.copies_by_product, []),
    scenario: json<unknown>(r.scenario, {}), fact_ids, ...(opts.facts ? { facts: factsById(fact_ids) } : {}),
    tool_calls: opts.trace === false ? [] : json<ToolCallTrace[]>(r.tool_calls, []), created_at: r.created_at,
  };
}
export const riskRows = (where = "1 = 1", ...params: unknown[]): RiskDb[] => all<RiskDb>(`SELECT * FROM risks WHERE ${where} ORDER BY copies_at_risk * probability DESC, id DESC`, ...params);
export const riskById = (id: number): RiskDb | undefined => get<RiskDb>("SELECT * FROM risks WHERE id = ?", id);

interface MessageDb {
  id: number; thread_id: string; direction: Message["direction"]; status: Message["status"]; from_addr: string; to_addr: string; subject: string; language: string;
  body_original: string; body_en: string; supplier_id: string | null; person: string | null; created_by: Message["created_by"]; issue_ids: string; decision_id: number | null;
  created_at: string; sent_at: string | null;
}
export const toMessage = (r: MessageDb): Message => ({
  id: r.id, thread_id: r.thread_id, direction: r.direction, status: r.status, from_addr: r.from_addr, to_addr: r.to_addr, subject: r.subject, language: r.language,
  body_original: r.body_original, body_en: r.body_en, supplier_id: r.supplier_id, person: r.person, created_by: r.created_by, issue_ids: json<number[]>(r.issue_ids, []),
  decision_id: r.decision_id, created_at: r.created_at, sent_at: r.sent_at,
});
export const messageById = (id: number): Message | null => { const r = get<MessageDb>("SELECT * FROM messages WHERE id = ?", id); return r ? toMessage(r) : null; };

interface DecisionDb {
  id: number; risk_id: number; status: DecisionCard["status"]; title: string; option: string; rationale: string; copies_saved: number; copies_by_product: string;
  cost_eur: number | null; cost_basis: string; approver: string; mail_message_id: number | null; created_by: DecisionCard["created_by"]; created_at: string; decided_at: string | null; decided_by: string | null;
  decision_reason: string | null; approval_kind: string; value_eur: number | null; decide_by: string | null; wait_copies_per_hour: number | null; wait_eur_per_hour: number | null; timing_basis: string | null;
  report: string; signatures: string; stage: DecisionCard["stage"]; auto: number; scenario: string; check_at: string | null; closed_reason: string | null;
}
const NO_APPROVER: Approver = { role: "unknown", person: null, rule: "No approver was stored with this decision.", available: false, note: null };
/** Value minus cost. An option whose cost needs a quote counts with its value alone when options are ranked. */
const worth = (r: DecisionDb) => (r.value_eur ?? 0) - (r.cost_eur ?? 0);
/** Per risk the pending option that is worth most, and on a tie the one that saves more copies. Only that one is recommended. */
function recommendedIds(): Set<number> {
  const best = new Map<number, DecisionDb>();
  for (const r of all<DecisionDb>("SELECT * FROM decisions WHERE status = 'pending'")) {
    const b = best.get(r.risk_id);
    if (!b || worth(r) > worth(b) || (worth(r) === worth(b) && r.copies_saved > b.copies_saved)) best.set(r.risk_id, r);
  }
  return new Set([...best.values()].filter((r) => r.copies_saved > 0).map((r) => r.id));
}
export function toDecision(r: DecisionDb, recommended: Set<number> = recommendedIds()): DecisionCard {
  const risk = riskById(r.risk_id);
  const report = json<DecisionReport | null>(r.report, null);
  return {
    id: r.id, risk_id: r.risk_id, status: r.status, stage: r.stage ?? "proposed", title: r.title, option: r.option, rationale: r.rationale, copies_saved: r.copies_saved,
    copies_by_product: json<DecisionCard["copies_by_product"]>(r.copies_by_product, []), value_eur: r.value_eur, cost_eur: r.cost_eur, cost_basis: r.cost_basis,
    net_eur: r.value_eur !== null && r.cost_eur !== null ? Math.round((r.value_eur - r.cost_eur) * 100) / 100 : null,
    decide_by: r.decide_by, wait_copies_per_hour: r.wait_copies_per_hour, wait_eur_per_hour: r.wait_eur_per_hour, timing_basis: r.timing_basis,
    recommended: r.status === "pending" && recommended.has(r.id), approval_kind: r.approval_kind ?? "other",
    approver: json<Approver>(r.approver, NO_APPROVER), signatures: json<Signature[]>(r.signatures, []), auto: Boolean(r.auto),
    report: report && Array.isArray(report.research) ? report : null,
    ...(report && Array.isArray(report.research) ? { report_facts: factsById([...new Set([...report.research, ...(report.agreed ?? [])].flatMap((l) => l.fact_ids ?? []))]) } : {}),
    mail_draft: r.mail_message_id ? messageById(r.mail_message_id) : null,
    ...(risk ? { risk: toRisk(risk, { facts: true, trace: false }) } : {}),
    created_by: r.created_by, created_at: r.created_at, decided_at: r.decided_at, decided_by: r.decided_by, decision_reason: r.decision_reason,
  };
}
/** Pending cards come in the order a person should take them: the nearest deadline first, then the most valuable. */
export function decisions(status?: string): DecisionCard[] {
  const rec = recommendedIds();
  const rows = status && status !== "all"
    ? all<DecisionDb>("SELECT * FROM decisions WHERE status = ? ORDER BY CASE WHEN decide_by IS NULL THEN 1 ELSE 0 END, decide_by, IFNULL(value_eur, 0) DESC, copies_saved DESC, id DESC", status)
    : all<DecisionDb>("SELECT * FROM decisions ORDER BY id DESC");
  return rows.map((r) => toDecision(r, rec));
}
export const decisionById = (id: number): DecisionCard | null => { const r = get<DecisionDb>("SELECT * FROM decisions WHERE id = ?", id); return r ? toDecision(r) : null; };
export const decisionRows = (where = "1 = 1", ...params: unknown[]): DecisionDb[] => all<DecisionDb>(`SELECT * FROM decisions WHERE ${where} ORDER BY id`, ...params);
export type { DecisionDb };
export const decisionMailId = (id: number): number | null => get<{ mail_message_id: number | null }>("SELECT mail_message_id FROM decisions WHERE id = ?", id)?.mail_message_id ?? null;
