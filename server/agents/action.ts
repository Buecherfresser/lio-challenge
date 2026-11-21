import type { Approver, DecisionCard, Fact, Risk } from "../../shared/api.ts";
import { config } from "../config.ts";
import { all, get, run, tx } from "../db.ts";
import { nowIso } from "../clock.ts";
import { logEvent, newRunId } from "../events.ts";
import { factsById } from "../facts.ts";
import { addUsage, arr, enumT, llmAvailable, nullable, obj, prompt, str, structured, withStyle } from "../llm.ts";
import type { Usage } from "../llm.ts";
import { fmtQty, settings } from "../compute/settings.ts";
import { loadSnapshot } from "../compute/state.ts";
import type { Snapshot } from "../compute/state.ts";
import { simulateAction } from "../compute/simulate.ts";
import { SCENARIO_HELP, normalizeScenario, scenarioSchema } from "../compute/scenario.ts";
import type { Scenario } from "../compute/scenario.ts";
import { APPROVAL_KINDS, approvalFor } from "../compute/approval.ts";
import type { ApprovalKind } from "../compute/approval.ts";
import { factLine, overviewForAgent, partForAgent } from "../compute/context.ts";
import { decisionById, decisionMailId, riskById, riskRows, toRisk } from "../compute/rows.ts";

// The action agent turns a risk into decision cards. This file holds the interface the real agent will implement,
// a mock that is one structured model call per risk, and the code that prices, sizes and routes every proposal.
// Nothing leaves the building from here: mails are stored as drafts.

export interface CostItem {
  label: string;
  quantity_from: "scenario_change" | "fact";
  scenario_change_index: number | null;
  quantity_fact_id: number | null;
  price_from: "fact" | "supplier_price" | "none";
  price_fact_id: number | null;
  price_supplier_id: string | null;
  price_part_id: string | null;
  note: string | null;
}
export interface MailDraft { to: "supplier" | "role"; supplier_id: string | null; role: string | null; language: string; subject: string; body_original: string; body_en: string }
/** What an action agent proposes. No copies, no totals, no approver: code adds those. */
export interface Proposal {
  title: string;
  option: string;
  rationale: string;
  scenario: Scenario;
  cost_items: CostItem[];
  approval_kind: ApprovalKind;
  fact_ids: number[];
  mail: MailDraft;
}
export interface ActionAgent {
  name: DecisionCard["created_by"];
  propose(risk: Risk): Promise<{ proposals: Proposal[]; usage: Usage | null; context?: unknown }>;
}

const proposalSchema = obj({
  options: arr(obj({
    title: str("the action in a few words"),
    option: str("what the company would do, one or two sentences"),
    rationale: str("why it helps and what it depends on"),
    scenario: scenarioSchema,
    cost_items: arr(obj({
      label: str("what is paid for"),
      quantity_from: enumT(["scenario_change", "fact"]),
      scenario_change_index: nullable({ type: "integer", description: "position in this option's scenario changes, starting at 0" }),
      quantity_fact_id: nullable({ type: "integer" }),
      price_from: enumT(["fact", "supplier_price", "none"]),
      price_fact_id: nullable({ type: "integer" }),
      price_supplier_id: nullable(str()),
      price_part_id: nullable(str()),
      note: nullable(str("price conditions that are only in text, e.g. a surcharge")),
    })),
    approval_kind: enumT(APPROVAL_KINDS),
    fact_ids: arr({ type: "integer" }),
    mail: obj({
      to: enumT(["supplier", "role"]), supplier_id: nullable(str()), role: nullable(str("role title from the organisation chart")),
      language: str("ISO 639-1"), subject: str(), body_original: str(), body_en: str(),
    }),
  })),
});

/** Parts a risk touches: its own part and the parts named in its scenario. */
function partsOfRisk(risk: Risk): string[] {
  const sc = normalizeScenario(risk.scenario).scenario;
  return [...new Set([risk.part_id, ...sc.changes.map((c) => c.part_id)].filter((x): x is string => !!x))];
}

