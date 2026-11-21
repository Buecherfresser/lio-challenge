import type { AgentQuestion } from "../../shared/api.ts";
import { config } from "../config.ts";
import { all, get, run, tx } from "../db.ts";
import { now, nowIso } from "../clock.ts";
import { logEvent } from "../events.ts";
import { addUsage, llmAvailable, obj, prompt, str, structured, withStyle } from "../llm.ts";
import type { Usage } from "../llm.ts";
import { fmtTime, settings } from "../compute/settings.ts";
import { loadSnapshot } from "../compute/state.ts";

// Questions the action agent asks a supplier or a colleague.
// A mail is not a tool call: it costs the other side attention. So three rules are enforced here, in code:
//   1. Asking does not send. Questions are collected per recipient and leave as one mail when the agent is done.
//   2. The same thing is not asked twice. A question that is already out, or already answered, is refused.
//   3. One reminder. After that the matter goes on inside the company, not in a third mail.
// A question asks. It never orders, accepts or books: anything that binds the company is a decision card.

export const TOPICS = ["quantity", "date", "price", "availability", "confirmation", "status", "other"] as const;
export type Topic = (typeof TOPICS)[number];

export interface QuestionDb {
  id: number; risk_id: number; recipient: string; supplier_id: string | null; role: string | null; person: string | null;
  topic: Topic; object_type: string | null; object_id: string | null; part_id: string | null; text: string; background: string | null; answer_by: string | null;
  status: AgentQuestion["status"]; reminder_of: number | null; reminded: number; message_id: number | null; answer_message_id: number | null; task_id: number | null;
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
  answer_within_hours: number | null;
  reminder_of: number | null;
}
export type AskResult = { accepted: true; question_id: number; note: string } | { accepted: false; reason: string; earlier?: { question_id: number; status: string; asked_at: string; answer: string | null } };

const VACANT = /^(vacant|tbd|n\/?a|open|unfilled|none|-|—|\?)?$/i;
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const overdue = (q: QuestionDb, at = now().getTime()) => q.status === "sent" && !!q.answer_by && new Date(q.answer_by).getTime() < at;

function answerText(q: QuestionDb): string | null {
  if (q.answer_message_id) return get<{ body_en: string }>("SELECT body_en FROM messages WHERE id = ?", q.answer_message_id)?.body_en.slice(0, 1500) ?? null;
  if (q.task_id) return "The colleague marked the task as done.";
  return null;
}

