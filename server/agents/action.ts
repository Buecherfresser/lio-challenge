import type { AgentWork, DecisionCard, DecisionReport, Fact, ReportLine, Risk, Signature, ToolCallTrace } from "../../shared/api.ts";
import { config } from "../config.ts";
import { all, get, json, kv, run, tx } from "../db.ts";
import { now, nowIso } from "../clock.ts";
import { logEvent, newRunId } from "../events.ts";
import { factsById } from "../facts.ts";
import { arr, enumT, llmAvailable, nullable, obj, prompt, runAgent, str, withStyle } from "../llm.ts";
import type { Tool, Usage } from "../llm.ts";
import { fmtQty, fmtTime, settings } from "../compute/settings.ts";
import { loadSnapshot, planChanged } from "../compute/state.ts";
import type { Snapshot } from "../compute/state.ts";
import { simulateAction } from "../compute/simulate.ts";
import { SCENARIO_HELP, normalizeScenario, scenarioSchema, scenarioSignature } from "../compute/scenario.ts";
import type { Scenario } from "../compute/scenario.ts";
import { APPROVAL_KINDS, approvalFor } from "../compute/approval.ts";
import type { ApprovalKind } from "../compute/approval.ts";
import { autonomyLimit, timingOf, valueOf, valuePerCopy } from "../compute/value.ts";
import { factLine, overviewForAgent, partForAgent } from "../compute/context.ts";
import { decisionById, decisionMailId, decisionRows, riskById, riskRows, toRisk } from "../compute/rows.ts";
import type { RiskDb } from "../compute/rows.ts";
import { logger, readTools } from "./tools.ts";
import { TOPICS, askQuestion, contactCounts, flushQuestions, questionSignature, questionsForAgent, refreshQuestions, threadForAgent, waitingOn } from "./questions.ts";
import type { AskInput } from "./questions.ts";
import { assigneeFor, loadRoles } from "./data/people.ts";
import { notifyNextSigner } from "../mail/notify.ts";

// The action agent. One agent works through one risk: it finds the way out, asks what is missing, lets the code check
// whether it pays, and hands a decision with a short report to the right person. Then it follows through.
//
// What it may do on its own is decided by the tool it calls, not by its wording:
//   ask               a question to a supplier or a colleague. Leaves without approval, collected into one mail per recipient.
//   propose_decision  anything that binds the company. A person approves it, or the code does when the cost is below the
//                     limit the company set (AUTONOMY_LIMIT_EUR, changeable while the app runs).
// The model thinks and writes. Copies, value, cost, deadline and approver always come from code.

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
/** What the agent proposes. No copies, no totals, no deadline, no approver: code adds those. */
export interface Proposal {
  title: string;
  option: string;
  rationale: string;
  scenario: Scenario;
  expires_at: string | null;
  cost_items: CostItem[];
  approval_kind: ApprovalKind;
  fact_ids: number[];
  research: ReportLine[];
  problem: string;
  agreed: ReportLine[];
  next_steps: string[];
  ruled_out: { option: string; reason: string }[];
  mail: MailDraft;
}

const lineSchema = obj({ text: str("one sentence"), fact_ids: arr({ type: "integer" }) });
const proposalSchema = obj({
  title: str("the action in a few words, starting with a verb"),
  option: str("what the company would do, one or two sentences"),
  rationale: str("why it helps and what it depends on"),
  scenario: scenarioSchema,
  expires_at: nullable(str("ISO time when the offer behind the option runs out, if a source states it")),
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
  research: arr(lineSchema),
  problem: str("what is wrong and what it means for the launch, two or three sentences, no copies and no money"),
  agreed: arr(lineSchema),
  next_steps: arr(str("one step in the first person")),
  ruled_out: arr(obj({ option: str(), reason: str("one sentence") })),
  mail: obj({
    to: enumT(["supplier", "role"]), supplier_id: nullable(str()), role: nullable(str("role title from the organisation chart")),
    language: str("ISO 639-1"), subject: str(), body_original: str(), body_en: str(),
  }),
});

interface Cost { cost_eur: number | null; cost_basis: string; fact_ids: number[] }