function contextFor(risk: Risk, snap: Snapshot) {
  const overview = overviewForAgent(snap);
  const roles = [...new Set(snap.fx.ofField("role", "person").map((f) => f.object_id))].map((title) => ({
    role: title, person: snap.fx.val("role", title, "person"), reports_to: snap.fx.val("role", title, "reports_to"), starts: snap.fx.val("role", title, "available_from") }));
  return {
    now: overview.now, now_iso: overview.now_iso, deadline: overview.deadline, deadline_iso: overview.deadline_iso, shifts: overview.shifts,
    risk: { id: risk.id, title: risk.title, explanation: risk.explanation, probability: risk.probability, scenario: risk.scenario, copies_at_risk: risk.copies_at_risk, copies_by_product: risk.copies_by_product,
      part_id: risk.part_id, supplier_id: risk.supplier_id, facts: factsById(risk.fact_ids).map(factLine) },
    editions: overview.editions,
    parts: partsOfRisk(risk).map((id) => partForAgent(id, snap)),
    other_parts: overview.parts.map((p) => ({ part_id: p.part_id, description: p.description, status: p.status, need: p.need, safe: p.safe, uncertain: p.uncertain, gap: p.gap })),
    routes: snap.routes,
    organisation: roles,
  };
}

/** The mock: one model call per risk that returns up to three options in the proposal format. */
export const mockActionAgent: ActionAgent = {
  name: "mock",
  async propose(risk) {
    const context = contextFor(risk, loadSnapshot());
    const res = await structured<{ options: Proposal[] }>({
      model: config.openai.modelAgent,
      system: withStyle(prompt("action_agent.md").replace("{{SCENARIO_HELP}}", SCENARIO_HELP)),
      user: `Propose one to ${settings.maxOptionsPerRisk} options for this risk.\n\n${JSON.stringify(context)}`,
      schemaName: "decision_options", schema: proposalSchema,
    });
    return { proposals: (res.data.options ?? []).slice(0, settings.maxOptionsPerRisk), usage: res.usage, context: { parts: partsOfRisk(risk) } };
  },
};

interface Cost { cost_eur: number | null; cost_basis: string; fact_ids: number[] }

/** Cost of a proposal from its cost items. Every number is read from the scenario, a fact or a price list row. */
export function priceProposal(p: Proposal, snap: Snapshot = loadSnapshot()): Cost {
  if (!p.cost_items.length) return { cost_eur: 0, cost_basis: "This option has nothing to buy or ship.", fact_ids: [] };
  const lines: string[] = [], factIds: number[] = [];
  let total = 0, open = false;
  const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 4 });
  for (const item of p.cost_items) {
    const note = item.note?.trim() ? ` Note: ${item.note.trim().replace(/[.\s]+$/, "")}.` : "";
    // quantity
    let qty: number | null = null, qtyFrom = "";
    if (item.quantity_from === "scenario_change" && item.scenario_change_index !== null) {
      qty = p.scenario.changes[item.scenario_change_index]?.quantity ?? null;
    } else if (item.quantity_from === "fact" && item.quantity_fact_id !== null) {
      const f = factsById([item.quantity_fact_id])[0];
      if (f && Number.isFinite(Number(f.value))) { qty = Number(f.value); qtyFrom = ` (${f.source_path})`; factIds.push(f.id); }
    }
    // unit price
    let price: number | null = null, currency: string | null = null, priceFrom = "";
    if (item.price_from === "fact" && item.price_fact_id !== null) {
      const f: Fact | undefined = factsById([item.price_fact_id])[0];
      if (f && /price/.test(f.field) && Number.isFinite(Number(f.value)) && Number(f.value) > 0) {
        price = Number(f.value); currency = (f.unit ?? "EUR").toUpperCase(); priceFrom = `${f.object_type === "po_line" ? `order ${f.object_id}` : f.source_path}`; factIds.push(f.id);
      }
    } else if (item.price_from === "supplier_price") {
      const row = snap.supplierParts.find((r) => r.supplier_id === item.price_supplier_id && r.part_id === item.price_part_id);
      if (row && row.unit_price !== null && row.unit_price > 0) { price = row.unit_price; currency = (row.currency ?? "EUR").toUpperCase(); priceFrom = `price list of ${snap.suppliers.get(row.supplier_id)?.name ?? row.supplier_id} for ${row.part_id}`; }
    }
    const rate = currency ? config.fxToEur[currency] : undefined;
    if (qty === null || price === null || !currency || !rate) {
      open = true;
      const why = qty === null ? "no quantity on file" : price === null ? "no price on file" : `no exchange rate for ${currency}`;
      lines.push(`${item.label}: needs a quote (${why}).${note}`);
      continue;
    }
    const amount = qty * price, eur = amount * rate;
    total += eur;
    lines.push(`${item.label}: ${fmtQty(qty)}${qtyFrom} x ${currency} ${money(price)} (${priceFrom}) = ${currency} ${money(Math.round(amount * 100) / 100)}${currency === "EUR" ? "" : ` = EUR ${money(Math.round(eur * 100) / 100)} at 1 ${currency} = ${rate} EUR`}.${note}`);
  }
  const sum = Math.round(total * 100) / 100;
  return open
    ? { cost_eur: null, cost_basis: `Needs a quote. ${lines.join(" ")}${total > 0 ? ` Priced so far: EUR ${money(sum)}.` : ""}`, fact_ids: factIds }
    : { cost_eur: sum, cost_basis: lines.join(" "), fact_ids: factIds };
}