/** Take a question in. It is checked, stored, and for a colleague turned into a task at once. Nothing is mailed here. */
export function askQuestion(a: AskInput, runId: string): AskResult {
  const snap = loadSnapshot();
  const text = a.question?.trim() ?? "";
  if (text.length < 10) return { accepted: false, reason: "The question is empty or too short to answer." };
  if (!TOPICS.includes(a.topic)) return { accepted: false, reason: `topic must be one of ${TOPICS.join(", ")}.` };

  let recipient: string, supplierId: string | null = null, role: string | null = null, person: string | null = null, name: string;
  if (a.to === "supplier") {
    const s = a.supplier_id ? snap.suppliers.get(a.supplier_id) : undefined;
    if (!s) return { accepted: false, reason: `${a.supplier_id ?? "null"} is not a supplier on file.` };
    supplierId = s.supplier_id; recipient = `supplier:${s.supplier_id}`; name = s.name ?? s.supplier_id;
  } else {
    const titles = [...new Set(snap.fx.ofField("role", "person").map((f) => f.object_id))];
    const title = titles.find((t) => t.toLowerCase() === (a.role ?? "").trim().toLowerCase());
    if (!title) return { accepted: false, reason: `"${a.role ?? ""}" is not a role on the organisation chart. Use one of: ${titles.join(", ") || "none on file"}.` };
    const p = snap.fx.val("role", title, "person")?.trim() ?? "";
    role = title; person = VACANT.test(p) ? null : p; recipient = `role:${title}`; name = person ?? title;
  }

  // A reminder: allowed once, when the answer is overdue or the reply did not cover the question.
  let original: QuestionDb | undefined;
  if (a.reminder_of !== null && a.reminder_of !== undefined) {
    original = get<QuestionDb>("SELECT * FROM questions WHERE id = ?", a.reminder_of);
    if (!original || original.recipient !== recipient) return { accepted: false, reason: `Question ${a.reminder_of} was not put to ${name}.` };
    if (original.reminded) return { accepted: false, reason: `${name} was already reminded of question ${original.id}. There is one reminder. Take it up inside the company now: a task for the responsible role, or a decision card.` };
    if (!(overdue(original) || original.status === "answered")) return { accepted: false, reason: `Question ${original.id} is ${original.status}${original.answer_by ? ` and the answer is due ${fmtTime(new Date(original.answer_by).getTime())}` : ""}. A reminder is for an overdue answer, or for a reply that left the question open.` };
  }

  const target = a.object_type && a.object_id ? `${a.object_type}:${a.object_id}` : a.part_id ? `part:${a.part_id}` : `text:${norm(text).slice(0, 80)}`;
  const key = `${recipient}|${target}|${a.topic}`;
  if (!original) {
    const earlier = get<QuestionDb>("SELECT * FROM questions WHERE dedupe_key = ? AND status != 'dropped' ORDER BY id DESC LIMIT 1", key);
    if (earlier) {
      const asked = fmtTime(new Date(earlier.created_at).getTime());
      const why = earlier.status === "answered" ? `${name} already answered this. Read the answer instead of asking again.`
        : earlier.status === "no_answer" ? `${name} was asked this and reminded once, and did not answer. Do not ask again. Take it up inside the company.`
        : earlier.status === "queued" ? `This question is already collected for the next mail to ${name}.`
        : `${name} was already asked this on ${asked}${earlier.answer_by ? `, with the answer due ${fmtTime(new Date(earlier.answer_by).getTime())}` : ""}. Wait for the answer. If it is overdue, send the one reminder (reminder_of: ${earlier.id}).`;
      return { accepted: false, reason: why, earlier: { question_id: earlier.id, status: overdue(earlier) ? "sent, answer overdue" : earlier.status, asked_at: earlier.created_at, answer: answerText(earlier) } };
    }
  }

  const hours = a.answer_within_hours && a.answer_within_hours > 0 ? a.answer_within_hours : settings.answerHours;
  const answerBy = new Date(Math.min(now().getTime() + hours * 3_600_000, snap.deadline)).toISOString();
  const subject = a.subject?.trim() || text.slice(0, 80);
  const id = tx(() => {
    if (original) run("UPDATE questions SET reminded = 1 WHERE id = ?", original.id);
    let taskId: number | null = null;
    if (a.to === "role") {
      // A colleague has no mail address on the organisation chart. The question reaches them as a task in the dashboard.
      taskId = run("INSERT INTO tasks (status, role, person, title, body, issue_id, object_type, object_id, created_by, created_at) VALUES ('open', ?, ?, ?, ?, NULL, ?, ?, 'action_agent', ?)",
        role, person, subject, `${text}${a.background?.trim() ? `\n\n${a.background.trim()}` : ""}\n\nPlease answer by ${fmtTime(new Date(answerBy).getTime())}.`, a.object_type ?? (a.part_id ? "part" : null), a.object_id ?? a.part_id ?? null, nowIso()).lastId;
    }
    return run(
      `INSERT INTO questions (risk_id, recipient, supplier_id, role, person, topic, object_type, object_id, part_id, text, background, answer_by, status, reminder_of, task_id, dedupe_key, created_at, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      a.risk_id, recipient, supplierId, role, person, a.topic, a.object_type, a.object_id, a.part_id, text, a.background?.trim() || null, answerBy, a.to === "role" ? "sent" : "queued",
      original?.id ?? null, taskId, original ? `${key}|reminder:${original.id}` : key, nowIso(), a.to === "role" ? nowIso() : null).lastId;
  });
  logEvent({ actor: "action_agent", action: original ? "question.reminder" : "question.asked", run_id: runId, object: { type: "risk", id: String(a.risk_id) },
    summary: a.to === "role" ? `I gave ${name} a task: "${subject}".` : original ? `I noted one reminder for ${name} about "${subject}". It goes out with my next mail to them.` : `I noted a question for ${name}: "${subject}". It goes out with my next mail to them.`,
    input: a, output: { question_id: id, answer_by: answerBy } });
  return { accepted: true, question_id: id, note: a.to === "role" ? `${name} has it as a task, with the answer due ${fmtTime(new Date(answerBy).getTime())}.` : `Collected for one mail to ${name}, which leaves when you are done. The answer is due ${fmtTime(new Date(answerBy).getTime())}.` };
}

const mailSchema = obj({ subject: str("in the supplier's language"), body: str("the mail in the supplier's language, plain text"), subject_en: str(), body_en: str("the same mail in English") });

/**
 * Send what was collected: one mail per supplier with all its questions, written in the supplier's language.
 * Whether it leaves without a click is the same switch as for the data agent's questions (AUTO_SEND_CLARIFICATIONS).
 */
export async function flushQuestions(runId: string): Promise<{ mails: number; questions: number; usage: Usage | null }> {
  const queued = all<QuestionDb>("SELECT * FROM questions WHERE status = 'queued' AND supplier_id IS NOT NULL ORDER BY id");
  if (!queued.length || !llmAvailable()) return { mails: 0, questions: 0, usage: null };
  const snap = loadSnapshot();
  let mails = 0, count = 0;
  let usage: Usage | null = null as Usage | null;
  for (const supplierId of [...new Set(queued.map((q) => q.supplier_id!))]) {
    const qs = queued.filter((q) => q.supplier_id === supplierId);
    const s = snap.suppliers.get(supplierId);
    if (!s) { run(`UPDATE questions SET status = 'dropped' WHERE id IN (${qs.map(() => "?").join(",")})`, ...qs.map((q) => q.id)); continue; }
    const language = (snap.fx.val("supplier", supplierId, "language") ?? s.language ?? "en").toLowerCase().slice(0, 2);
    const to = snap.fx.val("supplier", supplierId, "contact_email") ?? s.contact_email ?? "";
    const answerBy = Math.min(...qs.map((q) => (q.answer_by ? new Date(q.answer_by).getTime() : snap.deadline)));
    try {
      const res = await structured<{ subject: string; body: string; subject_en: string; body_en: string }>({
        model: config.openai.modelAgent,
        system: withStyle(prompt("data_mail.md")),
        user: JSON.stringify({
          supplier: { name: s.name, contact_person: s.contact_name ?? null }, language, sender: config.mail.fromName,
          now: fmtTime(snap.now), launch_deadline: fmtTime(snap.deadline), answer_needed_by: `${fmtTime(answerBy)} (UTC${settings.localUtcOffset})`,
          questions: qs.map((q) => ({ question: q.text, about: q.object_type && q.object_id ? `${q.object_type.replace("_", " ")} ${q.object_id}` : q.part_id, background: q.background, is_a_reminder: q.reminder_of !== null })),
        }),
        schemaName: "supplier_mail", schema: mailSchema,
      });
      usage = usage ? addUsage(usage, res.usage) : res.usage;
      const messageId = tx(() => {
        const id = run(
          `INSERT INTO messages (thread_id, direction, status, from_addr, to_addr, subject, language, body_original, body_en, supplier_id, person, created_by, issue_ids, created_at)
           VALUES (?, 'out', 'needs_approval', ?, ?, ?, ?, ?, ?, ?, NULL, 'action_agent', '[]', ?)`,
          `supplier:${supplierId}`, config.mail.from, to, res.data.subject.trim(), language, res.data.body, res.data.body_en || res.data.body, supplierId, nowIso()).lastId;
        run(`UPDATE questions SET status = 'sent', message_id = ?, sent_at = ? WHERE id IN (${qs.map(() => "?").join(",")})`, id, nowIso(), ...qs.map((q) => q.id));
        return id;
      });
      mails++; count += qs.length;
      let sent = false, problem: string | null = null;
      if (config.mail.autoSendClarifications) {
        try {
          // The mail module is loaded when it is needed, as in the rest of the app.
          const path = "../mail/transport.ts";
          const mod = (await import(path)) as { sendMessage?: (messageId: number, by: string) => unknown };
          if (!mod.sendMessage) throw new Error("the mail module has no sendMessage");
          await mod.sendMessage(messageId, "action_agent");
          sent = true;
        } catch (e) { problem = (e as Error).message; }
      }
      logEvent({ actor: "action_agent", action: "mail.questions", run_id: runId, object: { type: "message", id: String(messageId), label: res.data.subject_en || res.data.subject },
        summary: `I wrote one mail to ${s.name ?? supplierId} with ${qs.length} question${qs.length === 1 ? "" : "s"}${sent ? " and sent it" : problem ? `. It waits in the inbox because sending failed: ${problem}` : ". It waits in the inbox for a click"}.`,
        input: { supplier_id: supplierId, question_ids: qs.map((q) => q.id), language }, output: { message_id: messageId, sent, problem },
        model: res.usage.model, tokens_in: res.usage.tokens_in, tokens_out: res.usage.tokens_out, cost_usd: res.usage.cost_usd });
    } catch (e) {
      logEvent({ actor: "action_agent", action: "mail.questions_failed", run_id: runId, summary: `I could not write the mail to ${s.name ?? supplierId}, so its ${qs.length} question${qs.length === 1 ? " stays" : "s stay"} collected: ${(e as Error).message}` });
    }
  }
  return { mails, questions: count, usage };
}

/** Bring the questions up to date: which were answered, which are past their one reminder. */
export function refreshQuestions(): { answered: number; given_up: number } {
  let answered = 0, givenUp = 0;
  const at = now().getTime();
  for (const q of all<QuestionDb>("SELECT * FROM questions WHERE status = 'sent'")) {
    if (q.task_id) {
      const t = get<{ status: string; done_at: string | null }>("SELECT status, done_at FROM tasks WHERE id = ?", q.task_id);
      if (t?.status === "done") { run("UPDATE questions SET status = 'answered', answered_at = ? WHERE id = ?", t.done_at ?? nowIso(), q.id); answered++; }
    } else if (q.message_id && q.supplier_id) {
      // A reply counts once the other side wrote in the same thread after our mail.
      const reply = get<{ id: number; at: string }>("SELECT id, COALESCE(sent_at, created_at) AS at FROM messages WHERE thread_id = ? AND direction = 'in' AND id > ? ORDER BY id LIMIT 1", `supplier:${q.supplier_id}`, q.message_id);
      if (reply) { run("UPDATE questions SET status = 'answered', answer_message_id = ?, answered_at = ? WHERE id = ?", reply.id, reply.at, q.id); answered++; }
    }
  }
  // A reminder that also went unanswered closes the matter with this recipient.
  for (const r of all<QuestionDb>("SELECT * FROM questions WHERE status = 'sent' AND reminder_of IS NOT NULL")) {
    if (!overdue(r, at)) continue;
    run("UPDATE questions SET status = 'no_answer' WHERE id IN (?, ?) AND status = 'sent'", r.id, r.reminder_of);
    givenUp++;
  }
  return { answered, given_up: givenUp };
}

const nameOf = (q: QuestionDb): string => q.person ?? q.role ?? get<{ name: string }>("SELECT name FROM suppliers WHERE supplier_id = ?", q.supplier_id)?.name ?? q.supplier_id ?? q.recipient;

export const toAgentQuestion = (q: QuestionDb): AgentQuestion => ({
  id: q.id, risk_id: q.risk_id, to: nameOf(q), supplier_id: q.supplier_id, role: q.role, text: q.text, status: q.status, answer_by: q.answer_by, sent_at: q.sent_at, answered_at: q.answered_at,
});
export const questionRows = (riskId?: number): QuestionDb[] =>
  riskId === undefined ? all<QuestionDb>("SELECT * FROM questions WHERE status != 'dropped' ORDER BY id") : all<QuestionDb>("SELECT * FROM questions WHERE risk_id = ? AND status != 'dropped' ORDER BY id", riskId);

/** The questions of one risk as the agent sees them at the start of a run. */
export function questionsForAgent(riskId: number) {
  return questionRows(riskId).map((q) => ({
    question_id: q.id, to: nameOf(q), supplier_id: q.supplier_id, role: q.role, topic: q.topic, about: q.object_type && q.object_id ? `${q.object_type}:${q.object_id}` : q.part_id, question: q.text,
    status: overdue(q) ? "sent, answer overdue" : q.status, asked: q.created_at, answer_due: q.answer_by, reminded_once: Boolean(q.reminded), is_reminder_of: q.reminder_of, answer: q.status === "answered" ? answerText(q) : null,
  }));
}

/** The last mails exchanged with a supplier, oldest first, in English. */
export function threadForAgent(supplierId: string, limit = 8) {
  return all<{ id: number; direction: string; status: string; subject: string; body_en: string; created_by: string; at: string }>(
    "SELECT id, direction, status, subject, body_en, created_by, COALESCE(sent_at, created_at) AS at FROM messages WHERE thread_id = ? AND status != 'rejected' ORDER BY id DESC LIMIT ?", `supplier:${supplierId}`, limit)
    .reverse().map((m) => ({ message_id: m.id, from: m.direction === "in" ? "supplier" : "us", written_by: m.direction === "in" ? null : m.created_by, status: m.status, at: m.at, subject: m.subject, text: m.body_en.slice(0, 3000) }));
}

/** Mails about one risk with one supplier, counted for the decision report. */
export function contactCounts(riskId: number, supplierId: string | null): { sent: number; received: number } {
  if (!supplierId) return { sent: 0, received: 0 };
  const r = get<{ s: number; r: number }>("SELECT COUNT(DISTINCT message_id) AS s, COUNT(DISTINCT answer_message_id) AS r FROM questions WHERE risk_id = ? AND supplier_id = ?", riskId, supplierId);
  return { sent: r?.s ?? 0, received: r?.r ?? 0 };
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
