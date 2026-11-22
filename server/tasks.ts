import type { Actor } from "../shared/api.ts";
import { config } from "./config.ts";
import { all, get, run, tx } from "./db.ts";
import { nowIso } from "./clock.ts";
import { logEvent } from "./events.ts";

// Tasks: what the agents ask of people at the customer. Code only.
// Three rules keep the to-do list short:
//   1. One task per person and thing. A second request to the same person about the same lot, order, shipment or
//      decision is added to the open task instead of becoming a new one.
//   2. A task closes with what it belongs to: its risk is gone, a decision for its risk is approved, or the decision
//      it carries out is finished.
//   3. A question that was not answered by its deadline is stale. It stays open, but drops down the list.

export interface NewTask {
  role: string;
  person: string | null;
  title: string;
  body: string;
  created_by: Actor;
  issue_id?: number | null;
  object_type?: string | null;
  object_id?: string | null;
  /** The risk the task was asked for. */
  risk_id?: number | null;
  /** Set when the task carries out an approved decision. Such a task is an instruction, not a question. */
  decision_id?: number | null;
  /** By when the answer is needed, ISO. */
  due_at?: string | null;
}

interface TaskRow { id: number; role: string; person: string | null; title: string; body: string; object_type: string | null; object_id: string | null; risk_id: number | null; decision_id: number | null; issue_id: number | null; due_at: string | null; created_by: string; created_at: string }

/** The open task of the same person about the same thing, if there is one. */
function openTaskFor(t: NewTask): TaskRow | undefined {
  const who = t.person ?? t.role;
  const mine = "status = 'open' AND COALESCE(person, role) = ?";
  if (t.decision_id) return get<TaskRow>(`SELECT * FROM tasks WHERE ${mine} AND decision_id = ? ORDER BY id LIMIT 1`, who, t.decision_id);
  if (t.object_type && t.object_id) return get<TaskRow>(`SELECT * FROM tasks WHERE ${mine} AND decision_id IS NULL AND object_type = ? AND object_id = ? ORDER BY id LIMIT 1`, who, t.object_type, t.object_id);
  return get<TaskRow>(`SELECT * FROM tasks WHERE ${mine} AND decision_id IS NULL AND object_id IS NULL AND LOWER(title) = LOWER(?) ORDER BY id LIMIT 1`, who, t.title.trim());
}

/** Create a task, or add the request to the open task the same person already has about the same thing. */
export function putTask(t: NewTask): { id: number; added_to_open_task: boolean } {
  const title = t.title.trim(), body = t.body.trim();
  const open = openTaskFor(t);
  if (open) {
    // The same words twice add nothing. A new request goes under the old one, and the later deadline counts.
    if (!open.body.includes(body)) run("UPDATE tasks SET body = body || ? WHERE id = ?", `\n\n${title}\n${body}`, open.id);
    run("UPDATE tasks SET risk_id = COALESCE(risk_id, ?), due_at = COALESCE(?, due_at) WHERE id = ?", t.risk_id ?? null, t.due_at ?? null, open.id);
    return { id: open.id, added_to_open_task: true };
  }
  const id = run(
    "INSERT INTO tasks (status, role, person, title, body, issue_id, object_type, object_id, created_by, created_at, risk_id, decision_id, due_at) VALUES ('open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    t.role, t.person, title, body, t.issue_id ?? null, t.object_type ?? null, t.object_id ?? null, t.created_by, nowIso(), t.risk_id ?? null, t.decision_id ?? null, t.due_at ?? null).lastId;
  return { id, added_to_open_task: false };
}

/**
 * Close open tasks that belong to a risk or a decision, with the reason. `questions` limits it to questions,
 * so the task that carries out an approved decision stays open. Returns the ids that were closed.
 */
export function closeTasks(of: { risk_id?: number; decision_id?: number; questions?: boolean }, reason: string, runId: string | null = null): number[] {
  const where: string[] = ["status = 'open'"]; const params: unknown[] = [];
  if (of.risk_id !== undefined) { where.push("risk_id = ?"); params.push(of.risk_id); }
  if (of.decision_id !== undefined) { where.push("decision_id = ?"); params.push(of.decision_id); }
  if (of.questions) where.push("decision_id IS NULL");
  if (params.length === 0) return [];
  const rows = all<TaskRow>(`SELECT * FROM tasks WHERE ${where.join(" AND ")}`, ...params);
  return closeRows(rows, reason, runId);
}

function closeRows(rows: TaskRow[], reason: string, runId: string | null): number[] {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => "?").join(",");
  tx(() => {
    run(`UPDATE tasks SET status = 'done', done_at = ?, closed_reason = ? WHERE id IN (${marks})`, nowIso(), reason, ...ids);
    // The question behind it was not answered. It is dropped, so the agent does not read the closing as an answer.
    run(`UPDATE questions SET status = 'dropped' WHERE task_id IN (${marks}) AND status IN ('queued', 'sent', 'no_answer')`, ...ids);
  });
  logEvent({ actor: "action_agent", action: "task.closed", run_id: runId,
    summary: `I closed ${ids.length === 1 ? `the task "${rows[0].title}"` : `${ids.length} tasks`} because nobody has to do ${ids.length === 1 ? "it" : "them"} any more: ${reason}`,
    output: { task_ids: ids, titles: rows.map((r) => r.title), reason } });
  return ids;
}

