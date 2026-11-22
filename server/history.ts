import crypto from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HistoryEvent, HistoryList, HistoryStep, HistoryWord, ObjectRef } from "../shared/api.ts";
import { config } from "./config.ts";
import { db, pastView } from "./db.ts";
import type { PastView } from "./db.ts";
import { nowIso } from "./clock.ts";

// History: the app can be looked at as it was at an earlier moment.
//
// Recording. After a step that changes what the dashboard shows, the state is written down as a "moment":
// every table of the working database except facts and events. Those two only ever grow, so for them the id of
// the last row is enough. Tables that did not change since the last moment are stored once (by the hash of their rows).
//
// Looking back. A moment is opened as a small database in memory: its tables, plus the live facts and events cut off
// at the ids of that moment. A request that names a moment reads from there (see pastView in db.ts). The code that
// computes and serves the dashboard does not know the difference.
//
// Events. A delivery of new or changed files from the portal starts an event. Every later step belongs to the event
// that first brought up its risk, so an answer that arrives hours later still shows under the right one.

const hist = new DatabaseSync(path.join(config.dataDir, "history.db"));
hist.exec(`
PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, rows TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS moments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,                  -- the time the app believed it was
  real_at TEXT NOT NULL,             -- wall clock, for the order and the waits
  word TEXT,                         -- the label on the time bar, from the fixed list below. NULL = a step in between
  action TEXT NOT NULL, summary TEXT NOT NULL,
  event_id INTEGER,                  -- the sync that started the event this moment belongs to
  risk_id INTEGER,
  detail TEXT,                       -- for "New data": which files came
  last_event_id INTEGER NOT NULL, last_fact_id INTEGER NOT NULL,
  pending INTEGER NOT NULL,          -- documents still to read at that moment
  tables TEXT NOT NULL               -- JSON: table name -> hash of its rows
);
CREATE INDEX IF NOT EXISTS moments_event ON moments (event_id);
CREATE TABLE IF NOT EXISTS risk_origin (risk_id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL);
`);

const meta = {
  get: (key: string): string | null => (hist.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null,
  set: (key: string, value: string) => { hist.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value); },
};

/** The steps that get a word on the time bar. Fixed here, never written by a model. */
const WORDS: Record<string, HistoryWord> = {
  "sync.completed": "New data",
  "risk.reported": "Risk",
  "mail.received": "Supplier replied",
  "decision.proposed": "Decision ready",
  "decision.approved": "Approved",
  "decision.carried_out": "Ordered",
  "decision.rejected": "Rejected",
  "decision.done": "Confirmed",
  "decision.failed": "Failed",
};
/** Steps in between: recorded so that playing an event shows them, but without a word. */
const BETWEEN = new Set(["base.loaded", "rules.checked", "clarification.done", "risk_agent.finished", "action_agent.finished", "decision.signed", "decision.withdrawn", "task.created", "risk.closed", "issue.answered", "cases.written"]);
/** Where an event stands, from the last word on its bar. */
const STATE: Record<HistoryWord, string> = {
  "New data": "nothing to do", "Risk": "risk found", "Supplier asked": "waiting for a supplier", "Supplier replied": "supplier replied", "Decision ready": "waiting for a decision",
  "Approved": "approved", "Ordered": "ordered", "Rejected": "rejected", "Confirmed": "confirmed", "Failed": "failed",
};
/** Marks a risk that was there before the recording started. */
const BEFORE = 0;
/** Tables that change on every cycle without anything happening. They do not count when two moments are compared. */
const RESTLESS = new Set(["kv", "syncs"]);

interface Logged { action: string; summary: string; object?: ObjectRef | null; input?: unknown; output?: unknown }
interface MomentDb { id: number; at: string; real_at: string; word: HistoryWord | null; action: string; summary: string; event_id: number | null; risk_id: number | null; detail: string | null; last_event_id: number; last_fact_id: number; pending: number; tables: string }

const one = <T>(sql: string, ...params: (string | number)[]): T | undefined => db.prepare(sql).get(...params) as T | undefined;
const stateTables = (): { name: string; sql: string }[] =>
  db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('facts', 'events') ORDER BY name").all() as { name: string; sql: string }[];

