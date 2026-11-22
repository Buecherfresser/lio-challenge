import type { AgentQuestion } from "../../shared/api.ts";
import { all, get, run, tx } from "../db.ts";
import { now, nowIso } from "../clock.ts";
import { logEvent } from "../events.ts";
import { fmtTime, settings } from "../compute/settings.ts";
import { loadSnapshot } from "../compute/state.ts";
import { runDataAgent } from "./data/index.ts";
import { assigneeFor, loadRoles, replyBy } from "./data/people.ts";
import type { IssueDb } from "./data/rows.ts";

// Questions the action agent asks a supplier or a colleague, per risk.
// A mail is not a tool call: it costs the other side attention. So three rules are enforced here, in code:
//   1. Asking does not send. A question to a supplier is stored as an issue, next to the data agent's own questions.
//      The data agent's clarification round then writes one mail per supplier with all of them.
//   2. The same thing is not asked twice, by either agent. A question that is out or answered is refused, with the answer.
//   3. One reminder. After that the matter goes on inside the company, not in a third mail.
// A question asks. It never orders, accepts or books: anything that binds the company is a decision card.

export const TOPICS = ["quantity", "date", "price", "availability", "confirmation", "status", "other"] as const;
export type Topic = (typeof TOPICS)[number];
/** The issue types the data agent uses. A topic it has no type for is "other". */
const ISSUE_TYPE: Record<Topic, string> = { quantity: "quantity", date: "date_eta", price: "price", availability: "other", confirmation: "other", status: "other", other: "other" };
const OBJECT_TYPES = ["po_line", "shipment", "lot", "part", "supplier"];

export interface QuestionDb {
  id: number; risk_id: number; recipient: string; supplier_id: string | null; role: string | null; person: string | null;
  topic: Topic; object_type: string | null; object_id: string | null; part_id: string | null; text: string; background: string | null; answer_by: string | null;
  status: AgentQuestion["status"]; reminder_of: number | null; reminded: number; issue_id: number | null; message_id: number | null; answer_message_id: number | null; task_id: number | null;
  dedupe_key: string; created_at: string; sent_at: string | null; answered_at: string | null;
}

export interface AskInput {
  risk_id: number;
  to: "supplier" | "role";
  supplier_id: string | null;
  role: string | null;
  topic: Topic;
  object_type: string | null;   // po_line | shipment | lot | part | supplier
  object_id: string | null;
  part_id: string | null;
  subject: string;              // a few words: what the question is about
  question: string;
  background: string | null;
  reminder_of: number | null;
}
export type AskResult = { accepted: true; question_id: number; note: string } | { accepted: false; reason: string; earlier?: { question_id: number | null; status: string; asked_at: string; answer: string | null } };

const overdue = (q: QuestionDb, at = now().getTime()) => q.status === "sent" && !!q.answer_by && new Date(q.answer_by).getTime() < at;
const say = (iso: string | null) => (iso ? fmtTime(new Date(iso).getTime()) : "soon");
const supplierName = (id: string | null) => (id ? (get<{ name: string }>("SELECT name FROM suppliers WHERE supplier_id = ?", id)?.name ?? id) : "the supplier");

/** What the other side wrote back to an issue: the mail the data agent marked as its answer, in English. */
function answerOfIssue(issueId: number): string | null {
  return get<{ body_en: string }>("SELECT m.body_en FROM messages m, json_each(m.issue_ids) j WHERE m.direction = 'in' AND j.value = ? ORDER BY m.id DESC LIMIT 1", issueId)?.body_en.slice(0, 1500) ?? null;
}
function answerText(q: QuestionDb): string | null {
  if (q.issue_id) return answerOfIssue(q.issue_id);
  if (q.task_id && q.status === "answered") {
    const answer = get<{ answer: string | null }>("SELECT answer FROM tasks WHERE id = ?", q.task_id)?.answer;
    return answer ? `The colleague answered: ${answer.slice(0, 1500)}` : "The colleague marked the task as done.";
  }
  return null;
}