/** When an answer to a task was due, for tasks that were created before deadlines were stored: soon enough to still act before the launch. */
function dueOf(createdAt: string): string {
  const created = new Date(createdAt).getTime();
  const left = (new Date(config.deadline).getTime() - created) / 3_600_000;
  return new Date(created + Math.min(24, Math.max(2, left / 8)) * 3_600_000).toISOString();
}

/**
 * Bring the open tasks in line with the three rules. Runs at the start of every pass of the action agent, costs no
 * model call, and changes nothing when everything is in order. It also sorts out tasks from before these rules.
 */
export function tidyTasks(runId: string | null = null): { linked: number; merged: number; closed: number } {
  // What each task belongs to, where it can be read from the questions and decisions on file.
  const linked =
    run("UPDATE tasks SET risk_id = (SELECT q.risk_id FROM questions q WHERE q.task_id = tasks.id ORDER BY q.id LIMIT 1) WHERE risk_id IS NULL AND id IN (SELECT task_id FROM questions WHERE task_id IS NOT NULL)").changes +
    run("UPDATE tasks SET decision_id = CAST(object_id AS INTEGER) WHERE decision_id IS NULL AND object_type = 'decision' AND created_by = 'action_agent' AND object_id GLOB '[0-9]*'").changes +
    run("UPDATE tasks SET risk_id = (SELECT d.risk_id FROM decisions d WHERE d.id = tasks.decision_id) WHERE risk_id IS NULL AND decision_id IS NOT NULL").changes;
  run("UPDATE tasks SET due_at = (SELECT MAX(q.answer_by) FROM questions q WHERE q.task_id = tasks.id) WHERE due_at IS NULL AND id IN (SELECT task_id FROM questions WHERE task_id IS NOT NULL)");
  for (const t of all<TaskRow>("SELECT * FROM tasks WHERE status = 'open' AND due_at IS NULL AND decision_id IS NULL")) run("UPDATE tasks SET due_at = ? WHERE id = ?", dueOf(t.created_at), t.id);

  // One task per person and thing: later ones go into the oldest.
  let merged = 0;
  const first = new Map<string, TaskRow>();
  for (const t of all<TaskRow>("SELECT * FROM tasks WHERE status = 'open' AND decision_id IS NULL AND object_type IS NOT NULL AND object_id IS NOT NULL ORDER BY id")) {
    const key = `${t.person ?? t.role}|${t.object_type}|${t.object_id}`;
    const keep = first.get(key);
    if (!keep) { first.set(key, t); continue; }
    tx(() => {
      if (!keep.body.includes(t.body.trim())) { keep.body += `\n\n${t.title}\n${t.body.trim()}`; run("UPDATE tasks SET body = ? WHERE id = ?", keep.body, keep.id); }
      run("UPDATE tasks SET risk_id = COALESCE(risk_id, ?), due_at = NULLIF(MAX(COALESCE(due_at, ''), COALESCE(?, '')), '') WHERE id = ?", t.risk_id, t.due_at, keep.id);
      run("UPDATE tasks SET status = 'done', done_at = ?, closed_reason = ? WHERE id = ?", nowIso(), `It asked ${t.person ?? t.role} about the same thing as an earlier task, so it was added to that one ("${keep.title}").`, t.id);
      run("UPDATE questions SET task_id = ? WHERE task_id = ?", keep.id, t.id);
    });
    merged++;
  }
  if (merged) logEvent({ actor: "action_agent", action: "task.merged", run_id: runId, summary: `I put ${merged} ${merged === 1 ? "task" : "tasks"} into an earlier task for the same person about the same thing.`, output: { merged } });

  // A task closes with what it belongs to.
  let closed = 0;
  const gone = all<TaskRow>("SELECT t.* FROM tasks t JOIN risks r ON r.id = t.risk_id WHERE t.status = 'open' AND r.status = 'closed'");
  closed += closeRows(gone, "The risk it was asked for no longer shows in the data.", runId).length;
  const decided = all<TaskRow & { decision: string }>(
    `SELECT t.*, (SELECT d.title FROM decisions d WHERE d.risk_id = t.risk_id AND d.status = 'approved' ORDER BY d.id DESC LIMIT 1) AS decision
     FROM tasks t WHERE t.status = 'open' AND t.decision_id IS NULL AND t.risk_id IS NOT NULL AND EXISTS (SELECT 1 FROM decisions d WHERE d.risk_id = t.risk_id AND d.status = 'approved')`);
  for (const title of [...new Set(decided.map((t) => t.decision))]) closed += closeRows(decided.filter((t) => t.decision === title), `A decision for this risk was approved: "${title}".`, runId).length;
  const finished = all<TaskRow & { stage: string; decision_status: string }>(
    "SELECT t.*, d.stage, d.status AS decision_status FROM tasks t JOIN decisions d ON d.id = t.decision_id WHERE t.status = 'open' AND (d.status = 'rejected' OR d.stage IN ('done', 'failed', 'withdrawn'))");
  closed += closeRows(finished.filter((t) => t.stage === "done"), "The decision it carries out is confirmed as done.", runId).length;
  closed += closeRows(finished.filter((t) => t.stage !== "done"), "The decision it belongs to was rejected, taken back or did not work out.", runId).length;
  return { linked, merged, closed };
}
