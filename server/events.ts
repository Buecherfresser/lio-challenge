import type { Actor, EventRow, ObjectRef } from "../shared/api.ts";
import { all, json, run } from "./db.ts";
import { record } from "./history.ts";

export interface LogInput {
  actor: Actor;
  action: string;            // "sync.completed", "document.read", "mail.drafted", ...
  summary: string;           // one sentence, first person: "I read ... and found ..."
  object?: ObjectRef | null;
  run_id?: string | null;
  input?: unknown;
  output?: unknown;
  fact_ids?: number[];
  model?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  cost_usd?: number | null;
}

const clip = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v);
  // Keep the log readable: very large payloads are cut, the full source is always the file or the fact.
  return s.length > 60_000 ? JSON.stringify({ truncated: true, head: s.slice(0, 60_000) }) : s;
};

/** Every step of every actor goes through here. */
export function logEvent(e: LogInput): number {
  const r = run(
    `INSERT INTO events (ts, actor, action, summary, object_type, object_id, object_label, run_id, input, output, fact_ids, model, tokens_in, tokens_out, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    nowIsoReal(), e.actor, e.action, e.summary, e.object?.type ?? null, e.object?.id ?? null, e.object?.label ?? null, e.run_id ?? null,
    clip(e.input), clip(e.output), JSON.stringify(e.fact_ids ?? []), e.model ?? null, e.tokens_in ?? null, e.tokens_out ?? null, e.cost_usd ?? null,
  );
  const tag = `[${e.actor}] ${e.action}`;
  console.log(`${new Date().toISOString().slice(11, 19)} ${tag.padEnd(34)} ${e.summary}`);
  record(r.lastId, e);
  return r.lastId;
}

// Events carry the real wall-clock time so the order in the log is always the order things happened in,
// also in replay mode where the world clock jumps.
const nowIsoReal = () => new Date().toISOString();

interface EventDb {
  id: number; ts: string; actor: Actor; action: string; summary: string;
  object_type: string | null; object_id: string | null; object_label: string | null; run_id: string | null;
  input: string | null; output: string | null; fact_ids: string;
  model: string | null; tokens_in: number | null; tokens_out: number | null; cost_usd: number | null;
}

export function toEventRow(r: EventDb): EventRow {
  return {
    id: r.id, ts: r.ts, actor: r.actor, action: r.action, summary: r.summary,
    object: r.object_type && r.object_id ? { type: r.object_type as ObjectRef["type"], id: r.object_id, label: r.object_label ?? undefined } : null,
    run_id: r.run_id, input: json(r.input, null), output: json(r.output, null), fact_ids: json<number[]>(r.fact_ids, []),
    model: r.model, tokens_in: r.tokens_in, tokens_out: r.tokens_out, cost_usd: r.cost_usd,
  };
}

export function listEvents(q: { actor?: string; object_type?: string; object_id?: string; q?: string; limit?: number; before_id?: number }): EventRow[] {
  const where: string[] = []; const params: unknown[] = [];
  if (q.actor) { const a = q.actor.split(",").filter(Boolean); where.push(`actor IN (${a.map(() => "?").join(",")})`); params.push(...a); }
  if (q.object_type) { where.push("object_type = ?"); params.push(q.object_type); }
  if (q.object_id) { where.push("object_id = ?"); params.push(q.object_id); }
  if (q.q) { where.push("(summary LIKE ? OR action LIKE ? OR object_id LIKE ?)"); params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
  if (q.before_id) { where.push("id < ?"); params.push(q.before_id); }
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  return all<EventDb>(`SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`, ...params, limit).map(toEventRow);
}

/** Events about a part: the part itself plus anything logged for its orders, shipments and lots. */
export function eventsForObjects(refs: { type: string; id: string }[], limit = 60): EventRow[] {
  if (!refs.length) return [];
  const cond = refs.map(() => "(object_type = ? AND object_id = ?)").join(" OR ");
  return all<EventDb>(`SELECT * FROM events WHERE ${cond} ORDER BY id DESC LIMIT ?`, ...refs.flatMap((r) => [r.type, r.id]), limit).map(toEventRow);
}

export function totalSpendUsd(): number {
  return (all<{ s: number | null }>("SELECT SUM(cost_usd) AS s FROM events")[0]?.s ?? 0) || 0;
}

export const newRunId = (prefix: string) => `${prefix}-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