/** Take a question in. It is checked and stored. Nothing is mailed here. */
export function askQuestion(a: AskInput, runId: string): AskResult {
  const text = a.question?.trim() ?? "";
  if (text.length < 10) return { accepted: false, reason: "The question is empty or too short to answer." };
  if (!TOPICS.includes(a.topic)) return { accepted: false, reason: `topic must be one of ${TOPICS.join(", ")}.` };
  const subject = a.subject?.trim() || text.slice(0, 80);
  return a.to === "supplier" ? askSupplier(a, text, subject, runId) : askColleague(a, text, subject, runId);
}

function askSupplier(a: AskInput, text: string, subject: string, runId: string): AskResult {
  const s = a.supplier_id ? loadSnapshot().suppliers.get(a.supplier_id) : undefined;
  if (!s) return { accepted: false, reason: `${a.supplier_id ?? "null"} is not a supplier on file.` };
  const name = s.name ?? s.supplier_id;
  const objectType = a.object_type && a.object_id && OBJECT_TYPES.includes(a.object_type) ? a.object_type : a.part_id ? "part" : "supplier";
  const objectId = objectType === a.object_type ? a.object_id! : a.part_id ?? s.supplier_id;
  const type = ISSUE_TYPE[a.topic];
  // The same key the data agent uses for its own questions, so the two agents never ask the same thing twice.
  const key = `ask:${objectType}:${objectId}:${a.part_id ?? ""}:${type}:supplier${type === "other" ? `:${a.topic}` : ""}`;
  const old = get<IssueDb>("SELECT * FROM issues WHERE dedupe_key = ?", key);
  const mine = old ? get<QuestionDb>("SELECT * FROM questions WHERE issue_id = ? AND risk_id = ? ORDER BY id DESC LIMIT 1", old.id, a.risk_id) : undefined;
  const by = replyBy();
  const link = (issueId: number, status: QuestionDb["status"]): number => mine?.id ?? run(
    `INSERT INTO questions (risk_id, recipient, supplier_id, topic, object_type, object_id, part_id, text, background, answer_by, status, issue_id, dedupe_key, created_at, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    a.risk_id, `supplier:${s.supplier_id}`, s.supplier_id, a.topic, objectType, objectId, a.part_id, text, a.background?.trim() || null, by, status, issueId, key, nowIso(), status === "sent" ? nowIso() : null).lastId;

  // A reminder: once, when the answer is overdue.
  if (a.reminder_of !== null && a.reminder_of !== undefined) {
    const q = get<QuestionDb>("SELECT * FROM questions WHERE id = ?", a.reminder_of);
    if (!q || q.supplier_id !== s.supplier_id || !q.issue_id) return { accepted: false, reason: `Question ${a.reminder_of} was not put to ${name}.` };
    if (q.reminded) return { accepted: false, reason: `${name} was already reminded of question ${q.id}. There is one reminder. Take it up inside the company now: a task for the responsible role, or a decision that does not depend on the answer.` };
    if (!overdue(q)) return { accepted: false, reason: `Question ${q.id} is ${q.status} and the answer is due ${say(q.answer_by)}. A reminder is for an overdue answer.` };
    tx(() => {
      run("UPDATE issues SET status = 'open', question = ?, detail = ?, updated_at = ? WHERE id = ?", text, `Reminder. This was asked on ${say(q.sent_at ?? q.created_at)} and has not been answered. ${a.background?.trim() ?? ""}`.trim(), nowIso(), q.issue_id);
      run("UPDATE questions SET reminded = 1, status = 'queued', answer_by = ?, text = ? WHERE id = ?", by, text, q.id);
    });
    logEvent({ actor: "action_agent", action: "question.reminder", run_id: runId, object: { type: "risk", id: String(a.risk_id) }, summary: `I noted one reminder for ${name} about "${subject}". It goes out with the next mail to them.`, input: a, output: { question_id: q.id, issue_id: q.issue_id, answer_by: by } });
    return { accepted: true, question_id: q.id, note: `The reminder goes out with the next mail to ${name}. The answer is due ${say(by)}. This was the one reminder.` };
  }

  if (old && old.status !== "resolved") {
    const asker = old.created_by === "action_agent" ? "You" : "The data agent";
    const linked = link(old.id, old.status === "open" ? "queued" : old.status === "asked" ? "sent" : "answered");
    const why = old.status === "answered" ? `${name} already answered this. Read the answer instead of asking again.`
      : old.status === "open" ? `${asker} already ${asker === "You" ? "have" : "has"} this question collected for the next mail to ${name}. You are told when the answer is in.`
      : `${asker} already asked ${name} this on ${say(old.updated_at)}. Wait for the answer. You are told when it is in or overdue.`;
    return { accepted: false, reason: why, earlier: { question_id: linked, status: old.status, asked_at: old.updated_at, answer: old.status === "answered" ? answerOfIssue(old.id) : null } };
  }

  const id = tx(() => {
    const background = a.background?.trim() || subject;
    const issueId = old
      ? (run("UPDATE issues SET status = 'open', note = NULL, title = ?, detail = ?, question = ?, supplier_id = ?, part_id = ?, addressee = 'supplier', updated_at = ? WHERE id = ?", subject, background, text, s.supplier_id, a.part_id, nowIso(), old.id), old.id)
      : run(`INSERT INTO issues (dedupe_key, type, status, title, detail, object_type, object_id, part_id, supplier_id, addressee, question, fact_ids, created_by, created_at, updated_at)
             VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, 'supplier', ?, '[]', 'action_agent', ?, ?)`, key, type, subject, background, objectType, objectId, a.part_id, s.supplier_id, text, nowIso(), nowIso()).lastId;
    return run(
      `INSERT INTO questions (risk_id, recipient, supplier_id, topic, object_type, object_id, part_id, text, background, answer_by, status, issue_id, dedupe_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      a.risk_id, `supplier:${s.supplier_id}`, s.supplier_id, a.topic, objectType, objectId, a.part_id, text, a.background?.trim() || null, by, issueId, key, nowIso()).lastId;
  });
  logEvent({ actor: "action_agent", action: "question.asked", run_id: runId, object: { type: "risk", id: String(a.risk_id) }, summary: `I noted a question for ${name}: "${subject}". It goes out in one mail with everything else that is open for them.`, input: a, output: { question_id: id, answer_by: by } });
  return { accepted: true, question_id: id, note: `Collected for one mail to ${name}, which leaves when you are done. The answer is due ${say(by)}.` };
}

