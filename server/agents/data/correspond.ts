import { config } from "../../config.ts";
import { all, get, json, run, tx } from "../../db.ts";
import { now, nowIso } from "../../clock.ts";
import { logEvent } from "../../events.ts";
import { llmAvailable, obj, prompt, runAgent, str, withStyle } from "../../llm.ts";
import type { Tool } from "../../llm.ts";
import { sendMessage } from "../../mail/transport.ts";
import { knowledgeTools } from "./knowledge.ts";
import { assigneeFor, loadApprovalRules, loadRoles, replyBy } from "./people.ts";
import { sayDate } from "./rows.ts";
import type { IssueDb, MessageDb } from "./rows.ts";

// The second half of the data agent. It runs once all new sources of an update are read.
// It takes every open issue (from the rules and from the reading agent's questions) and decides in one round:
// one mail per supplier, one task per role at Soony, or no action. Code looks up people, languages and addresses.

export interface CorrespondResult { issues: number; mails: number; tasks: number; dismissed: number; left_open: number; sent: number }

const ints = { type: "array", items: { type: "integer" } };

export async function correspond(opts: { runId: string }): Promise<CorrespondResult> {
  const res: CorrespondResult = { issues: 0, mails: 0, tasks: 0, dismissed: 0, left_open: 0, sent: 0 };
  const open = all<IssueDb>("SELECT * FROM issues WHERE status = 'open' ORDER BY id");
  res.issues = open.length;
  if (!open.length) return res;
  if (!llmAvailable()) {
    logEvent({ actor: "data_agent", action: "issues.waiting", run_id: opts.runId, summary: `I have ${open.length} open issues nobody has been asked about, and without an OpenAI key I cannot write the questions.`, output: { issue_ids: open.map((i) => i.id) } });
    res.left_open = open.length;
    return res;
  }

  const openIds = new Set(open.map((i) => i.id));
  const handled = new Set<number>();
  const mails = new Map<string, number>();       // supplier -> message id written in this round
  const tasks = new Map<string, number>();       // role -> task id written in this round
  const year = now().getUTCFullYear();
  const by = replyBy();
  const stamp = nowIso();
  const take = (ids: number[]) => {
    const ok = [...new Set(ids)].filter((id) => openIds.has(id) && !handled.has(id));
    const bad = ids.filter((id) => !openIds.has(id));
    return { ok, bad };
  };

  const tools: Tool[] = [
    ...knowledgeTools({ source: null, runId: opts.runId }, { canWrite: false }),
    {
      name: "write_mail", description: "The mail to one supplier with all questions for it. Write it in the supplier's language, and the same mail in English. Calling it again for the same supplier replaces the draft.",
      parameters: obj({ supplier_id: str(), subject: str(), body: str("plain text"), subject_en: str(), body_en: str(), issue_ids: ints }),
      run: (a: { supplier_id: string; subject: string; body: string; subject_en: string; body_en: string; issue_ids: number[] }) => {
        const sup = get<{ supplier_id: string; name: string; contact_email: string | null; language: string | null }>("SELECT supplier_id, name, contact_email, language FROM suppliers WHERE supplier_id = ?", a.supplier_id);
        if (!sup) return { error: `unknown supplier ${a.supplier_id}` };
        if (!sup.contact_email) return { error: `no mail address on file for ${sup.name}` };
        const { ok, bad } = take(a.issue_ids ?? []);
        if (!a.subject.trim() || !a.body.trim()) return { error: "subject and body are required" };
        const language = (sup.language ?? "en").toLowerCase();
        const bodyEn = language === "en" ? a.body.trim() : `Subject: ${a.subject_en.trim()}\n\n${a.body_en.trim()}`;
        const threadId = `supplier:${sup.supplier_id}`;
        const id = tx(() => {
          // A draft that has not gone out yet is replaced, so a supplier never gets two mails from one round.
          const draft = get<MessageDb>("SELECT * FROM messages WHERE thread_id = ? AND direction = 'out' AND status = 'needs_approval' AND created_by = 'data_agent' AND decision_id IS NULL ORDER BY id DESC LIMIT 1", threadId);
          const ids = [...new Set([...(draft ? json<number[]>(draft.issue_ids, []) : []), ...ok])];
          const mid = draft
            ? (run("UPDATE messages SET subject = ?, language = ?, body_original = ?, body_en = ?, issue_ids = ?, to_addr = ? WHERE id = ?", a.subject.trim(), language, a.body.trim(), bodyEn, JSON.stringify(ids), sup.contact_email, draft.id), draft.id)
            : run(`INSERT INTO messages (thread_id, direction, status, from_addr, to_addr, subject, language, body_original, body_en, supplier_id, created_by, issue_ids, created_at)
                   VALUES (?, 'out', 'needs_approval', ?, ?, ?, ?, ?, ?, ?, 'data_agent', ?, ?)`, threadId, config.mail.from, sup.contact_email, a.subject.trim(), language, a.body.trim(), bodyEn, sup.supplier_id, JSON.stringify(ids), stamp).lastId;
          for (const i of ok) run("UPDATE issues SET status = 'asked', addressee = 'supplier', supplier_id = COALESCE(supplier_id, ?), updated_at = ? WHERE id = ?", sup.supplier_id, stamp, i);
          return mid;
        });
        ok.forEach((i) => handled.add(i));
        mails.set(sup.supplier_id, id);
        logEvent({ actor: "data_agent", action: "mail.drafted", run_id: opts.runId, object: { type: "message", id: String(id), label: sup.name },
          summary: `I wrote one mail to ${sup.name} in ${language} covering ${ok.length} ${ok.length === 1 ? "issue" : "issues"}, and it ${config.mail.autoSendClarifications ? "goes out now" : "waits for approval"}.`,
          input: { supplier_id: sup.supplier_id, to: sup.contact_email, language, answer_by: by, issue_ids: ok }, output: { message_id: id, subject: a.subject, body_original: a.body, body_en: bodyEn } });
        return { message_id: id, to: sup.contact_email, language, covers: ok, ...(bad.length ? { not_open: bad } : {}) };
      },
    },
    {
      name: "create_task", description: `A task for one role at ${config.customer.name}, covering one or more issues. A second call for the same role adds to the same task.`,
      parameters: obj({ role: str("role title as on the organisation chart"), title: str(), body: str(), issue_ids: ints }),
      run: (a: { role: string; title: string; body: string; issue_ids: number[] }) => {
        const { ok, bad } = take(a.issue_ids ?? []);
        if (!ok.length) return { error: "none of these issues is open", not_open: bad };
        const who = assigneeFor(a.role, loadRoles());
        const first = get<IssueDb>("SELECT * FROM issues WHERE id = ?", ok[0])!;
        const body = who.note ? `${a.body.trim()}\n\n${who.note}` : a.body.trim();
        const id = tx(() => {
          const existing = tasks.get(who.role);
          const tid = existing
            ? (run("UPDATE tasks SET body = body || ? WHERE id = ?", `\n\n${a.title.trim()}\n${body}`, existing), existing)
            : run("INSERT INTO tasks (status, role, person, title, body, issue_id, object_type, object_id, created_by, created_at) VALUES ('open', ?, ?, ?, ?, ?, ?, ?, 'data_agent', ?)",
                who.role, who.person, a.title.trim(), body, first.id, first.object_type, first.object_id, stamp).lastId;
          for (const i of ok) run("UPDATE issues SET status = 'asked', addressee = 'internal', assignee_role = ?, updated_at = ? WHERE id = ?", who.role, stamp, i);
          return tid;
        });
        ok.forEach((i) => handled.add(i));
        tasks.set(who.role, id);
        logEvent({ actor: "data_agent", action: "task.created", run_id: opts.runId, object: { type: "task", id: String(id), label: a.title },
          summary: `I gave ${who.person ?? who.role} a task: ${a.title.trim()}.`, input: { role: a.role, issue_ids: ok }, output: { task_id: id, person: who.person, note: who.note, body }, fact_ids: who.fact_ids });
        return { task_id: id, role: who.role, person: who.person, ...(who.note ? { note: who.note } : {}), covers: ok, ...(bad.length ? { not_open: bad } : {}) };
      },
    },
    {
      name: "dismiss", description: "Close issues that need nobody's action, with the reason.",
      parameters: obj({ issue_ids: ints, reason: str() }),
      run: (a: { issue_ids: number[]; reason: string }) => {
        const { ok, bad } = take(a.issue_ids ?? []);
        tx(() => { for (const i of ok) run("UPDATE issues SET status = 'resolved', note = ?, updated_at = ? WHERE id = ?", `dismissed: ${a.reason.trim()}`, stamp, i); });
        ok.forEach((i) => handled.add(i));
        for (const i of ok) {
          const x = get<IssueDb>("SELECT * FROM issues WHERE id = ?", i)!;
          logEvent({ actor: "data_agent", action: "issue.dismissed", run_id: opts.runId, object: { type: x.object_type as never, id: x.object_id }, summary: `I closed "${x.title}" without asking anyone: ${a.reason.trim()}`, output: { issue_id: i } });
        }
        return { closed: ok, ...(bad.length ? { not_open: bad } : {}) };
      },
    },
  ];

  const roles = [...loadRoles().values()];
  const rules = loadApprovalRules();
  const suppliers = all<{ supplier_id: string; name: string; contact_name: string | null; language: string | null }>("SELECT supplier_id, name, contact_name, language FROM suppliers ORDER BY supplier_id");
  const pendingAsk = all<IssueDb>("SELECT * FROM issues WHERE status = 'asked' ORDER BY id");
  const user = [
    `Now: ${sayDate(nowIso(), year)} (local time). Deadline: ${sayDate(config.deadline, year)}. ${config.customer.name} needs supplier answers by ${sayDate(by, year)} (local time).`,
    `Mails are signed by: ${config.mail.fromName}.`,
    `Suppliers (id | name | contact | language):\n${suppliers.map((s) => `${s.supplier_id} | ${s.name} | ${s.contact_name ?? "-"} | ${s.language ?? "en"}`).join("\n")}`,
    roles.length ? `Roles at ${config.customer.name} (role | person | reports to | starts):\n${roles.map((r) => `${r.role} | ${r.person ?? "-"} | ${r.reports_to ?? "-"} | ${r.available_from ?? "-"}${r.responsibility.length ? ` | ${r.responsibility.join("; ")}` : ""}`).join("\n")}` : "No organisation chart has been read yet.",
    rules.length ? `Approval rules:\n${rules.map((r) => `- ${r.policy}: ${r.text || `${r.kind}, ${r.role}${r.limit_eur !== null ? `, up to EUR ${r.limit_eur}` : ""}`}`).join("\n")}` : "No approval rules have been read yet.",
    pendingAsk.length ? `Already asked and not answered yet (issue id | to | question):\n${pendingAsk.map((i) => `${i.id} | ${i.addressee === "supplier" ? i.supplier_id : i.assignee_role} | ${i.question ?? i.title}`).join("\n")}` : "",
    `Open issues:\n${JSON.stringify(open.map((i) => ({
      issue_id: i.id, type: i.type, raised_by: i.created_by === "code" ? "rule" : i.created_by === "action_agent" ? "action agent" : "reading agent", title: i.title, detail: i.detail,
      ...(i.expected ? { expected: i.expected } : {}), ...(i.actual ? { actual: i.actual } : {}), about: `${i.object_type} ${i.object_id}`,
      ...(i.part_id ? { part_id: i.part_id } : {}), ...(i.supplier_id ? { supplier_id: i.supplier_id } : {}),
      ...(i.addressee ? { suggested_to: i.addressee === "supplier" ? "supplier" : "customer" } : {}), ...(i.question ? { question: i.question } : {}), fact_ids: json<number[]>(i.fact_ids, []),
    })), null, 1)}`,
  ].filter(Boolean).join("\n\n");

  const r = await runAgent({ model: config.openai.modelAgent, system: withStyle(prompt("correspond.md")), user, tools, maxSteps: Number(process.env.CORRESPOND_MAX_STEPS ?? 30) });

  res.mails = mails.size; res.tasks = tasks.size;
  res.dismissed = all<{ id: number }>(`SELECT id FROM issues WHERE id IN (${[...handled].map(() => "?").join(",") || "NULL"}) AND status = 'resolved'`, ...handled).length;
  res.left_open = open.length - handled.size;
  logEvent({ actor: "data_agent", action: "correspondence.done", run_id: opts.runId,
    summary: `I went through ${open.length} open issues and wrote ${res.mails} ${res.mails === 1 ? "mail" : "mails"} and ${res.tasks} ${res.tasks === 1 ? "task" : "tasks"}${res.dismissed ? `, closed ${res.dismissed} that need no action` : ""}${res.left_open ? `, and left ${res.left_open} open` : ""}.`,
    input: { issue_ids: open.map((i) => i.id), answer_by: by }, output: { mails: Object.fromEntries(mails), tasks: Object.fromEntries(tasks), left_open: open.filter((i) => !handled.has(i.id)).map((i) => i.id), closing_words: r.text, steps: r.steps },
    model: r.usage.model, tokens_in: r.usage.tokens_in, tokens_out: r.usage.tokens_out, cost_usd: r.usage.cost_usd });

  if (config.mail.autoSendClarifications) {
    for (const id of mails.values()) { try { await sendMessage(id, "data_agent"); res.sent++; } catch { /* sendMessage logs why; the draft stays for a person */ } }
  }
  return res;
}