/** Where the draft goes: the supplier's contact, or the person in a role. */
function addressee(mail: MailDraft, snap: Snapshot): { ok: true; thread_id: string; to_addr: string; supplier_id: string | null; person: string | null; name: string } | { ok: false; reason: string } {
  if (mail.to === "supplier") {
    const s = mail.supplier_id ? snap.suppliers.get(mail.supplier_id) : undefined;
    if (!s) return { ok: false, reason: `the mail names a supplier that is not on file (${mail.supplier_id})` };
    return { ok: true, thread_id: `supplier:${s.supplier_id}`, to_addr: snap.fx.val("supplier", s.supplier_id, "contact_email") ?? s.contact_email ?? "", supplier_id: s.supplier_id, person: null, name: s.name ?? s.supplier_id };
  }
  const title = mail.role?.trim();
  if (!title) return { ok: false, reason: "the mail names no role" };
  const known = [...new Set(snap.fx.ofField("role", "person").map((f) => f.object_id))].find((t) => t.toLowerCase() === title.toLowerCase());
  const person = known ? snap.fx.val("role", known, "person") : null;
  const name = person && !/^(vacant|tbd|open)?$/i.test(person.trim()) ? person.trim() : (known ?? title);
  // The organisation chart holds no mail addresses, so a mail to a colleague has no recipient address yet.
  return { ok: true, thread_id: `person:${name}`, to_addr: "", supplier_id: null, person: name, name };
}