function askColleague(a: AskInput, text: string, subject: string, runId: string): AskResult {
  const roles = loadRoles();
  const title = [...roles.keys()].find((t) => t.toLowerCase() === (a.role ?? "").trim().toLowerCase());
  if (!title) return { accepted: false, reason: `"${a.role ?? ""}" is not a role on the organisation chart. Use one of: ${[...roles.keys()].join(", ") || "none on file"}.` };
  // If the seat is empty, the deputy or the next one up the line gets it.
  const who = assigneeFor(title, roles);
  const name = who.person ?? who.role;
  const key = `role:${who.role}|${a.object_type ?? "part"}:${a.object_id ?? a.part_id ?? "-"}|${a.topic}`;
  const earlier = get<QuestionDb>("SELECT * FROM questions WHERE dedupe_key = ? AND status != 'dropped' ORDER BY id DESC LIMIT 1", key);
  if (earlier) {
    return { accepted: false, reason: earlier.status === "answered" ? `${name} already dealt with this.` : `${name} already has this as a task since ${say(earlier.created_at)}. A colleague is not asked twice.`,
      earlier: { question_id: earlier.id, status: earlier.status, asked_at: earlier.created_at, answer: answerText(earlier) } };
  }
  const by = new Date(Math.min(now().getTime() + settings.answerHours * 3_600_000, loadSnapshot().deadline)).toISOString();
  const id = tx(() => {
    const body = [text, a.background?.trim(), who.note, `Please answer by ${say(by)}.`].filter(Boolean).join("\n\n");
    const taskId = run("INSERT INTO tasks (status, role, person, title, body, issue_id, object_type, object_id, created_by, created_at) VALUES ('open', ?, ?, ?, ?, NULL, ?, ?, 'action_agent', ?)",
      who.role, who.person, subject, body, a.object_type ?? (a.part_id ? "part" : null), a.object_id ?? a.part_id ?? null, nowIso()).lastId;
    return run(
      `INSERT INTO questions (risk_id, recipient, role, person, topic, object_type, object_id, part_id, text, background, answer_by, status, task_id, dedupe_key, created_at, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?, ?)`,
      a.risk_id, `role:${who.role}`, who.role, who.person, a.topic, a.object_type, a.object_id, a.part_id, text, a.background?.trim() || null, by, taskId, key, nowIso(), nowIso()).lastId;
  });
  logEvent({ actor: "action_agent", action: "question.asked", run_id: runId, object: { type: "risk", id: String(a.risk_id) }, summary: `I gave ${name} a task: "${subject}".${who.note ? ` ${who.note}` : ""}`, input: a, output: { question_id: id, answer_by: by }, fact_ids: who.fact_ids });
  return { accepted: true, question_id: id, note: `${name} has it as a task, with the answer due ${say(by)}.${who.note ? ` ${who.note}` : ""}` };
}

