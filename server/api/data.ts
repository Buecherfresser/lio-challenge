import { Hono } from "hono";
import type { Issue, Message, Task, Thread } from "../../shared/api.ts";
import { all, get, json, run, tx } from "../db.ts";
import { nowIso } from "../clock.ts";
import { logEvent } from "../events.ts";
import { llmAvailable } from "../llm.ts";
import { runDataAgent } from "../agents/data/index.ts";
import { toIssue, toMessage, toTask } from "../agents/data/rows.ts";
import type { IssueDb, MessageDb, TaskDb } from "../agents/data/rows.ts";
import { recordInbound } from "../mail/inbox.ts";
import { loadMessage, sendMessage } from "../mail/transport.ts";

// The part of the HTTP API that belongs to the data agent: mail threads and messages, tasks, issues,
// and the dev endpoint that simulates a supplier reply. Shapes are the ones in shared/api.ts.

export { toIssue, toMessage, toTask };
export type { IssueDb, MessageDb, TaskDb };

export const dataApi = new Hono();

const body = async (c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> => {
  try { const b = await c.req.json(); return b && typeof b === "object" ? (b as Record<string, unknown>) : {}; } catch { return {}; }
};
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

// ---- queries other modules can use too ----

export function listIssues(q: { status?: string; part_id?: string; supplier_id?: string } = {}): Issue[] {
  const where: string[] = []; const params: unknown[] = [];
  const status = q.status ?? "open";
  // "open" means not cleared yet: open, asked or answered. A single status can be asked for by its name.
  if (status === "open") where.push("status != 'resolved'");
  else if (status !== "all") { where.push("status = ?"); params.push(status); }
  if (q.part_id) { where.push("part_id = ?"); params.push(q.part_id); }
  if (q.supplier_id) { where.push("supplier_id = ?"); params.push(q.supplier_id); }
  return all<IssueDb>(`SELECT * FROM issues ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'answered' THEN 1 WHEN 'asked' THEN 2 ELSE 3 END, updated_at DESC, id DESC`, ...params).map(toIssue);
}

export function listMessages(q: { folder?: string; thread_id?: string } = {}): Message[] {
  const where: string[] = []; const params: unknown[] = [];
  if (q.folder === "inbox") where.push("direction = 'in'");
  else if (q.folder === "sent") where.push("direction = 'out' AND status IN ('sent', 'outbox')");
  else if (q.folder === "needs_approval") where.push("direction = 'out' AND status = 'needs_approval'");
  if (q.thread_id) { where.push("thread_id = ?"); params.push(q.thread_id); }
  // A thread reads top to bottom, a folder shows the newest first.
  const order = q.thread_id ? "COALESCE(sent_at, created_at) ASC, id ASC" : "COALESCE(sent_at, created_at) DESC, id DESC";
  return all<MessageDb>(`SELECT * FROM messages ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order}`, ...params).map(toMessage);
}

export function listThreads(): Thread[] {
  const names = new Map(all<{ supplier_id: string; name: string }>("SELECT supplier_id, name FROM suppliers").map((s) => [s.supplier_id, s.name]));
  const threads = new Map<string, Thread & { lastOutAt: string }>();
  for (const m of all<MessageDb>("SELECT * FROM messages ORDER BY COALESCE(sent_at, created_at) ASC, id ASC")) {
    const at = m.sent_at ?? m.created_at;
    const supplierId = m.supplier_id ?? (m.thread_id.startsWith("supplier:") ? m.thread_id.slice("supplier:".length) : null);
    let t = threads.get(m.thread_id);
    if (!t) {
      const kind = m.thread_id.startsWith("supplier:") ? "supplier" as const : "person" as const;
      t = { thread_id: m.thread_id, title: kind === "supplier" ? (names.get(supplierId ?? "") ?? supplierId ?? m.thread_id) : (m.person ?? m.thread_id.replace(/^person:/, "")), kind, supplier_id: kind === "supplier" ? supplierId : null,
        last_at: at, last_subject: m.subject, count: 0, needs_approval: 0, unread_in: 0, lastOutAt: "" };
      threads.set(m.thread_id, t);
    }
    t.count++;
    t.last_at = at; t.last_subject = m.subject;
    if (m.direction === "out") {
      if (m.status === "needs_approval") t.needs_approval++;
      if (m.status === "sent" || m.status === "outbox") { t.lastOutAt = at; t.unread_in = 0; } // we answered: nothing waits on our side
    } else {
      t.unread_in++;
    }
  }
  return [...threads.values()].map(({ lastOutAt: _drop, ...t }) => t).sort((a, b) => b.last_at.localeCompare(a.last_at));
}

export function listTasks(q: { status?: string } = {}): Task[] {
  const status = q.status ?? "open";
  return all<TaskDb>(`SELECT * FROM tasks ${status === "all" ? "" : "WHERE status = ?"} ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC, id DESC`, ...(status === "all" ? [] : [status])).map(toTask);
}

// ---- routes ----

dataApi.get("/threads", (c) => c.json(listThreads()));

dataApi.get("/messages", (c) => {
  const q = c.req.query();
  return c.json(listMessages({ folder: q.folder || undefined, thread_id: q.thread_id || undefined }));
});

dataApi.post("/messages/:id/approve", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await body(c);
  const by = text(b.by) ?? "human";
  const m = loadMessage(id);
  if (!m) return c.json({ error: "There is no such message." }, 404);
  if (m.direction !== "out" || (m.status !== "needs_approval" && m.status !== "draft")) return c.json({ error: `This message is ${m.status} and cannot be approved.` }, 409);
  const edited = text(b.body_original);
  const changed = edited !== undefined && edited !== m.body_original.trim();
  if (changed) {
    // The English copy is only kept in step where the mail itself is English. Otherwise it is marked as older than the text.
    const en = m.language === "en" ? edited : `[The text was edited before sending. This English version is the one from before the edit.]\n\n${m.body_en.replace(/^\[The text was edited before sending[^\]]*\]\n\n/, "")}`;
    run("UPDATE messages SET body_original = ?, body_en = ? WHERE id = ?", edited, en, id);
  }
  logEvent({ actor: "human", action: "mail.approved", object: { type: "message", id: String(id), label: m.subject }, summary: `${by === "human" ? "Someone" : by} approved the mail "${m.subject}" to ${m.to_addr}${changed ? " after editing it" : ""}.`, input: { message_id: id, by, edited: changed }, output: changed ? { body_original: edited } : null });
  try {
    return c.json(await sendMessage(id, by === "human" ? "human" : by));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

dataApi.post("/messages/:id/reject", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await body(c);
  const by = text(b.by) ?? "human";
  const m = loadMessage(id);
  if (!m) return c.json({ error: "There is no such message." }, 404);
  if (m.direction !== "out" || m.status === "sent" || m.status === "outbox") return c.json({ error: `This message is ${m.status} and cannot be rejected.` }, 409);
  const issueIds = json<number[]>(m.issue_ids, []);
  tx(() => {
    run("UPDATE messages SET status = 'rejected' WHERE id = ?", id);
    // The questions were not asked after all. The issues are open again, and stay marked as questions for the supplier, so nobody is asked twice by accident.
    for (const issueId of issueIds) run("UPDATE issues SET status = 'open', updated_at = ? WHERE id = ? AND status = 'asked'", nowIso(), issueId);
  });
  logEvent({ actor: "human", action: "mail.rejected", object: { type: "message", id: String(id), label: m.subject }, summary: `${by === "human" ? "Someone" : by} rejected the mail "${m.subject}" to ${m.to_addr}, so it is not sent.`, input: { message_id: id, by, reason: text(b.reason) ?? null }, output: { issues_reopened: issueIds } });
  return c.json(toMessage(loadMessage(id)!));
});

dataApi.get("/tasks", (c) => c.json(listTasks({ status: c.req.query("status") || undefined })));

dataApi.post("/tasks/:id/done", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await body(c);
  const by = text(b.by) ?? "human";
  const t = get<TaskDb>("SELECT * FROM tasks WHERE id = ?", id);
  if (!t) return c.json({ error: "There is no such task." }, 404);
  if (t.status !== "done") {
    tx(() => {
      run("UPDATE tasks SET status = 'done', done_at = ? WHERE id = ?", nowIso(), id);
      // The person has dealt with it. Whether the deviation is gone is for the next check to say.
      if (t.issue_id !== null) run("UPDATE issues SET status = 'answered', updated_at = ? WHERE id = ? AND status = 'asked'", nowIso(), t.issue_id);
    });
    logEvent({ actor: "human", action: "task.done", object: t.object_type && t.object_id ? { type: toTask(t).object!.type, id: t.object_id } : null, summary: `${by === "human" ? "Someone" : by} marked the task "${t.title}" as done.`, input: { task_id: id, by, note: text(b.note) ?? null }, output: { issue_id: t.issue_id } });
  }
  return c.json(toTask(get<TaskDb>("SELECT * FROM tasks WHERE id = ?", id)!));
});

dataApi.get("/issues", (c) => {
  const q = c.req.query();
  return c.json(listIssues({ status: q.status || undefined, part_id: q.part_id || undefined, supplier_id: q.supplier_id || undefined }));
});

// Simulate a supplier reply: it is stored like a received mail and the data agent reads it on its next pass.
dataApi.post("/dev/inbound", async (c) => {
  const b = await body(c);
  let message: Message;
  try {
    message = recordInbound({ supplier_id: String(b.supplier_id ?? ""), subject: String(b.subject ?? ""), body: String(b.body ?? "") });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  // Read it right away instead of waiting for the next cycle: mails, rules and questions, no documents.
  // If a pass is already running it may be past the mail step, so look once more when it is through.
  if (llmAvailable()) {
    const unread = () => Boolean(get("SELECT 1 AS x FROM messages WHERE id = ? AND processed = 0", message.id));
    void runDataAgent({ mailsOnly: true }).then(() => (unread() ? runDataAgent({ mailsOnly: true }) : null)).catch(() => undefined);
  }
  return c.json(message);
});