/** Size, price and route one proposal and store it as a decision card with its mail draft. */
export function storeProposal(risk: Risk, p: Proposal, createdBy: DecisionCard["created_by"], runId: string): DecisionCard | null {
  const snap = loadSnapshot();
  const reject = (reason: string) => {
    logEvent({ actor: "action_agent", action: "decision.rejected_proposal", run_id: runId, object: { type: "risk", id: String(risk.id), label: risk.title },
      summary: `I dropped the proposed option "${String(p.title).slice(0, 120)}" for the risk "${risk.title}": ${reason}.`, input: p, output: { reason } });
    return null;
  };
  if (!p.title?.trim() || !p.option?.trim()) return reject("it has no title or no description");
  const scenario = normalizeScenario(p.scenario).scenario;
  const sim = simulateAction(risk.scenario, scenario, snap);
  if (!sim.valid) return reject(`the code cannot compute its effect (${sim.problems.join(" ")})`);
  const factIds = [...new Set((p.fact_ids ?? []).filter((x) => Number.isInteger(x)))];
  const known = new Set(factsById(factIds).map((f) => f.id));
  const cited = factIds.filter((id) => known.has(id));
  const to = addressee(p.mail, snap);
  if (!to.ok) return reject(to.reason);

  const cost = priceProposal({ ...p, scenario }, snap);
  const partId = risk.part_id ?? scenario.changes.find((c) => c.part_id)?.part_id ?? null;
  const approval = approvalFor({ kind: p.approval_kind, amount: cost.cost_eur, currency: "EUR", part_id: partId }, snap);
  const approver: Approver = approval.approver;

  const id = tx(() => {
    const decisionId = run(
      `INSERT INTO decisions (risk_id, status, title, option, rationale, copies_saved, copies_by_product, cost_eur, cost_basis, approver, scenario, created_by, created_at) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      risk.id, p.title.trim(), p.option.trim(), p.rationale?.trim() ?? "", sim.copies_saved, JSON.stringify(sim.copies_saved_by_product), cost.cost_eur, cost.cost_basis, JSON.stringify(approver), JSON.stringify(scenario), createdBy, nowIso()).lastId;
    const messageId = run(
      `INSERT INTO messages (thread_id, direction, status, from_addr, to_addr, subject, language, body_original, body_en, supplier_id, person, created_by, issue_ids, decision_id, created_at)
       VALUES (?, 'out', 'draft', ?, ?, ?, ?, ?, ?, ?, ?, 'action_agent', '[]', ?, ?)`,
      to.thread_id, config.mail.from, to.to_addr, p.mail.subject.trim(), (p.mail.language || "en").toLowerCase().slice(0, 2), p.mail.body_original, p.mail.body_en || p.mail.body_original, to.supplier_id, to.person, decisionId, nowIso()).lastId;
    run("UPDATE decisions SET mail_message_id = ? WHERE id = ?", messageId, decisionId);
    return decisionId;
  });

  const allFacts = [...new Set([...cited, ...cost.fact_ids, ...approval.fact_ids])];
  logEvent({ actor: "action_agent", action: "decision.proposed", run_id: runId, object: { type: "decision", id: String(id), label: p.title.trim() }, fact_ids: allFacts,
    summary: `I proposed "${p.title.trim()}" for the risk "${risk.title}": it saves ${fmtQty(sim.copies_saved)} copies, ${cost.cost_eur === null ? "the cost needs a quote" : `costs EUR ${fmtQty(cost.cost_eur)}`}, and ${approver.role}${approver.person ? ` (${approver.person})` : ""} approves it.`,
    input: { risk_id: risk.id, proposal: p }, output: { decision_id: id, copies_saved: sim.copies_saved, copies_by_product: sim.copies_saved_by_product, with_action: sim.with, without_action: sim.without, cost, approver } });
  logEvent({ actor: "action_agent", action: "mail.drafted", run_id: runId, object: { type: "decision", id: String(id), label: p.title.trim() },
    summary: `I drafted a mail to ${to.name} for the option "${p.title.trim()}". It waits as a draft until the decision is approved.`, output: { thread_id: to.thread_id, subject: p.mail.subject, language: p.mail.language } });
  return decisionById(id);
}

export interface ActionRunResult { run_id: string; ran_model: boolean; reason: string; risks: number; decisions: number }

let running = false;
export const actionAgentRunning = () => running;
let agent: ActionAgent = mockActionAgent;
/** Swap the mock for the real agent. */
export const setActionAgent = (a: ActionAgent) => { agent = a; };

/** Open risks that have no decision card yet get one to three. */
export async function runActionAgent(opts: { runId?: string; riskId?: number; force?: boolean } = {}): Promise<ActionRunResult> {
  const runId = opts.runId ?? newRunId("action");
  if (running) return { run_id: runId, ran_model: false, reason: "already running", risks: 0, decisions: 0 };
  running = true;
  try {
    const todo = riskRows("status = 'open'").filter((r) => (opts.riskId ? r.id === opts.riskId : true))
      .filter((r) => opts.force || !get("SELECT 1 AS x FROM decisions WHERE risk_id = ? LIMIT 1", r.id));
    if (!todo.length) return { run_id: runId, ran_model: false, reason: "no open risk without a decision card", risks: 0, decisions: 0 };
    if (!llmAvailable()) {
      // Say it once per set of waiting risks, not on every cycle.
      const waiting = todo.map((r) => r.id).join(",");
      const last = all<{ output: string | null }>("SELECT output FROM events WHERE actor = 'action_agent' AND action = 'action_agent.skipped' ORDER BY id DESC LIMIT 1")[0];
      if (!last?.output?.includes(`"waiting":"${waiting}"`)) {
        logEvent({ actor: "action_agent", action: "action_agent.skipped", run_id: runId, summary: `I did not propose options for ${todo.length} open risk${todo.length === 1 ? "" : "s"} because no OpenAI key is set.`, output: { waiting } });
      }
      return { run_id: runId, ran_model: false, reason: "no model available", risks: todo.length, decisions: 0 };
    }
    let decisions = 0;
    let usage: Usage | null = null;
    for (const row of todo) {
      const risk = toRisk(row, { trace: false });
      try {
        const res = await agent.propose(risk);
        if (res.usage) usage = usage ? addUsage(usage, res.usage) : res.usage;
        const stored = res.proposals.map((p) => storeProposal(risk, p, agent.name, runId)).filter((d): d is DecisionCard => !!d);
        decisions += stored.length;
        logEvent({ actor: "action_agent", action: "action_agent.proposed", run_id: runId, object: { type: "risk", id: String(risk.id), label: risk.title },
          summary: `I worked out ${stored.length} option${stored.length === 1 ? "" : "s"} for the risk "${risk.title}"${res.proposals.length > stored.length ? ` and dropped ${res.proposals.length - stored.length} that the code could not compute` : ""}.`,
          input: { risk_id: risk.id, context: res.context ?? null }, output: { decision_ids: stored.map((d) => d.id), titles: stored.map((d) => d.title) }, fact_ids: risk.fact_ids,
          model: res.usage?.model ?? null, tokens_in: res.usage?.tokens_in ?? null, tokens_out: res.usage?.tokens_out ?? null, cost_usd: res.usage?.cost_usd ?? null });
      } catch (e) {
        logEvent({ actor: "action_agent", action: "action_agent.failed", run_id: runId, object: { type: "risk", id: String(risk.id), label: risk.title }, summary: `I could not work out options for the risk "${risk.title}": ${(e as Error).message}` });
      }
    }
    return { run_id: runId, ran_model: true, reason: "open risks without a decision card", risks: todo.length, decisions };
  } finally {
    running = false;
  }
}

/** Approve or reject a decision card. Only the status changes; a mail is sent only if SEND_ON_APPROVAL is on. */
export async function decide(id: number, verdict: "approved" | "rejected", by: string, reason?: string): Promise<DecisionCard | null> {
  const before = decisionById(id);
  if (!before) return null;
  if (before.status !== "pending") return before;
  run("UPDATE decisions SET status = ?, decided_at = ?, decided_by = ?, decision_reason = ? WHERE id = ?", verdict, nowIso(), by, reason ?? null, id);
  const mailId = decisionMailId(id);
  const risk = riskById(before.risk_id);
  let sent = false, sendError: string | null = null;
  if (verdict === "approved") {
    if (risk?.status === "open") run("UPDATE risks SET status = 'mitigated', updated_at = ? WHERE id = ?", nowIso(), risk.id);
    if (mailId) {
      if (config.mail.sendOnApproval) {
        try {
          // The mail module is written separately. Load it only when it is needed.
          const path = "../mail/transport.ts";
          const mod = (await import(path)) as { sendMessage?: (messageId: number, by: string) => unknown };
          if (!mod.sendMessage) throw new Error("the mail module has no sendMessage");
          await mod.sendMessage(mailId, by);
          sent = true;
        } catch (e) { sendError = (e as Error).message; }
      }
      // Not sent from here: the draft moves to the mails that wait for a click.
      if (!sent) run("UPDATE messages SET status = 'needs_approval' WHERE id = ? AND status = 'draft'", mailId);
    }
  } else if (mailId) {
    run("UPDATE messages SET status = 'rejected' WHERE id = ? AND status = 'draft'", mailId);
  }
  logEvent({ actor: "human", action: `decision.${verdict}`, object: { type: "decision", id: String(id), label: before.title },
    summary: verdict === "approved"
      ? `I approved "${before.title}"${sent ? " and its mail went out" : mailId ? ", and its mail now waits to be sent" : ""}${sendError ? ` (sending failed: ${sendError})` : ""}.`
      : `I rejected "${before.title}"${reason ? `: ${reason}` : ""}.`,
    input: { by, reason: reason ?? null }, output: { decision_id: id, risk_id: before.risk_id, copies_saved: before.copies_saved, cost_eur: before.cost_eur, mail_message_id: mailId, mail_sent: sent, send_error: sendError },
    fact_ids: before.risk?.fact_ids ?? [] });
  return decisionById(id);
}