/**
 * Send what was collected. The data agent writes the mails: one per supplier, with its own open questions and the
 * action agent's in the same mail. It holds them back while documents of an update are still unread, so a supplier
 * is never asked about something the next document already answers.
 */
export async function flushQuestions(runId: string): Promise<{ mails: number; questions: number }> {
  const waiting = get<{ n: number }>("SELECT COUNT(*) AS n FROM questions WHERE status = 'queued' AND issue_id IS NOT NULL")?.n ?? 0;
  if (!waiting) return { mails: 0, questions: 0 };
  const res = await runDataAgent({ runId, limit: 0 });
  refreshQuestions();
  const still = get<{ n: number }>("SELECT COUNT(*) AS n FROM questions WHERE status = 'queued' AND issue_id IS NOT NULL")?.n ?? 0;
  if (still) logEvent({ actor: "action_agent", action: "questions.waiting", run_id: runId, summary: `${still} of my questions for suppliers still wait. They go out with the data agent's next round of mails.` });
  return { mails: res.mails_drafted, questions: waiting - still };
}

/** Bring the questions up to date with what happened to their issue or task, and give up on a reminder that went unanswered. */
export function refreshQuestions(): { answered: number; given_up: number } {
  let answered = 0, givenUp = 0;
  const at = now().getTime();
  for (const q of all<QuestionDb>("SELECT * FROM questions WHERE status IN ('queued', 'sent', 'no_answer')")) {
    if (q.task_id) {
      const t = get<{ status: string; done_at: string | null }>("SELECT status, done_at FROM tasks WHERE id = ?", q.task_id);
      if (t?.status === "done") { run("UPDATE questions SET status = 'answered', answered_at = ? WHERE id = ?", t.done_at ?? nowIso(), q.id); answered++; }
      continue;
    }
    const issue = q.issue_id ? get<IssueDb>("SELECT * FROM issues WHERE id = ?", q.issue_id) : undefined;
    if (!issue) continue;
    if (issue.status === "answered" || (issue.status === "resolved" && !issue.note?.startsWith("dismissed"))) {
      run("UPDATE questions SET status = 'answered', answered_at = ? WHERE id = ?", issue.updated_at, q.id); answered++;
    } else if (issue.status === "resolved") {
      run("UPDATE questions SET status = 'dropped' WHERE id = ?", q.id);
    } else if (issue.status === "asked" && q.status === "queued") {
      run("UPDATE questions SET status = 'sent', sent_at = ? WHERE id = ?", issue.updated_at, q.id);
    } else if (issue.status === "asked" && q.status === "sent" && q.reminded && q.answer_by && new Date(q.answer_by).getTime() < at) {
      // The reminder went unanswered too. That closes the matter with this recipient.
      run("UPDATE questions SET status = 'no_answer' WHERE id = ?", q.id); givenUp++;
    }
  }
  return { answered, given_up: givenUp };
}