/** A history belongs to one working database: its moments point at fact and event ids of that database. */
function sameDatabase(): void {
  let id = one<{ value: string }>("SELECT value FROM kv WHERE key = 'db_id'")?.value;
  if (!id) {
    id = crypto.randomUUID();
    db.prepare("INSERT INTO kv (key, value) VALUES ('db_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(id);
  }
  const known = meta.get("db_id");
  if (known && known !== id) {
    // The working database was replaced. The old moments would show wrong facts, so they go.
    hist.exec("DELETE FROM moments; DELETE FROM blobs; DELETE FROM risk_origin; DELETE FROM meta;");
    console.log("history: the working database was replaced, so the recorded moments were dropped.");
  }
  if (known !== id) meta.set("db_id", id);
}
let checked = false;

/** The risk a logged step is about, if it is about one. */
function riskOf(e: Logged): number | null {
  const o = e.object;
  if (!o) return null;
  const id = Number(o.id);
  if (o.type === "risk") return Number.isInteger(id) ? id : null;
  if (o.type === "decision") return one<{ risk_id: number }>("SELECT risk_id FROM decisions WHERE id = ?", id)?.risk_id ?? null;
  if (o.type === "message" && Number.isInteger(id)) {
    const m = one<{ decision_id: number | null; issue_ids: string; supplier_id: string | null }>("SELECT decision_id, issue_ids, supplier_id FROM messages WHERE id = ?", id);
    if (!m) return null;
    if (m.decision_id) return one<{ risk_id: number }>("SELECT risk_id FROM decisions WHERE id = ?", m.decision_id)?.risk_id ?? null;
    // A mail that carries questions of the action agent belongs to the risk they were asked for.
    const byQuestion = one<{ risk_id: number }>("SELECT q.risk_id FROM questions q, json_each(?) j WHERE q.issue_id = j.value ORDER BY q.id LIMIT 1", m.issue_ids || "[]");
    if (byQuestion) return byQuestion.risk_id;
    // A reply: the risk this supplier was last asked about.
    if (m.supplier_id) return one<{ risk_id: number }>("SELECT risk_id FROM questions WHERE supplier_id = ? ORDER BY id DESC LIMIT 1", m.supplier_id)?.risk_id ?? null;
  }
  return null;
}

/** The word for a logged step, or null. A mail counts as "Supplier asked" when it went to a supplier and is not the mail of a decision. */
function wordFor(e: Logged): HistoryWord | null {
  if (WORDS[e.action]) return WORDS[e.action];
  if ((e.action === "mail.sent" || e.action === "mail.outbox") && e.object?.type === "message") {
    const m = one<{ decision_id: number | null; supplier_id: string | null }>("SELECT decision_id, supplier_id FROM messages WHERE id = ?", Number(e.object.id));
    if (m?.supplier_id && !m.decision_id) return "Supplier asked";
  }
  return null;
}

/**
 * Called for every log entry. Writes a moment when the step is one the time bar knows.
 * Recording must never get in the way of the app, so any error here is printed and swallowed.
 */
export function record(eventRowId: number, e: Logged): void {
  if (pastView.getStore()) return; // nothing new happens in the past
  try {
    const word = wordFor(e);
    const between = !word && (BETWEEN.has(e.action) || e.action === "mail.sent" || e.action === "mail.outbox");
    if (!word && !between) return;
    if (!checked) { sameDatabase(); checked = true; }

    // Until the first full reading is through there is nothing to go back to, so nothing is written down.
    const pending = one<{ n: number }>("SELECT COUNT(*) AS n FROM documents WHERE current = 1 AND handler = 'openai' AND status = 'pending'")?.n ?? 0;
    const started = meta.get("since") !== null;
    if (!started && pending > 0) return;

    const tables: Record<string, string> = {};
    const fresh: [string, string][] = [];
    for (const t of stateTables()) {
      const rows = JSON.stringify(db.prepare(`SELECT * FROM "${t.name}"`).all());
      const hash = crypto.createHash("sha1").update(rows).digest("hex");
      tables[t.name] = hash;
      fresh.push([hash, rows]);
    }
    const last = hist.prepare("SELECT * FROM moments ORDER BY id DESC LIMIT 1").get() as MomentDb | undefined;
    if (!word && last) {
      // A step in between that changed nothing the dashboard shows is not worth a moment.
      const before = JSON.parse(last.tables) as Record<string, string>;
      if (Object.keys(tables).every((name) => RESTLESS.has(name) || before[name] === tables[name])) return;
    }

    const riskId = riskOf(e);
    const latestSync = one<{ m: number | null }>("SELECT MAX(id) AS m FROM syncs WHERE added + changed + removed > 0")?.m ?? null;
    let eventId = started ? latestSync : null;
    if (riskId !== null && started) {
      const origin = hist.prepare("SELECT event_id FROM risk_origin WHERE risk_id = ?").get(riskId) as { event_id: number } | undefined;
      // A risk from before the recording started belongs to no event: its later steps are kept, but not shown on a bar.
      if (origin) eventId = origin.event_id === BEFORE ? null : origin.event_id;
      else if (latestSync !== null) hist.prepare("INSERT OR IGNORE INTO risk_origin (risk_id, event_id) VALUES (?, ?)").run(riskId, latestSync);
    }
    const lastFact = one<{ m: number | null }>("SELECT MAX(id) AS m FROM facts")?.m ?? 0;
    const detail = e.action === "sync.completed" ? JSON.stringify({ ...(e.output as object), source: (e.input as { source?: string } | undefined)?.source ?? null }) : null;

    hist.exec("BEGIN");
    try {
      const put = hist.prepare("INSERT OR IGNORE INTO blobs (hash, rows) VALUES (?, ?)");
      for (const [hash, rows] of fresh) put.run(hash, rows);
      const id = Number(hist.prepare(
        "INSERT INTO moments (at, real_at, word, action, summary, event_id, risk_id, detail, last_event_id, last_fact_id, pending, tables) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(nowIso(), new Date().toISOString(), word, e.action, e.summary.slice(0, 600), eventId, riskId, detail, eventRowId, lastFact, pending, JSON.stringify(tables)).lastInsertRowid);
      // The time bar starts once the first full reading is through: from then on, new data is an event worth looking at.
      if (!started) {
        meta.set("since", String(id));
        // Every risk that is already there came out of the first reading, not out of an event.
        const mark = hist.prepare("INSERT OR IGNORE INTO risk_origin (risk_id, event_id) VALUES (?, ?)");
        for (const r of db.prepare("SELECT id FROM risks").all() as { id: number }[]) mark.run(r.id, BEFORE);
      }
      hist.exec("COMMIT");
    } catch (err) { hist.exec("ROLLBACK"); throw err; }
  } catch (err) {
    console.error(`history: could not record ${e.action}: ${(err as Error).message}`);
  }
}

// ---- looking back ----

const open = new Map<number, PastView>(); // the few moments looked at most recently
const KEEP = 8;

/** Open a recorded moment for reading. Returns null if it is not on record. */
export function openPast(id: number): PastView | null {
  if (!Number.isInteger(id)) return null;
  const hit = open.get(id);
  if (hit) { open.delete(id); open.set(id, hit); return hit; }
  const m = hist.prepare("SELECT * FROM moments WHERE id = ?").get(id) as MomentDb | undefined;
  if (!m) return null;

  const mem = new DatabaseSync(":memory:");
  const stored = JSON.parse(m.tables) as Record<string, string>;
  const read = hist.prepare("SELECT rows FROM blobs WHERE hash = ?");
  mem.exec("BEGIN");
  for (const t of stateTables()) {
    // The table as it is defined today, filled with the rows of then. A column added since stays at its default.
    mem.exec(t.sql);
    const rows = stored[t.name] ? (JSON.parse((read.get(stored[t.name]) as { rows: string } | undefined)?.rows ?? "[]") as Record<string, string | number | null>[]) : [];
    if (!rows.length) continue;
    const known = new Set((mem.prepare(`PRAGMA table_info("${t.name}")`).all() as { name: string }[]).map((c) => c.name));
    const cols = Object.keys(rows[0]).filter((c) => known.has(c));
    const insert = mem.prepare(`INSERT INTO "${t.name}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
    for (const r of rows) insert.run(...cols.map((c) => r[c] ?? null));
  }
  mem.exec("COMMIT");
  // Facts and the log only grow, so the past is the live table up to the last row of that moment.
  mem.exec(`ATTACH '${path.join(config.dataDir, "app.db").replace(/'/g, "''")}' AS live`);
  mem.exec(`CREATE TEMP VIEW facts AS SELECT * FROM live.facts WHERE id <= ${Number(m.last_fact_id)}`);
  mem.exec(`CREATE TEMP VIEW events AS SELECT * FROM live.events WHERE id <= ${Number(m.last_event_id)}`);
  mem.exec("PRAGMA query_only = 1");

  const view: PastView = { id: m.id, at: m.at, db: mem, cache: new Map() };
  open.set(id, view);
  while (open.size > KEEP) { const oldest = open.keys().next().value as number; open.get(oldest)?.db.close(); open.delete(oldest); }
  return view;
}

// ---- the list for the time bar ----

interface SyncDetail { added?: string[]; changed?: string[]; removed?: string[]; source?: string | null }

/** "3 new files · Karton Nowak". Built from the file paths, so it says only what is certain. */
function titleOf(d: SyncDetail): string {
  const added = d.added ?? [], changed = d.changed ?? [], removed = d.removed ?? [];
  const total = added.length + changed.length + removed.length;
  const what = [added.length ? `${added.length} new` : "", changed.length ? `${changed.length} changed` : "", removed.length ? `${removed.length} removed` : ""].filter(Boolean).join(", ");
  const where: string[] = [];
  for (const p of [...added, ...changed, ...removed]) {
    const seg = p.split("/");
    let name = seg.length > 2 ? seg[1] : seg[0];
    if (seg[0] === "suppliers" && seg[1]) {
      const supplierId = seg[1].match(/^[A-Z]+-\d+/)?.[0];
      name = (supplierId && one<{ name: string }>("SELECT name FROM suppliers WHERE supplier_id = ?", supplierId)?.name) || seg[1].replace(/^[A-Z]+-\d+_/, "").replace(/_/g, " ");
    }
    if (name && !where.includes(name)) where.push(name);
  }
  const places = where.length > 2 ? `${where.slice(0, 2).join(", ")} and ${where.length - 2} more` : where.join(", ");
  return `${what || "0 changed"} ${total === 1 ? "file" : "files"}${places ? ` · ${places}` : ""}`;
}

/** Every event since the first full reading, newest first, with its steps in order. */
export function listHistory(): HistoryList {
  const since = Number(meta.get("since") ?? NaN);
  if (!Number.isFinite(since)) return { recording_since: null, events: [] };
  const first = hist.prepare("SELECT real_at FROM moments WHERE id = ?").get(since) as { real_at: string } | undefined;
  const rows = hist.prepare("SELECT id, at, real_at, word, action, summary, event_id, risk_id, detail, pending, last_event_id FROM moments WHERE id >= ? AND event_id IS NOT NULL ORDER BY id").all(since) as unknown as MomentDb[];
  const byEvent = new Map<number, MomentDb[]>();
  for (const m of rows) { if (!byEvent.has(m.event_id!)) byEvent.set(m.event_id!, []); byEvent.get(m.event_id!)!.push(m); }
  const events: HistoryEvent[] = [];
  for (const [eventId, moments] of byEvent) {
    // An event counts from the moment its files arrived. Steps of an older event that started before recording are left out.
    const start = moments.find((m) => m.word === "New data");
    if (!start) continue;
    const mine = moments.filter((m) => m.id >= start.id);
    const detail = JSON.parse(start.detail ?? "{}") as SyncDetail;
    const lastWord = [...mine].reverse().find((m) => m.word)?.word ?? "New data";
    const steps: HistoryStep[] = mine.map((m) => ({ id: m.id, at: m.real_at, word: m.word, summary: m.summary, risk_id: m.risk_id, log_id: m.last_event_id }));
    const last = mine[mine.length - 1];
    events.push({
      id: eventId, at: start.real_at, title: titleOf(detail),
      state: lastWord === "New data" && last.pending > 0 ? "being read" : STATE[lastWord],
      test: detail.source !== null && detail.source !== undefined && detail.source !== "live",
      steps,
    });
  }
  events.sort((a, b) => b.id - a.id);
  return { recording_since: first?.real_at ?? null, events };
}
