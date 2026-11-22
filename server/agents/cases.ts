import crypto from "node:crypto";
import type { AgentCase, CaseList, CaseState, CaseStep, Signature } from "../../shared/api.ts";
import { config } from "../config.ts";
import { all, get, json, run } from "../db.ts";
import { nowIso } from "../clock.ts";
import { logEvent } from "../events.ts";
import { addUsage, arr, llmAvailable, nullable, obj, prompt, str, structured, withStyle } from "../llm.ts";
import type { Usage } from "../llm.ts";
import { decisionRows, riskRows } from "../compute/rows.ts";
import type { DecisionDb, RiskDb } from "../compute/rows.ts";
import { valueOf } from "../compute/value.ts";
import { answerText, nameOf, questionRows } from "./questions.ts";

// The Agents page: one line per case, as a chain of four phrases.
//   change -> impact -> action -> result
// Code collects what belongs to a case and decides where it stands (the state). The four phrases are written by a
// model, once per state of the case (prompts/case_line.md). Until that is done, and whenever the model is not there,
// the page shows phrases put together by code, so a line is never empty and never claims more than the data says.

const cut = (text: string, max: number): string => {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max - 1);
  const space = head.lastIndexOf(" ");
  return `${(space > max * 0.6 ? head.slice(0, space) : head).replace(/[ ,;:.]+$/, "")}…`;
};
/** A phrase on the line: one line, no full stop, never longer than this. */
const PHRASE_MAX = 64;
const phrase = (text: string) => cut(text.replace(/\*\*/g, "").replace(/[.\s]+$/, ""), PHRASE_MAX);
const firstLine = (text: string) => text.split("\n", 1)[0].replace(/\*\*/g, "").trim();
const sha = (value: unknown) => crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const short = (iso: string | null): string | null => {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: config.customer.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.hour}:${p.minute}`;
};
const supplierName = (id: string | null) => (id ? (get<{ name: string }>("SELECT name FROM suppliers WHERE supplier_id = ?", id)?.name ?? id) : null);
const ACTOR: Record<string, string> = { sync: "Sync", data_agent: "Data agent", risk_agent: "Risk agent", action_agent: "Action agent", human: "", system: "System" };

interface Line { change: string; impact: string; action: string | null; result: string }
/** A case as code sees it: everything but the phrases, the phrases code would write, and what the model gets to read. */
interface Built {
  base: Omit<AgentCase, "change" | "impact" | "action" | "result" | "written_by">;
  fallback: Line;
  head_sig: string;
  sig: string;
  brief: Record<string, unknown>;
}

const RESULT: Record<CaseState, (who: string | null) => string> = {
  needs_you: (who) => (who ? `Needs ${who}` : "Needs a decision"),
  waiting: (who) => (who ? `Waiting for ${who}` : "Waiting for an answer"),
  working: () => "In progress",
  solved: () => "Solved",
  failed: () => "Not solved",
};

// ---- a risk ----

const RISK_STEPS = ["risk.reported", "decision.proposed", "decision.signed", "decision.approved", "decision.carried_out", "decision.rejected", "decision.done", "decision.failed", "decision.withdrawn", "risk.closed"];

function riskCase(r: RiskDb): Built {
  const ds = decisionRows("risk_id = ?", r.id);
  const qs = questionRows(r.id);
  const decisionIds = ds.map((d) => String(d.id));
  const marks = decisionIds.map(() => "?").join(",") || "''";

  const steps: CaseStep[] = all<{ ts: string; actor: string; summary: string }>(
    `SELECT ts, actor, summary FROM events WHERE action IN (${RISK_STEPS.map(() => "?").join(",")})
       AND ((object_type = 'risk' AND object_id = ?) OR (object_type = 'decision' AND object_id IN (${marks}))) ORDER BY id`,
    ...RISK_STEPS, String(r.id), ...decisionIds).map((e) => ({ at: e.ts, who: ACTOR[e.actor] ?? e.actor, text: cut(firstLine(e.summary), 220) }));
  for (const q of qs) {
    const name = nameOf(q);
    steps.push({ at: q.sent_at ?? q.created_at, who: "Action agent", text: cut(`I asked ${name}: ${q.text}`, 220) });
    if (q.status === "answered") steps.push({ at: q.answered_at, who: name, text: cut(answerText(q) ?? "Answered.", 220) });
    if (q.status === "no_answer") steps.push({ at: q.answer_by, who: name, text: "No answer in time." });
  }
  const tasks = decisionIds.length ? all<{ id: number; person: string | null; role: string; title: string; status: string; created_at: string; done_at: string | null; answer: string | null }>(
    `SELECT id, person, role, title, status, created_at, done_at, answer FROM tasks WHERE object_type = 'decision' AND object_id IN (${marks}) ORDER BY id`, ...decisionIds) : [];
  for (const t of tasks) {
    steps.push({ at: t.created_at, who: "Action agent", text: cut(`Task for ${t.person ?? t.role}: ${t.title}`, 220) });
    if (t.status === "done") steps.push({ at: t.done_at, who: t.person ?? t.role, text: cut(t.answer ? `Answered: ${t.answer}` : "Marked the task as done.", 220) });
  }
  steps.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));

  // Where it stands. The order matters: a signature that is missing comes before anything we wait for.
  const pending = ds.filter((d) => d.status === "pending").sort((a, b) => (a.decide_by ?? "9").localeCompare(b.decide_by ?? "9"))[0];
  const flying = ds.find((d) => d.status === "approved" && (d.stage === "approved" || d.stage === "ordered"));
  const done = ds.find((d) => d.stage === "done");
  const failed = [...ds].reverse().find((d) => d.stage === "failed");
  const openQs = qs.filter((q) => q.status === "sent" || q.status === "queued").sort((a, b) => (a.answer_by ?? "9").localeCompare(b.answer_by ?? "9"));
  let state: CaseState = "working", waitingFor: string | null = null, due: string | null = null;
  if (r.status === "closed" || done) state = "solved";
  else if (pending) {
    state = "needs_you"; due = pending.decide_by;
    waitingFor = json<Signature[]>(pending.signatures, []).filter((s) => !s.signed_by).map((s) => s.person ?? s.role).join(" and ") || null;
  } else if (flying) {
    const mail = flying.mail_message_id ? get<{ supplier_id: string | null; person: string | null }>("SELECT supplier_id, person FROM messages WHERE id = ?", flying.mail_message_id) : undefined;
    state = "waiting"; waitingFor = supplierName(mail?.supplier_id ?? null) ?? mail?.person ?? tasks.find((t) => t.status === "open")?.person ?? null; due = flying.check_at;
  } else if (openQs.length) { state = "waiting"; waitingFor = nameOf(openQs[0]); due = openQs[0].answer_by; }
  else if (failed) state = "failed";

  const shown = pending ?? flying ?? done ?? failed ?? ds[ds.length - 1];
  const supplierAsked = qs.find((q) => q.supplier_id);
  // A decision reaches a supplier when its mail is addressed to one.
  const toSupplier = (d: DecisionDb | undefined) => Boolean(d && d.mail_message_id !== null
    && get<{ supplier_id: string | null }>("SELECT supplier_id FROM messages WHERE id = ?", d.mail_message_id)?.supplier_id);
  // Internal follows who has to move next. While the case waits, it is internal when it waits for a colleague only,
  // also if a supplier was asked earlier and has answered. Once nothing is open any more, it is internal when no
  // supplier was ever written to. A case that waits for a signature always stays in the main list.
  const outsideNow = openQs.some((q) => q.supplier_id) || toSupplier(pending) || toSupplier(flying);
  const outsideEver = Boolean(supplierAsked) || ds.some((d) => d.status !== "rejected" && toSupplier(d));
  const internal = state !== "needs_you" && (qs.length > 0 || ds.length > 0) && !(state === "waiting" ? outsideNow : outsideEver);
  const byProduct = json<{ product_id: string; copies: number }[]>(r.copies_by_product, []);
  const value = valueOf(byProduct);
  const last = steps[steps.length - 1]?.at ?? r.created_at;

  // What code would write, if the model has not written the line.
  const lastQ = qs[qs.length - 1];
  const action = shown ? phrase(shown.title) : lastQ ? phrase(`Asked ${nameOf(lastQ)}`) : null;
  const sources = all<{ source_path: string }>(`SELECT DISTINCT source_path FROM facts WHERE id IN (SELECT value FROM json_each(?)) LIMIT 6`, r.fact_ids || "[]").map((f) => f.source_path);

  const about = { title: r.title, explanation: cut(r.explanation, 700) };
  return {
    base: {
      key: `risk:${r.id}`, kind: "risk",
      internal,
      state, copies: r.copies_at_risk, value_eur: value, waiting_for: waitingFor, due,
      started_at: r.created_at, updated_at: last, steps,
      risk_id: r.id, decision_id: shown?.id ?? null, task_id: tasks.find((t) => t.status === "open")?.id ?? null,
      thread_id: supplierAsked?.supplier_id ? `supplier:${supplierAsked.supplier_id}` : null, part_id: r.part_id,
    },
    fallback: { change: sourceLabel(sources), impact: phrase(r.title), action, result: phrase(RESULT[state](waitingFor)) },
    head_sig: sha(about),
    sig: sha([about, state, waitingFor, steps.map((s) => s.text)]),
    brief: {
      key: `risk:${r.id}`, kind: "risk to the launch", ...about, came_from_files: sources,
      copies_at_risk: r.copies_at_risk, value_at_risk_eur: value,
      decisions: ds.map((d) => decisionBrief(d)), steps: steps.slice(-10).map((s) => `${short(s.at) ?? "?"} ${s.who}: ${s.text}`),
      state, waiting_for: waitingFor, due: short(due),
    },
  };
}

const decisionBrief = (d: DecisionDb) => ({ title: d.title, what: cut(d.option, 240), status: d.status, stage: d.stage, done_by_the_agent_alone: Boolean(d.auto), decided_by: d.decided_by, reason: d.decision_reason ?? d.closed_reason ?? null });

/** Where a risk came from, as far as the file paths tell. Only used until the agent has written the line. */
function sourceLabel(paths: string[]): string {
  const p = paths.join(" ");
  if (p.includes("/news/")) return "News item";
  if (p.includes("/notices/")) return "Notice from a supplier";
  if (p.includes("/logistics/")) return "Logistics update";
  if (p.includes("/erp/")) return "Change in the ERP data";
  return "Found in the data";
}

// ---- a check: a deviation the data agent took up with a supplier or a colleague ----

const CHECK_LABEL: Record<string, string> = {
  quantity: "Quantities do not match", date_eta: "Dates do not match", price: "Price differs from the contract", tracking_stale: "Tracking went silent",
  source_conflict: "Two sources disagree", quality_hold: "Lot on quality hold", supplier_notice: "Notice from a supplier", other: "Open point in the data",
};
interface IssueRow { id: number; type: string; status: string; title: string; detail: string; expected: string | null; actual: string | null; part_id: string | null; supplier_id: string | null; addressee: string | null; assignee_role: string | null; question: string | null; note: string | null; created_at: string; updated_at: string }
interface MailRow { id: number; thread_id: string; direction: string; status: string; subject: string; supplier_id: string | null; person: string | null; at: string }
interface TaskRow { id: number; person: string | null; role: string; title: string; status: string; created_at: string; done_at: string | null; answer: string | null }

function checkCase(i: IssueRow, mails: MailRow[], tasks: TaskRow[]): Built {
  const supplier = supplierName(i.supplier_id ?? mails.find((m) => m.supplier_id)?.supplier_id ?? null);
  const steps: CaseStep[] = [{ at: i.created_at, who: "Data agent", text: cut(`I found: ${i.title}`, 220) }];
  for (const m of mails) {
    if (m.status === "rejected") continue;
    if (m.direction === "in") steps.push({ at: m.at, who: supplier ?? "Supplier", text: cut(`Replied: ${m.subject}`, 220) });
    else steps.push({ at: m.at, who: "Data agent", text: cut(m.status === "needs_approval" || m.status === "draft" ? `I wrote a mail to ${supplier ?? "the supplier"}. It waits to be sent: ${m.subject}` : `I asked ${supplier ?? "the supplier"}: ${m.subject}`, 220) });
  }
  for (const t of tasks) {
    steps.push({ at: t.created_at, who: "Data agent", text: cut(`Task for ${t.person ?? t.role}: ${t.title}`, 220) });
    if (t.status === "done") steps.push({ at: t.done_at, who: t.person ?? t.role, text: cut(t.answer ? `Answered: ${t.answer}` : "Marked the task as done.", 220) });
  }
  const dismissed = i.note?.startsWith("dismissed") ?? false;
  if (i.status === "resolved") steps.push({ at: i.updated_at, who: "Data agent", text: cut(dismissed ? `Closed, no action needed. ${i.note!.replace(/^dismissed:?\s*/, "")}` : "Cleared up.", 220) });
  steps.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));

  const unsent = mails.find((m) => m.direction === "out" && (m.status === "needs_approval" || m.status === "draft"));
  const openTask = tasks.find((t) => t.status === "open");
  const internal = i.addressee === "internal" || (!mails.some((m) => m.direction === "out" && m.status !== "rejected") && tasks.length > 0);
  let state: CaseState = "working", waitingFor: string | null = null;
  if (i.status === "resolved") state = "solved";
  else if (unsent) { state = "needs_you"; waitingFor = "someone to send the mail"; }
  else if (i.status === "asked") { state = "waiting"; waitingFor = internal ? (openTask?.person ?? openTask?.role ?? i.assignee_role) : supplier; }
  else if (openTask) { state = "waiting"; waitingFor = openTask.person ?? openTask.role; }

  const asked = internal ? (tasks[0]?.person ?? tasks[0]?.role ?? i.assignee_role) : supplier;
  const about = { type: i.type, title: i.title, detail: cut(i.detail, 500), expected: i.expected, actual: i.actual };
  const thread = mails.find((m) => m.thread_id)?.thread_id ?? null;
  return {
    base: {
      key: `check:${i.id}`, kind: "check", internal, state, copies: null, value_eur: null, waiting_for: waitingFor, due: null,
      started_at: i.created_at, updated_at: steps[steps.length - 1]?.at ?? i.updated_at, steps,
      risk_id: null, decision_id: null, task_id: (openTask ?? tasks[0])?.id ?? null, thread_id: internal ? null : thread, part_id: i.part_id,
    },
    fallback: {
      change: CHECK_LABEL[i.type] ?? CHECK_LABEL.other, impact: phrase(i.title), action: asked ? phrase(`Asked ${asked}`) : null,
      result: phrase(state === "needs_you" ? "Mail waits to be sent" : state === "solved" ? (dismissed ? "Closed, no action needed" : "Cleared up") : i.status === "answered" ? "Answer is in" : RESULT[state](waitingFor)),
    },
    head_sig: sha(about),
    sig: sha([about, state, waitingFor, i.status, steps.map((s) => s.text)]),
    brief: {
      key: `check:${i.id}`, kind: internal ? "data check with a colleague" : "data check with a supplier", ...about, question: i.question ? cut(i.question, 300) : null,
      steps: steps.slice(-8).map((s) => `${short(s.at) ?? "?"} ${s.who}: ${s.text}`), state, answer_is_in: i.status === "answered", waiting_for: waitingFor,
    },
  };
}

// ---- all cases ----

const ORDER: Record<CaseState, number> = { needs_you: 0, waiting: 1, working: 2, failed: 3, solved: 4 };

function build(): Built[] {
  const out: Built[] = riskRows().map(riskCase);

  // A deviation is a case once somebody was asked about it. Questions of the action agent travel as issues too
  // ("ask:..."): they belong to their risk and are not a case of their own.
  const issues = all<IssueRow>("SELECT * FROM issues WHERE dedupe_key NOT LIKE 'ask:%' ORDER BY id");
  const mailsOf = new Map<number, MailRow[]>();
  for (const m of all<MailRow & { issue_id: number }>(
    "SELECT m.id, m.thread_id, m.direction, m.status, m.subject, m.supplier_id, m.person, COALESCE(m.sent_at, m.created_at) AS at, j.value AS issue_id FROM messages m, json_each(m.issue_ids) j ORDER BY m.id")) {
    (mailsOf.get(m.issue_id) ?? mailsOf.set(m.issue_id, []).get(m.issue_id)!).push(m);
  }
  const tasksOf = new Map<number, TaskRow[]>();
  for (const t of all<TaskRow & { issue_id: number }>("SELECT id, person, role, title, status, created_at, done_at, answer, issue_id FROM tasks WHERE issue_id IS NOT NULL ORDER BY id")) {
    (tasksOf.get(t.issue_id) ?? tasksOf.set(t.issue_id, []).get(t.issue_id)!).push(t);
  }
  for (const i of issues) {
    const mails = mailsOf.get(i.id) ?? [], tasks = tasksOf.get(i.id) ?? [];
    if (!mails.length && !tasks.length) continue;
    out.push(checkCase(i, mails, tasks));
  }
  return out.sort((a, b) => ORDER[a.base.state] - ORDER[b.base.state] || (a.base.kind === b.base.kind ? 0 : a.base.kind === "risk" ? -1 : 1) || b.base.updated_at.localeCompare(a.base.updated_at));
}

interface Stored { key: string; head_sig: string; sig: string; change: string; impact: string; action: string | null; result: string }

/** The list for the Agents page. Reads only, so it also works for a moment in the past. */
export function listCases(): CaseList {
  const stored = new Map(all<Stored>("SELECT key, head_sig, sig, change, impact, action, result FROM cases").map((s) => [s.key, s]));
  const cases = build().map((b): AgentCase => {
    const s = stored.get(b.base.key);
    // What the case is about rarely changes, what was done does. So the first two phrases stay when only the rest is stale.
    const head = s && s.head_sig === b.head_sig, whole = s && s.sig === b.sig;
    return {
      ...b.base,
      change: head ? s.change : b.fallback.change, impact: head ? s.impact : b.fallback.impact,
      action: whole ? s.action : b.fallback.action, result: whole ? s.result : b.fallback.result,
      written_by: whole ? "agent" : "code",
    };
  });
  return { now: nowIso(), cases };
}

// ---- the agent writes the lines ----

const BATCH = 8;
const MAX_PER_PASS = 48;
const SCHEMA = obj({ lines: arr(obj({ key: str("The key of the case, as given"), change: str(), impact: str(), action: nullable(str("null if nothing was done yet")), result: str() })) });
let writing = false;
let lastFailure: string | null = null;

/**
 * Write the line of every case that has none for its current state. A few cases per call, the most pressing first.
 * Runs at the end of every cycle and after a decision in the dashboard. Costs nothing when nothing moved.
 */
export async function writeCaseLines(runId: string | null = null): Promise<{ written: number; left: number }> {
  if (writing || !llmAvailable()) return { written: 0, left: 0 };
  writing = true;
  try {
    const stored = new Map(all<{ key: string; sig: string }>("SELECT key, sig FROM cases").map((s) => [s.key, s.sig]));
    const stale = build().filter((b) => stored.get(b.base.key) !== b.sig);
    const todo = stale.slice(0, MAX_PER_PASS);
    if (!todo.length) return { written: 0, left: 0 };
    const batches: Built[][] = [];
    for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));

    let written = 0, usage: Usage | null = null;
    const errors: string[] = [];
    await Promise.all(batches.map(async (batch) => {
      try {
        const res = await structured<{ lines: (Line & { key: string })[] }>({
          model: config.openai.modelExtract, system: withStyle(prompt("case_line.md")), schemaName: "case_lines", schema: SCHEMA,
          user: `Write the line for each of these ${batch.length} cases.\n\n${JSON.stringify(batch.map((b) => b.brief), null, 1)}`,
        });
        usage = usage ? addUsage(usage, res.usage) : res.usage;
        for (const line of res.data.lines) {
          const b = batch.find((x) => x.base.key === line.key);
          if (!b || !line.change?.trim() || !line.impact?.trim() || !line.result?.trim()) continue;
          run(`INSERT INTO cases (key, head_sig, sig, change, impact, action, result, written_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(key) DO UPDATE SET head_sig = excluded.head_sig, sig = excluded.sig, change = excluded.change, impact = excluded.impact, action = excluded.action, result = excluded.result, written_at = excluded.written_at`,
            b.base.key, b.head_sig, b.sig, phrase(line.change), phrase(line.impact), line.action?.trim() ? phrase(line.action) : null, phrase(line.result), nowIso());
          written++;
        }
      } catch (e) { errors.push((e as Error).message.slice(0, 200)); }
    }));
    const u = usage as Usage | null;
    // The same failure every cycle (no credit left, model not reachable) is logged once, not every three minutes.
    const failure = written ? null : (errors[0] ?? null);
    const repeated = failure !== null && failure === lastFailure;
    lastFailure = failure;
    if ((written || errors.length) && !repeated) {
      logEvent({ actor: "action_agent", action: written ? "cases.written" : "cases.failed", run_id: runId,
        summary: written ? `I wrote the line of ${written} ${written === 1 ? "case" : "cases"} for the Agents page.${errors.length ? ` ${errors.length} calls failed.` : ""}` : `I could not write the lines for the Agents page: ${errors[0]}`,
        output: { written, left: stale.length - written, errors }, model: u?.model ?? null, tokens_in: u?.tokens_in ?? null, tokens_out: u?.tokens_out ?? null, cost_usd: u?.cost_usd ?? null });
    }
    return { written, left: stale.length - written };
  } finally {
    writing = false;
  }
}