const nameOf = (q: QuestionDb): string => q.person ?? q.role ?? supplierName(q.supplier_id);

export const toAgentQuestion = (q: QuestionDb): AgentQuestion => ({
  id: q.id, risk_id: q.risk_id, to: nameOf(q), supplier_id: q.supplier_id, role: q.role, text: q.text, status: q.status, answer_by: q.answer_by, sent_at: q.sent_at, answered_at: q.answered_at,
});
export const questionRows = (riskId?: number): QuestionDb[] =>
  riskId === undefined ? all<QuestionDb>("SELECT * FROM questions WHERE status != 'dropped' ORDER BY id") : all<QuestionDb>("SELECT * FROM questions WHERE risk_id = ? AND status != 'dropped' ORDER BY id", riskId);

/** The questions of one risk as the agent sees them at the start of a run. */
export function questionsForAgent(riskId: number) {
  return questionRows(riskId).map((q) => ({
    question_id: q.id, to: nameOf(q), supplier_id: q.supplier_id, role: q.role, topic: q.topic, about: q.object_type && q.object_id ? `${q.object_type}:${q.object_id}` : q.part_id, question: q.text,
    status: overdue(q) ? "sent, answer overdue" : q.status, asked: q.created_at, answer_due: q.answer_by, reminded_once: Boolean(q.reminded), answer: q.status === "answered" ? answerText(q) : null,
  }));
}

/** The last mails exchanged with a supplier, oldest first, in English. */
export function threadForAgent(supplierId: string, limit = 8) {
  return all<{ id: number; direction: string; status: string; subject: string; body_en: string; created_by: string; at: string }>(
    "SELECT id, direction, status, subject, body_en, created_by, COALESCE(sent_at, created_at) AS at FROM messages WHERE thread_id = ? AND status != 'rejected' ORDER BY id DESC LIMIT ?", `supplier:${supplierId}`, limit)
    .reverse().map((m) => ({ message_id: m.id, from: m.direction === "in" ? "supplier" : "us", written_by: m.direction === "in" ? null : m.created_by, status: m.status, at: m.at, subject: m.subject, text: m.body_en.slice(0, 3000) }));
}

/** Mails about one risk with one supplier, counted for the decision report: those that carry one of the risk's questions. */
export function contactCounts(riskId: number, supplierId: string | null): { sent: number; received: number } {
  if (!supplierId) return { sent: 0, received: 0 };
  const ids = all<{ issue_id: number }>("SELECT DISTINCT issue_id FROM questions WHERE risk_id = ? AND supplier_id = ? AND issue_id IS NOT NULL", riskId, supplierId).map((r) => r.issue_id);
  if (!ids.length) return { sent: 0, received: 0 };
  const count = (where: string) => get<{ n: number }>(`SELECT COUNT(DISTINCT m.id) AS n FROM messages m, json_each(m.issue_ids) j WHERE ${where} AND j.value IN (${ids.map(() => "?").join(",")})`, ...ids)?.n ?? 0;
  return { sent: count("m.direction = 'out' AND m.status IN ('sent', 'outbox')"), received: count("m.direction = 'in'") };
}

/** Changes when something about the questions of a risk changed, or when an answer became overdue. */
export function questionSignature(riskId: number): string {
  return questionRows(riskId).map((q) => `${q.id}:${overdue(q) ? "overdue" : q.status}:${q.reminded}`).join(",");
}

/** Who the agent waits for on a risk, the nearest due date first. */
export function waitingOn(riskId: number): { name: string; kind: "supplier" | "person"; until: string | null } | null {
  const open = questionRows(riskId).filter((q) => q.status === "sent" || q.status === "queued").sort((a, b) => (a.answer_by ?? "9").localeCompare(b.answer_by ?? "9"));
  return open.length ? { name: nameOf(open[0]), kind: open[0].supplier_id ? "supplier" : "person", until: open[0].answer_by } : null;
}