/** Cost of a proposal from its cost items. Every number is read from the scenario, a fact or a price list row. */
export function priceProposal(p: Pick<Proposal, "cost_items" | "scenario">, snap: Snapshot = loadSnapshot()): Cost {
  if (!p.cost_items?.length) return { cost_eur: 0, cost_basis: "This option has nothing to buy or ship.", fact_ids: [] };
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

/** Where the mail goes: the supplier's contact, or the person in a role. */
function addressee(mail: MailDraft, snap: Snapshot): { ok: true; thread_id: string; to_addr: string; supplier_id: string | null; role: string | null; person: string | null; name: string } | { ok: false; reason: string } {
  if (mail.to === "supplier") {
    const s = mail.supplier_id ? snap.suppliers.get(mail.supplier_id) : undefined;
    if (!s) return { ok: false, reason: `the mail names a supplier that is not on file (${mail.supplier_id})` };
    return { ok: true, thread_id: `supplier:${s.supplier_id}`, to_addr: snap.fx.val("supplier", s.supplier_id, "contact_email") ?? s.contact_email ?? "", supplier_id: s.supplier_id, role: null, person: null, name: s.name ?? s.supplier_id };
  }
  const title = mail.role?.trim();
  if (!title) return { ok: false, reason: "the mail names no role" };
  const roles = loadRoles();
  const known = [...roles.keys()].find((t) => t.toLowerCase() === title.toLowerCase());
  if (!known) return { ok: false, reason: `the mail names a role that is not on the organisation chart (${title}). Use one of: ${[...roles.keys()].join(", ") || "none on file"}` };
  // If the seat is empty, the deputy or the next one up the line gets it.
  const who = assigneeFor(known, roles);
  const name = who.person ?? who.role;
  // The organisation chart holds no mail addresses. A mail to a colleague is delivered as a task in the dashboard.
  return { ok: true, thread_id: `person:${name}`, to_addr: "", supplier_id: null, role: who.role, person: name, name };
}

const cleanLines = (lines: ReportLine[] | undefined, known: (ids: number[]) => number[]): ReportLine[] =>
  (Array.isArray(lines) ? lines : []).filter((l) => l?.text?.trim()).slice(0, 8).map((l) => ({ text: l.text.trim(), fact_ids: known(Array.isArray(l.fact_ids) ? l.fact_ids : []) }));

/** Size, price, time and route one proposal, and store it as a decision card with its mail. Returns what goes back to the agent. */
export async function storeProposal(risk: Risk, p: Proposal, runId: string): Promise<{ accepted: boolean; reason?: string; decision_id?: number; copies_saved?: number; value_eur?: number | null; cost_eur?: number | null; decide_by?: string | null; approver?: string; carried_out_without_approval?: boolean }> {
  const snap = loadSnapshot();
  const reject = (reason: string) => {
    logEvent({ actor: "action_agent", action: "decision.rejected_proposal", run_id: runId, object: { type: "risk", id: String(risk.id), label: risk.title },
      summary: `I sent my own option "${String(p.title).slice(0, 120)}" back for rework: ${reason}`, input: p, output: { reason } });
    return { accepted: false, reason };
  };
  if (!p.title?.trim() || !p.option?.trim()) return reject("It has no title or no description.");
  if (!p.problem?.trim()) return reject("The report has no problem statement.");
  if (!Array.isArray(p.research) || !p.research.some((l) => l?.text?.trim())) return reject("The report does not say what you looked at. Give two to five research lines with fact ids.");
  if (!Array.isArray(p.next_steps) || !p.next_steps.some((x) => x?.trim())) return reject("The report does not say what happens after approval.");
  const scenario = normalizeScenario(p.scenario).scenario;
  const sim = simulateAction(risk.scenario, scenario, snap);
  if (!sim.valid) return reject(`The code cannot compute its effect. ${sim.problems.join(" ")}`);
  const sig = scenarioSignature(scenario);
  const twin = decisionRows("risk_id = ? AND status IN ('pending', 'approved')", risk.id).find((d) => scenarioSignature(normalizeScenario(json<unknown>(d.scenario, {})).scenario) === sig);
  if (twin) return reject(`This is the same option as decision ${twin.id} ("${twin.title}"), which is ${twin.status}. Withdraw that one first if the facts changed.`);
  const pending = decisionRows("risk_id = ? AND status = 'pending'", risk.id).length;
  if (pending >= settings.maxOptionsPerRisk) return reject(`${pending} options for this risk already wait for a decision. Withdraw one before you add another.`);
  if (p.expires_at && Number.isNaN(new Date(p.expires_at).getTime())) return reject(`expires_at is not a time: "${p.expires_at}".`);

  const exists = (ids: number[]) => { const uniq = [...new Set(ids.filter((x) => Number.isInteger(x)))]; const found = new Set(factsById(uniq).map((f) => f.id)); return uniq.filter((id) => found.has(id)); };
  const cited = exists(p.fact_ids ?? []);
  const to = addressee(p.mail, snap);
  if (!to.ok) return reject(`${to.reason}.`);
  if (!p.mail.subject?.trim() || !p.mail.body_original?.trim()) return reject("The mail has no subject or no text.");

  const cost = priceProposal({ cost_items: p.cost_items ?? [], scenario }, snap);
  const partId = risk.part_id ?? scenario.changes.find((c) => c.part_id)?.part_id ?? null;
  const approval = approvalFor({ kind: p.approval_kind, amount: cost.cost_eur, currency: "EUR", part_id: partId }, snap);
  const value = valueOf(sim.copies_saved_by_product);
  const timing = timingOf(risk.scenario, scenario, { expiresAt: p.expires_at, snap });
  const signatures: Signature[] = (approval.signers.length ? approval.signers : [{ role: approval.approver.role, person: approval.approver.person, stands_in_for: null }])
    .map((s) => ({ role: s.role, person: s.person, stands_in_for: s.stands_in_for, signed_by: null, signed_at: null }));
  const report: DecisionReport = {
    research: cleanLines(p.research, exists), problem: p.problem.trim(), agreed: cleanLines(p.agreed, exists),
    next_steps: p.next_steps.filter((x) => x?.trim()).slice(0, 6).map((x) => x.trim()),
    ruled_out: (Array.isArray(p.ruled_out) ? p.ruled_out : []).filter((x) => x?.option?.trim() && x?.reason?.trim()).slice(0, 5).map((x) => ({ option: x.option.trim(), reason: x.reason.trim() })),
    contact: { with: to.supplier_id ? to.name : null, ...contactCounts(risk.id, to.supplier_id) },
  };

  const id = tx(() => {
    const decisionId = run(
      `INSERT INTO decisions (risk_id, status, stage, title, option, rationale, copies_saved, copies_by_product, cost_eur, cost_basis, approver, scenario, created_by, created_at,
         approval_kind, value_eur, decide_by, wait_copies_per_hour, wait_eur_per_hour, timing_basis, expires_at, report, signatures)
       VALUES (?, 'pending', 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      risk.id, p.title.trim(), p.option.trim(), p.rationale?.trim() ?? "", sim.copies_saved, JSON.stringify(sim.copies_saved_by_product), cost.cost_eur, cost.cost_basis, JSON.stringify(approval.approver), JSON.stringify(scenario), nowIso(),
      p.approval_kind, value, timing.decide_by, timing.wait_copies_per_hour, timing.wait_eur_per_hour, timing.basis, p.expires_at ?? null, JSON.stringify(report), JSON.stringify(signatures)).lastId;
    const messageId = run(
      `INSERT INTO messages (thread_id, direction, status, from_addr, to_addr, subject, language, body_original, body_en, supplier_id, person, created_by, issue_ids, decision_id, created_at)
       VALUES (?, 'out', 'draft', ?, ?, ?, ?, ?, ?, ?, ?, 'action_agent', '[]', ?, ?)`,
      to.thread_id, config.mail.from, to.to_addr, p.mail.subject.trim(), (p.mail.language || "en").toLowerCase().slice(0, 2), p.mail.body_original, p.mail.body_en || p.mail.body_original, to.supplier_id, to.person, decisionId, nowIso()).lastId;
    run("UPDATE decisions SET mail_message_id = ? WHERE id = ?", messageId, decisionId);
    return decisionId;
  });

  const who = signatures.map((s) => s.person ?? s.role).join(" and ");
  const allFacts = [...new Set([...cited, ...cost.fact_ids, ...approval.fact_ids, ...report.research.flatMap((l) => l.fact_ids), ...report.agreed.flatMap((l) => l.fact_ids)])];
  logEvent({ actor: "action_agent", action: "decision.proposed", run_id: runId, object: { type: "decision", id: String(id), label: p.title.trim() }, fact_ids: allFacts,
    summary: `I prepared "${p.title.trim()}" for ${who}: it saves ${fmtQty(sim.copies_saved)} copies${value !== null ? `, worth EUR ${fmtQty(value)}` : ""}, and ${cost.cost_eur === null ? "the cost needs a quote" : `costs EUR ${fmtQty(cost.cost_eur)}`}${timing.decide_by ? `. It needs a decision by ${fmtTime(new Date(timing.decide_by).getTime())}` : ""}.`,
    input: { risk_id: risk.id, proposal: p }, output: { decision_id: id, copies_saved: sim.copies_saved, copies_by_product: sim.copies_saved_by_product, value_eur: value, with_action: sim.with, without_action: sim.without, cost, timing, approver: approval.approver, signatures } });

  // The company's own limit: below it, an order or a freight booking goes ahead without a click. Signatures on quality,
  // supplier releases and exceptions are never the agent's to give.
  const limit = autonomyLimit();
  const money = p.approval_kind === "po_value" || p.approval_kind === "air_freight" || p.approval_kind === "dock_slot" || p.approval_kind === "other";
  let alone = false;
  if (money && limit > 0 && cost.cost_eur !== null && cost.cost_eur < limit && sim.copies_saved > 0) {
    await decide(id, "approved", "action_agent", `The cost of EUR ${fmtQty(cost.cost_eur)} is below the limit of EUR ${fmtQty(limit)} up to which I may act on my own.`, { auto: true });
    alone = true;
  }
  // Whoever has to sign hears about it by mail, unless the agent carried it out on its own.
  if (!alone) await notifyNextSigner(id);
  return { accepted: true, decision_id: id, copies_saved: sim.copies_saved, value_eur: value, cost_eur: cost.cost_eur, decide_by: timing.decide_by, approver: who, carried_out_without_approval: alone };
}

/** Send the mail of an approved decision. A mail to a colleague has no address and becomes a task in the dashboard. */
async function carryOut(decisionId: number, by: string): Promise<{ sent: boolean; how: string; error: string | null }> {
  const mailId = decisionMailId(decisionId);
  if (!mailId) return { sent: true, how: "nothing to send", error: null };
  const m = get<{ id: number; to_addr: string; person: string | null; subject: string; body_en: string; supplier_id: string | null; status: string }>("SELECT id, to_addr, person, subject, body_en, supplier_id, status FROM messages WHERE id = ?", mailId);
  if (!m || m.status === "sent" || m.status === "outbox") return { sent: true, how: "already out", error: null };
  if (!m.supplier_id) {
    const role = [...loadRoles().values()].find((r) => r.person === m.person || r.deputy === m.person || r.role === m.person)?.role ?? m.person ?? "Procurement";
    tx(() => {
      run("INSERT INTO tasks (status, role, person, title, body, issue_id, object_type, object_id, created_by, created_at) VALUES ('open', ?, ?, ?, ?, NULL, 'decision', ?, 'action_agent', ?)", role, m.person, m.subject, m.body_en, String(decisionId), nowIso());
      run("UPDATE messages SET status = 'outbox', sent_at = ? WHERE id = ?", nowIso(), m.id);
    });
    return { sent: true, how: `as a task for ${m.person ?? role}`, error: null };
  }
  if (!config.mail.sendOnApproval) {
    run("UPDATE messages SET status = 'needs_approval' WHERE id = ? AND status = 'draft'", m.id);
    return { sent: false, how: "it waits in the inbox for a click", error: null };
  }
  try {
    // The mail module is loaded when it is needed, as in the rest of the app.
    const path = "../mail/transport.ts";
    const mod = (await import(path)) as { sendMessage?: (messageId: number, by: string) => unknown };
    if (!mod.sendMessage) throw new Error("the mail module has no sendMessage");
    await mod.sendMessage(m.id, by);
    return { sent: true, how: config.mail.mode === "live" ? "by mail" : "into the local outbox", error: null };
  } catch (e) {
    run("UPDATE messages SET status = 'needs_approval' WHERE id = ? AND status = 'draft'", m.id);
    return { sent: false, how: "it waits in the inbox", error: (e as Error).message };
  }
}

/**
 * Approve or reject a decision card. A card can need several signatures: each approve signs for one person, the one
 * `by` names if there is one, otherwise the next open one. With the last signature the decision is carried out.
 */
export async function decide(id: number, verdict: "approved" | "rejected", by: string, reason?: string, opts: { auto?: boolean } = {}): Promise<DecisionCard | null> {
  const before = decisionById(id);
  if (!before) return null;
  if (before.status !== "pending") return before;
  const mailId = decisionMailId(id);
  const object = { type: "decision" as const, id: String(id), label: before.title };
  const actor = opts.auto ? "action_agent" as const : "human" as const;

  if (verdict === "rejected") {
    tx(() => {
      run("UPDATE decisions SET status = 'rejected', decided_at = ?, decided_by = ?, decision_reason = ? WHERE id = ?", nowIso(), by, reason ?? null, id);
      if (mailId) run("UPDATE messages SET status = 'rejected' WHERE id = ? AND status IN ('draft', 'needs_approval')", mailId);
    });
    logEvent({ actor, action: "decision.rejected", object, summary: `${by === "dashboard" ? "Someone" : by} rejected "${before.title}"${reason ? `: ${reason}` : ""}.`, input: { by, reason: reason ?? null }, output: { decision_id: id, risk_id: before.risk_id } });
    return decisionById(id);
  }

  // Sign.
  const sigs = before.signatures.length ? before.signatures.map((s) => ({ ...s })) : [{ role: before.approver.role, person: before.approver.person, stands_in_for: null, signed_by: null, signed_at: null } as Signature];
  const open = sigs.filter((s) => !s.signed_by);
  const named = open.find((s) => by && by !== "dashboard" && ((s.person ?? "").toLowerCase() === by.toLowerCase() || s.role.toLowerCase() === by.toLowerCase()));
  for (const s of opts.auto ? open : [named ?? open[0]]) if (s) { s.signed_by = opts.auto ? "Lineguard" : by === "dashboard" ? (s.person ?? s.role) : by; s.signed_at = nowIso(); }
  const left = sigs.filter((s) => !s.signed_by);
  if (left.length) {
    run("UPDATE decisions SET signatures = ? WHERE id = ?", JSON.stringify(sigs), id);
    const signed = sigs.filter((s) => s.signed_by).map((s) => s.signed_by).join(" and ");
    logEvent({ actor, action: "decision.signed", object, summary: `${signed} signed "${before.title}". It still needs ${left.map((s) => s.person ?? s.role).join(" and ")}.`, input: { by }, output: { signatures: sigs } });
    await notifyNextSigner(id);
    return decisionById(id);
  }

  const signers = sigs.map((s) => s.signed_by).filter(Boolean).join(" and ");
  const siblings = all<{ id: number; title: string; mail_message_id: number | null }>("SELECT id, title, mail_message_id FROM decisions WHERE risk_id = ? AND status = 'pending' AND id != ?", before.risk_id, id);
  tx(() => {
    run("UPDATE decisions SET status = 'approved', stage = 'approved', signatures = ?, decided_at = ?, decided_by = ?, decision_reason = ?, auto = ? WHERE id = ?", JSON.stringify(sigs), nowIso(), signers, reason ?? null, opts.auto ? 1 : 0, id);
    run("UPDATE risks SET status = 'mitigated', updated_at = ? WHERE id = ? AND status = 'open'", nowIso(), before.risk_id);
    // One option per risk is carried out. The others are taken back so nobody approves a second order for the same gap.
    for (const s of siblings) {
      run("UPDATE decisions SET status = 'rejected', stage = 'withdrawn', decided_at = ?, decided_by = 'action_agent', decision_reason = ? WHERE id = ?", nowIso(), `Another option for this risk was approved: "${before.title}".`, s.id);
      if (s.mail_message_id) run("UPDATE messages SET status = 'rejected' WHERE id = ? AND status IN ('draft', 'needs_approval')", s.mail_message_id);
    }
  });
  const out = await carryOut(id, opts.auto ? "action_agent" : by);
  if (out.sent) run("UPDATE decisions SET stage = 'ordered', check_at = ? WHERE id = ?", new Date(now().getTime() + settings.answerHours * 3_600_000).toISOString(), id);
  planChanged();
  logEvent({ actor, action: opts.auto ? "decision.carried_out" : "decision.approved", object,
    summary: opts.auto
      ? `I carried out "${before.title}" without asking: ${reason ?? "it is below the limit set for me"} The mail went out ${out.how}.`
      : `${signers} approved "${before.title}". ${out.sent ? `Its mail went out ${out.how}` : `Its mail did not go out: ${out.how}`}${out.error ? ` (${out.error})` : ""}.${siblings.length ? ` I took back ${siblings.length} other option${siblings.length === 1 ? "" : "s"} for the same risk.` : ""}`,
    input: { by, reason: reason ?? null, auto: Boolean(opts.auto) }, output: { decision_id: id, risk_id: before.risk_id, copies_saved: before.copies_saved, value_eur: before.value_eur, cost_eur: before.cost_eur, mail_message_id: mailId, mail: out, withdrawn: siblings.map((s) => s.id) },
    fact_ids: before.risk?.fact_ids ?? [] });
  return decisionById(id);
}

/** Take a pending decision back, with the reason. */
function withdraw(id: number, reason: string, runId: string | null): { ok: boolean; reason?: string } {
  const d = decisionById(id);
  if (!d) return { ok: false, reason: `There is no decision ${id}.` };
  if (d.status !== "pending") return { ok: false, reason: `Decision ${id} is ${d.status}. Only a pending decision can be withdrawn.` };
  const mailId = decisionMailId(id);
  tx(() => {
    run("UPDATE decisions SET status = 'rejected', stage = 'withdrawn', decided_at = ?, decided_by = 'action_agent', decision_reason = ? WHERE id = ?", nowIso(), reason, id);
    if (mailId) run("UPDATE messages SET status = 'rejected' WHERE id = ? AND status IN ('draft', 'needs_approval')", mailId);
  });
  logEvent({ actor: "action_agent", action: "decision.withdrawn", run_id: runId, object: { type: "decision", id: String(id), label: d.title }, summary: `I took back "${d.title}": ${reason}`, output: { decision_id: id } });
  return { ok: true };
}

/** Close an approved decision: the supply is confirmed in the data (done), or the other side declined or stayed silent (failed). */
function close(id: number, outcome: "done" | "failed", reason: string, runId: string | null): { ok: boolean; reason?: string } {
  const d = decisionById(id);
  if (!d) return { ok: false, reason: `There is no decision ${id}.` };
  if (d.status !== "approved" || (d.stage !== "approved" && d.stage !== "ordered")) return { ok: false, reason: `Decision ${id} is ${d.status}, stage ${d.stage}. Only an approved decision that is still in flight can be closed.` };
  tx(() => {
    run("UPDATE decisions SET stage = ?, closed_reason = ? WHERE id = ?", outcome, reason, id);
    // What failed is open again and counts in the numbers.
    if (outcome === "failed") run("UPDATE risks SET status = 'open', updated_at = ? WHERE id = ? AND status = 'mitigated'", nowIso(), d.risk_id);
  });
  planChanged();
  logEvent({ actor: "action_agent", action: `decision.${outcome}`, run_id: runId, object: { type: "decision", id: String(id), label: d.title },
    summary: outcome === "done" ? `I closed "${d.title}" as done: ${reason}` : `"${d.title}" did not work out: ${reason} The risk is open again.`, output: { decision_id: id, risk_id: d.risk_id } });
  return { ok: true };
}

// ---- one run for one risk ----

interface Seen { risk: string; decisions: Record<string, string>; questions: string; limit: number }

function caseState(risk: RiskDb): Seen {
  const at = now().getTime();
  const decisions = Object.fromEntries(decisionRows("risk_id = ?", risk.id).map((d) => {
    const late = d.stage === "ordered" && d.check_at && new Date(d.check_at).getTime() < at ? ":confirmation overdue" : "";
    return [String(d.id), `${d.status}:${d.stage}${late}`];
  }));
  return { risk: `${risk.status}|${risk.copies_at_risk}|${risk.fact_ids}|${risk.scenario}`, decisions, questions: questionSignature(risk.id), limit: autonomyLimit() };
}

/** In words, what changed about a risk since the agent last looked. Empty = nothing to do. */
function whatChanged(risk: RiskDb, seen: Seen | null, state: Seen): string[] {
  if (!seen) return ["This risk is new to you."];
  const out: string[] = [];
  if (seen.risk !== state.risk) out.push("The risk itself changed: its facts, its scenario or the copies it costs.");
  for (const [id, s] of Object.entries(state.decisions)) {
    if (seen.decisions[id] === s) continue;
    const d = decisionById(Number(id));
    if (!d) continue;
    if (s.endsWith("confirmation overdue")) out.push(`Decision ${id} ("${d.title}") was carried out, and the time for the other side to confirm has passed.`);
    else if (d.status === "approved" && !seen.decisions[id]?.startsWith("approved")) out.push(`Decision ${id} ("${d.title}") was approved by ${d.decided_by ?? "someone"} and its mail is out.`);
    else if (d.status === "rejected" && d.stage !== "withdrawn") out.push(`Decision ${id} ("${d.title}") was rejected by ${d.decided_by ?? "someone"}${d.decision_reason ? `, with this reason: ${d.decision_reason}` : ", without a reason"}.`);
  }
  if (seen.questions !== state.questions) out.push("Something changed about your questions: an answer came in, or an answer is overdue. See the list.");
  if (seen.limit !== state.limit) out.push("The limit up to which you may act on your own was changed.");
  return out;
}

/** Parts a risk touches: its own part and the parts named in its scenario. */
function partsOfRisk(risk: Risk): string[] {
  const sc = normalizeScenario(risk.scenario).scenario;
  return [...new Set([risk.part_id, ...sc.changes.map((c) => c.part_id)].filter((x): x is string => !!x))];
}

function contextFor(risk: Risk, changes: string[], snap: Snapshot) {
  const overview = overviewForAgent(snap);
  const roles = [...new Set(snap.fx.ofField("role", "person").map((f) => f.object_id))].map((title) => ({
    role: title, person: snap.fx.val("role", title, "person"), reports_to: snap.fx.val("role", title, "reports_to"), starts: snap.fx.val("role", title, "available_from") }));
  const limit = autonomyLimit();
  return {
    now: overview.now, now_iso: overview.now_iso, deadline: overview.deadline, deadline_iso: overview.deadline_iso, shifts: overview.shifts,
    what_changed_since_you_last_looked: changes,
    acting_alone: limit > 0 ? `Orders and freight below EUR ${fmtQty(limit)} are carried out without a click once you propose them. Everything else waits for a person.` : "Every binding option waits for a person.",
    risk: { id: risk.id, status: risk.status, title: risk.title, explanation: risk.explanation, probability: risk.probability, scenario: risk.scenario, copies_at_risk: risk.copies_at_risk, copies_by_product: risk.copies_by_product,
      value_at_risk_eur: valueOf(risk.copies_by_product), part_id: risk.part_id, supplier_id: risk.supplier_id, facts: factsById(risk.fact_ids).map(factLine) },
    the_case_so_far: {
      decisions: decisionRows("risk_id = ?", risk.id).map((d) => ({ decision_id: d.id, status: d.status, stage: d.stage, title: d.title, option: d.option, copies_saved: d.copies_saved, value_eur: d.value_eur, cost_eur: d.cost_eur, decide_by: d.decide_by,
        decided_by: d.decided_by, reason: d.decision_reason, carried_out_by_you: Boolean(d.auto) })),
      questions: questionsForAgent(risk.id),
    },
    editions: overview.editions,
    value_per_copy_eur: valuePerCopy(),
    parts: partsOfRisk(risk).map((id) => partForAgent(id, snap)),
    other_parts: overview.parts.map((p) => ({ part_id: p.part_id, description: p.description, status: p.status, need: p.need, safe: p.safe, uncertain: p.uncertain, gap: p.gap })),
    routes: snap.routes,
    organisation: roles,
  };
}

function actionTools(risk: Risk, runId: string, did: { asked: number; proposed: number[] }): Tool[] {
  const logged = logger("action_agent", runId, { type: "risk", id: String(risk.id) });
  return [
    ...readTools(logged),
    { name: "get_thread", description: "The last mails exchanged with one supplier, oldest first, in English. Read it before you ask that supplier anything.", parameters: obj({ supplier_id: str() }),
      run: logged<{ supplier_id: string }>("get_thread", (a, r) => `I read the last ${r.length} mails exchanged with ${loadSnapshot().suppliers.get(a.supplier_id)?.name ?? a.supplier_id}.`, (a) => threadForAgent(a.supplier_id), (a) => ({ type: "supplier", id: a.supplier_id })) },
    { name: "check_option", description: "What an option would do, as a what-if on top of this risk: copies saved, what they are worth, and how long the decision can wait. Stores nothing. Use it before you propose.",
      parameters: obj({ scenario: scenarioSchema, expires_at: nullable(str("ISO time when the offer behind the option runs out, or null")) }),
      run: logged<{ scenario: unknown; expires_at: string | null }>("check_option",
        (_a, r) => (r.valid ? `I checked an option: it saves ${fmtQty(r.copies_saved)} copies${r.value_eur !== null ? `, worth EUR ${fmtQty(r.value_eur)}` : ""}${r.decide_by ? `, if it is decided by ${fmtTime(new Date(r.decide_by).getTime())}` : ""}.` : `I checked an option the code could not compute: ${r.problems.join(" ")}`),
        (a) => {
          const snap = loadSnapshot();
          const sim = simulateAction(risk.scenario, a.scenario, snap);
          if (!sim.valid) return { valid: false, problems: sim.problems };
          const timing = timingOf(risk.scenario, a.scenario, { expiresAt: a.expires_at, snap });
          return { valid: true, problems: [], copies_saved: sim.copies_saved, copies_saved_by_product: sim.copies_saved_by_product, value_eur: valueOf(sim.copies_saved_by_product),
            decide_by: timing.decide_by, copies_lost_per_hour_after_that: timing.wait_copies_per_hour, eur_lost_per_hour_after_that: timing.wait_eur_per_hour, timing: timing.basis,
            editions_with_the_option: sim.with.map((e) => ({ product_id: e.product_id, safe: e.safe, uncertain: e.uncertain, lost: e.lost, bottleneck: e.bottleneck_reason })) };
        }) },
    { name: "ask", description: "Put a question to a supplier or a colleague. It is collected and leaves in one mail per supplier, together with the data agent's open questions, when you are done (a colleague gets a task). The mail states by when the answer is needed. Refused if you or the data agent already asked the same thing, or it is answered. Never use it to order, accept or book.",
      parameters: obj({
        to: enumT(["supplier", "role"]), supplier_id: nullable(str()), role: nullable(str("role title from the organisation chart")),
        topic: enumT([...TOPICS], "what kind of fact you ask for"),
        object_type: nullable(enumT(["po_line", "shipment", "lot", "part", "supplier"], "what the question is about")), object_id: nullable(str("id of that order line, shipment, lot, part or supplier")), part_id: nullable(str()),
        subject: str("a few words: what the question is about"),
        question: str("the question in English, answerable with a fact, with the order number, part description and the quantity or date in question"),
        background: nullable(str("what the writer of the mail should know and the recipient need not be told")),
        reminder_of: nullable({ type: "integer", description: "id of the overdue question this reminds of. One reminder per question." }),
      }),
      run: async (a: Omit<AskInput, "risk_id">) => { const r = askQuestion({ ...a, risk_id: risk.id }, runId); if (r.accepted) did.asked++; return r; } },
    { name: "propose_decision", description: "Hand one option to the person who has to approve it. Code computes copies, value, cost, the time the decision can wait and the approver, stores the card with its mail, and returns them. Returns accepted false with the reason if something is missing.",
      parameters: proposalSchema,
      run: async (p: Proposal) => { const r = await storeProposal(risk, p, runId); if (r.accepted && r.decision_id) did.proposed.push(r.decision_id); return r; } },
    { name: "withdraw_decision", description: "Take back one of your pending decisions, for example when the facts changed or a better option came up.", parameters: obj({ decision_id: { type: "integer" }, reason: str("one sentence") }),
      run: (a: { decision_id: number; reason: string }) => (decisionById(a.decision_id)?.risk_id === risk.id ? withdraw(a.decision_id, a.reason, runId) : { ok: false, reason: `Decision ${a.decision_id} does not belong to this risk.` }) },
    { name: "close_decision", description: "Close an approved decision that is in flight. done: the confirmation or the goods show in the data. failed: the other side declined or stayed silent past the time given. A failed decision opens the risk again.",
      parameters: obj({ decision_id: { type: "integer" }, outcome: enumT(["done", "failed"]), reason: str("one sentence that names the mail or fact you rely on") }),
      run: (a: { decision_id: number; outcome: "done" | "failed"; reason: string }) => (decisionById(a.decision_id)?.risk_id === risk.id ? close(a.decision_id, a.outcome, a.reason, runId) : { ok: false, reason: `Decision ${a.decision_id} does not belong to this risk.` }) },
  ];
}

export interface ActionRunResult { run_id: string; ran_model: boolean; reason: string; risks: number; decisions: number; questions: number }

const seenKey = (riskId: number) => `action.seen.${riskId}`;
let running = false;
export const actionAgentRunning = () => running;

/**
 * One pass. Code first brings questions and decisions up to date. Then the agent works on every open risk where
 * something changed since it last looked, the most expensive first. At the end the collected questions leave, one mail per supplier.
 */
export async function runActionAgent(opts: { runId?: string; riskId?: number; force?: boolean } = {}): Promise<ActionRunResult> {
  const runId = opts.runId ?? newRunId("action");
  const none = (reason: string, risks = 0): ActionRunResult => ({ run_id: runId, ran_model: false, reason, risks, decisions: 0, questions: 0 });
  if (running) return none("already running");
  running = true;
  try {
    refreshQuestions();
    // A decision that waits for a risk the data no longer shows is taken back.
    for (const d of all<{ id: number }>("SELECT d.id FROM decisions d JOIN risks r ON r.id = d.risk_id WHERE d.status = 'pending' AND r.status = 'closed'")) withdraw(d.id, "The risk behind it no longer shows in the data.", runId);

    const rows = riskRows("status IN ('open', 'mitigated')").filter((r) => (opts.riskId ? r.id === opts.riskId : true));
    const todo = rows.map((r) => { const state = caseState(r); const seen = json<Seen | null>(kv.get(seenKey(r.id)), null); return { r, changes: opts.force ? (seen ? ["You were asked to look at this risk again."] : ["This risk is new to you."]) : whatChanged(r, seen, state) }; })
      .filter((x) => x.changes.length)
      .sort((a, b) => (valueOf(json(b.r.copies_by_product, [])) ?? b.r.copies_at_risk) * b.r.probability - (valueOf(json(a.r.copies_by_product, [])) ?? a.r.copies_at_risk) * a.r.probability)
      .slice(0, settings.actionMaxRisksPerRun);
    if (!todo.length) return none("nothing changed on any open risk");
    if (!llmAvailable()) {
      // Say it once per set of waiting risks, not on every cycle.
      const waiting = todo.map((x) => x.r.id).join(",");
      const last = all<{ output: string | null }>("SELECT output FROM events WHERE actor = 'action_agent' AND action = 'action_agent.skipped' ORDER BY id DESC LIMIT 1")[0];
      if (!last?.output?.includes(`"waiting":"${waiting}"`)) {
        logEvent({ actor: "action_agent", action: "action_agent.skipped", run_id: runId, summary: `I did not work on ${todo.length} open risk${todo.length === 1 ? "" : "s"} because no OpenAI key is set.`, output: { waiting } });
      }
      return none("no model available", todo.length);
    }

    let decisions = 0, questions = 0;
    for (const { r, changes } of todo) {
      const risk = toRisk(r, { trace: false });
      const object = { type: "risk" as const, id: String(risk.id), label: risk.title };
      const did = { asked: 0, proposed: [] as number[] };
      const trace: ToolCallTrace[] = [];
      logEvent({ actor: "action_agent", action: "action_agent.started", run_id: runId, object, summary: `I started on the risk "${risk.title}". ${changes.join(" ")}`, input: { risk_id: risk.id, changes } });
      try {
        const snap = loadSnapshot(true);
        const res = await runAgent({
          model: config.openai.modelAgent,
          system: withStyle(prompt("action_agent.md").replace("{{SCENARIO_HELP}}", SCENARIO_HELP)),
          user: `Work on this risk.\n\n${JSON.stringify(contextFor(risk, changes, snap))}`,
          tools: actionTools(risk, runId, did), maxSteps: settings.actionAgentMaxSteps,
          onToolCall: (t) => { trace.push(t); },
        });
        decisions += did.proposed.length; questions += did.asked;
        const usage: Usage = res.usage;
        logEvent({ actor: "action_agent", action: "action_agent.finished", run_id: runId, object, fact_ids: risk.fact_ids,
          summary: res.text.trim() ? res.text.trim().slice(0, 600) : `I finished my pass on "${risk.title}": ${did.proposed.length} decision${did.proposed.length === 1 ? "" : "s"} prepared, ${did.asked} question${did.asked === 1 ? "" : "s"} asked.`,
          input: { risk_id: risk.id, steps: res.steps, tool_calls: trace.map((t) => t.name) }, output: { decision_ids: did.proposed, questions_asked: did.asked, summary: res.text },
          model: usage.model, tokens_in: usage.tokens_in, tokens_out: usage.tokens_out, cost_usd: usage.cost_usd });
      } catch (e) {
        logEvent({ actor: "action_agent", action: "action_agent.failed", run_id: runId, object, summary: `I could not finish my pass on "${risk.title}": ${(e as Error).message}` });
      }
    }
    // Everything that was asked in this pass leaves now, one mail per supplier.
    const flushed = await flushQuestions(runId);
    // Remember what the agent has seen, after its own changes, so it only wakes for something new.
    for (const { r } of todo) { const fresh = riskById(r.id); if (fresh) kv.set(seenKey(r.id), JSON.stringify(caseState(fresh))); }
    return { run_id: runId, ran_model: true, reason: "something changed on open risks", risks: todo.length, decisions, questions: flushed.questions || questions };
  } finally {
    running = false;
  }
}

/** For the overview: what the agent is doing about each open risk, and who has to move next. */
export function agentWork(): AgentWork[] {
  const out: AgentWork[] = [];
  for (const r of riskRows("status IN ('open', 'mitigated')")) {
    const ds = decisionRows("risk_id = ?", r.id);
    const seen = kv.get(seenKey(r.id)) !== null;
    if (!seen && !ds.length) continue; // not picked up yet
    const pending = ds.filter((d) => d.status === "pending").sort((a, b) => (a.decide_by ?? "9").localeCompare(b.decide_by ?? "9"))[0];
    const flying = ds.find((d) => d.status === "approved" && (d.stage === "approved" || d.stage === "ordered"));
    const wait = waitingOn(r.id);
    const last = get<{ summary: string; ts: string }>("SELECT summary, ts FROM events WHERE actor = 'action_agent' AND ((object_type = 'risk' AND object_id = ?) OR (object_type = 'decision' AND object_id IN (SELECT CAST(id AS TEXT) FROM decisions WHERE risk_id = ?))) ORDER BY id DESC LIMIT 1", String(r.id), r.id);
    const byProduct = json<{ product_id: string; copies: number }[]>(r.copies_by_product, []);
    let state: AgentWork["state"] = "watching", waitingFor: string | null = null, until: string | null = null;
    if (pending) {
      const sigs = json<Signature[]>(pending.signatures, []).filter((s) => !s.signed_by);
      state = "waiting_person"; waitingFor = sigs.map((s) => s.person ?? s.role).join(" and ") || null; until = pending.decide_by;
    } else if (wait) { state = wait.kind === "supplier" ? "waiting_supplier" : "waiting_person"; waitingFor = wait.name; until = wait.until; }
    else if (flying) {
      const mail = flying.mail_message_id ? get<{ supplier_id: string | null; person: string | null }>("SELECT supplier_id, person FROM messages WHERE id = ?", flying.mail_message_id) : undefined;
      state = "ordered"; waitingFor = mail?.supplier_id ? (loadSnapshot().suppliers.get(mail.supplier_id)?.name ?? mail.supplier_id) : (mail?.person ?? null);
      until = flying.check_at;
    }
    out.push({ risk_id: r.id, title: r.title, part_id: r.part_id, state, waiting_for: waitingFor, until, copies_at_risk: r.copies_at_risk, value_at_risk_eur: valueOf(byProduct), last_step: last?.summary ?? null, last_at: last?.ts ?? null });
  }
  return out;
}

/**
 * Pending decision cards follow the data: copies saved are computed again from the card's what-if and its risk,
 * so a card never shows a number from an older state. Code only.
 */
export function recomputeDecisions(runId?: string): number {
  const snap = loadSnapshot();
  let changed = 0;
  for (const d of all<{ id: number; risk_id: number; title: string; copies_saved: number; scenario: string }>("SELECT id, risk_id, title, copies_saved, scenario FROM decisions WHERE status = 'pending'")) {
    const risk = get<{ scenario: string }>("SELECT scenario FROM risks WHERE id = ?", d.risk_id);
    if (!risk) continue;
    let sim;
    try { sim = simulateAction(JSON.parse(risk.scenario), JSON.parse(d.scenario || "{}"), snap); } catch { continue; }
    if (!sim.valid || sim.copies_saved === d.copies_saved) continue;
    run("UPDATE decisions SET copies_saved = ?, copies_by_product = ? WHERE id = ?", sim.copies_saved, JSON.stringify(sim.copies_saved_by_product), d.id);
    changed++;
    logEvent({ actor: "action_agent", action: "decision.recomputed", run_id: runId, object: { type: "decision", id: String(d.id), label: d.title },
      summary: `I recomputed the option "${d.title}" with the latest data: ${fmtQty(d.copies_saved)} copies saved became ${fmtQty(sim.copies_saved)}.`,
      output: { decision_id: d.id, before: d.copies_saved, after: sim.copies_saved, by_product: sim.copies_saved_by_product } });
  }
  return changed;
}
