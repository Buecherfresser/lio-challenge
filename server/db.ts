import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { config } from "./config.ts";

// Two databases on purpose:
//  archive.db  every sync as a complete version (manifest) plus the file blobs next to it. Never deleted.
//  app.db      the working state. Can be deleted and rebuilt by replaying the archive.
export const archive = new DatabaseSync(path.join(config.archiveDir, "archive.db"));
export const db = new DatabaseSync(path.join(config.dataDir, "app.db"));

for (const d of [archive, db]) {
  d.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
}

archive.exec(`
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at TEXT NOT NULL,            -- when this state of the portal was observed
  origin TEXT NOT NULL,              -- live | import
  manifest_sha TEXT NOT NULL,        -- hash over the sorted (path, sha256) list
  file_count INTEGER NOT NULL,
  note TEXT
);
CREATE TABLE IF NOT EXISTS manifest_files (
  manifest_sha TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (manifest_sha, path)
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS syncs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,                  -- when we applied it
  world_at TEXT NOT NULL,            -- when the snapshot was taken
  snapshot_id INTEGER NOT NULL,      -- id in archive.db
  source TEXT NOT NULL,              -- live | replay | import
  added INTEGER NOT NULL, changed INTEGER NOT NULL, removed INTEGER NOT NULL
);

-- One row per version of a file. A changed file is a new row with version + 1.
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  version INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  sync_id INTEGER NOT NULL,
  seen_at TEXT NOT NULL,             -- world time of the snapshot that first had it
  current INTEGER NOT NULL DEFAULT 1,-- 1 = this is the version in the latest snapshot
  removed_at TEXT,
  handler TEXT NOT NULL,             -- code | openai
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | done | failed | skipped
  doc_type TEXT, language TEXT, doc_date TEXT, summary TEXT, error TEXT,
  processed_at TEXT,
  UNIQUE (path, sha256)
);
CREATE INDEX IF NOT EXISTS documents_status ON documents (status, handler);

-- Append-only. Never updated, never deleted.
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  unit TEXT,
  part_id TEXT,
  source_path TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  document_id INTEGER,
  observed_at TEXT,
  recorded_at TEXT NOT NULL,
  origin TEXT NOT NULL,              -- code | openai | bootstrap | human
  confidence REAL NOT NULL,
  quote TEXT
);
CREATE INDEX IF NOT EXISTS facts_object ON facts (object_type, object_id, field);
CREATE INDEX IF NOT EXISTS facts_part ON facts (part_id);
CREATE INDEX IF NOT EXISTS facts_source ON facts (source_path);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  object_type TEXT, object_id TEXT, object_label TEXT,
  run_id TEXT,
  input TEXT, output TEXT,
  fact_ids TEXT NOT NULL DEFAULT '[]',
  model TEXT, tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL
);
CREATE INDEX IF NOT EXISTS events_object ON events (object_type, object_id);
CREATE INDEX IF NOT EXISTS events_actor ON events (actor);

CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,   -- same deviation is only raised once
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  title TEXT NOT NULL, detail TEXT NOT NULL,
  expected TEXT, actual TEXT,
  object_type TEXT NOT NULL, object_id TEXT NOT NULL,
  part_id TEXT, supplier_id TEXT,
  addressee TEXT, assignee_role TEXT, question TEXT,
  fact_ids TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL DEFAULT 'code',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS issues_part ON issues (part_id, status);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'open',
  role TEXT NOT NULL, person TEXT,
  title TEXT NOT NULL, body TEXT NOT NULL,
  issue_id INTEGER,
  object_type TEXT, object_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL, done_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  direction TEXT NOT NULL,           -- out | in
  status TEXT NOT NULL,              -- draft | needs_approval | sent | outbox | received | rejected
  from_addr TEXT NOT NULL, to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  body_original TEXT NOT NULL, body_en TEXT NOT NULL,
  supplier_id TEXT, person TEXT,
  created_by TEXT NOT NULL,
  issue_ids TEXT NOT NULL DEFAULT '[]',
  decision_id INTEGER,
  external_id TEXT UNIQUE,           -- Message-ID header, to avoid importing a mail twice
  in_reply_to TEXT,
  processed INTEGER NOT NULL DEFAULT 0,  -- inbound: 1 once the data agent has read it
  created_at TEXT NOT NULL, sent_at TEXT
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_id);

CREATE TABLE IF NOT EXISTS risks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'open',
  part_id TEXT, product_id TEXT, supplier_id TEXT,
  title TEXT NOT NULL, explanation TEXT NOT NULL,
  probability REAL NOT NULL,
  copies_at_risk INTEGER NOT NULL,
  copies_by_product TEXT NOT NULL DEFAULT '[]',
  scenario TEXT NOT NULL DEFAULT '{}',
  fact_ids TEXT NOT NULL DEFAULT '[]',
  tool_calls TEXT NOT NULL DEFAULT '[]',
  run_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  risk_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  title TEXT NOT NULL, option TEXT NOT NULL, rationale TEXT NOT NULL,
  copies_saved INTEGER NOT NULL,
  copies_by_product TEXT NOT NULL DEFAULT '[]',
  cost_eur REAL, cost_basis TEXT NOT NULL,
  approver TEXT NOT NULL,            -- JSON Approver
  mail_message_id INTEGER,
  scenario TEXT NOT NULL DEFAULT '{}', -- the action as a what-if (normalized), for the supply map
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT, decision_reason TEXT,
  approval_kind TEXT NOT NULL DEFAULT 'other',
  value_eur REAL,                    -- copies saved times what a copy is worth, null if no value is configured
  decide_by TEXT,                    -- ISO: after this time the option saves fewer copies (or the offer has run out)
  wait_copies_per_hour REAL, wait_eur_per_hour REAL, timing_basis TEXT,
  expires_at TEXT,                   -- ISO: when the offer behind the option runs out, as a source states it
  report TEXT NOT NULL DEFAULT '{}', -- JSON DecisionReport: what the agent looked at, the problem, what is agreed, what happens next
  signatures TEXT NOT NULL DEFAULT '[]', -- JSON Signature[]: who has to sign and who has
  stage TEXT NOT NULL DEFAULT 'proposed', -- proposed | approved | ordered | done | failed | withdrawn
  auto INTEGER NOT NULL DEFAULT 0,   -- 1 = the agent approved it itself, under the autonomy limit
  check_at TEXT,                     -- ISO: by when the other side should have confirmed
  closed_reason TEXT
);

-- Questions the action agent asks a supplier or a colleague. They are collected per recipient and leave as one mail.
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  risk_id INTEGER NOT NULL,
  recipient TEXT NOT NULL,           -- "supplier:<id>" or "role:<title>"
  supplier_id TEXT, role TEXT, person TEXT,
  topic TEXT NOT NULL,               -- quantity | date | price | availability | confirmation | status | other
  object_type TEXT, object_id TEXT, part_id TEXT,
  text TEXT NOT NULL,                -- the question, in English
  background TEXT,                   -- what the writer of the mail needs to know, not for the recipient
  answer_by TEXT,                    -- ISO
  status TEXT NOT NULL DEFAULT 'queued', -- queued | sent | answered | no_answer | dropped
  reminder_of INTEGER,               -- the question this one reminds of
  reminded INTEGER NOT NULL DEFAULT 0,
  message_id INTEGER, answer_message_id INTEGER, task_id INTEGER,
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL, sent_at TEXT, answered_at TEXT
);
CREATE INDEX IF NOT EXISTS questions_risk ON questions (risk_id, status);
CREATE INDEX IF NOT EXISTS questions_recipient ON questions (recipient, status);

-- What the reading agent writes down for itself and for people. Append-only.
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,               -- general | supplier:<id> | part:<id>
  text TEXT NOT NULL,
  source TEXT,                       -- the document or mail it was written while reading
  run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_topic ON notes (topic);

-- LLM-proposed column mappings for tabular files whose headers we did not know.
CREATE TABLE IF NOT EXISTS column_mappings (
  signature TEXT PRIMARY KEY,        -- target table + sorted headers
  mapping TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Base data. Rebuilt by code from the current files on every sync that touches them.
CREATE TABLE IF NOT EXISTS components (part_id TEXT PRIMARY KEY, description TEXT, category TEXT, uom TEXT, abc_class TEXT, critical INTEGER, drawing_rev TEXT);
CREATE TABLE IF NOT EXISTS products (product_id TEXT PRIMARY KEY, name TEXT, product_line TEXT, lifecycle TEXT, launch_date TEXT, plan_weekly_units REAL, std_cost_eur REAL);
CREATE TABLE IF NOT EXISTS bom (parent_id TEXT, child_id TEXT, qty_per REAL, valid_from TEXT, valid_to TEXT, PRIMARY KEY (parent_id, child_id));
CREATE TABLE IF NOT EXISTS suppliers (supplier_id TEXT PRIMARY KEY, name TEXT, legal_name TEXT, category TEXT, country TEXT, city TEXT, lat REAL, lon REAL, currency TEXT, payment_terms TEXT, incoterm TEXT, supplier_since TEXT, status TEXT, qualification_status TEXT, contact_name TEXT, contact_email TEXT, phone TEXT, language TEXT, notes TEXT, folder TEXT);
CREATE TABLE IF NOT EXISTS supplier_parts (supplier_id TEXT, part_id TEXT, share REAL, unit_price REAL, currency TEXT, lead_time_days REAL, moq REAL, is_primary INTEGER, note TEXT, PRIMARY KEY (supplier_id, part_id));
CREATE TABLE IF NOT EXISTS po_lines (po_line_id TEXT PRIMARY KEY, po_number TEXT, po_line INTEGER, supplier_id TEXT, part_id TEXT, plant TEXT, quantity REAL, unit_price REAL, currency TEXT, order_date TEXT, requested_date TEXT, promised_date TEXT, actual_delivery_date TEXT, status TEXT, buyer TEXT, incoterm TEXT, note TEXT, source_path TEXT);
CREATE INDEX IF NOT EXISTS po_lines_part ON po_lines (part_id);
CREATE TABLE IF NOT EXISTS goods_receipts (gr_number TEXT PRIMARY KEY, gr_date TEXT, po_number TEXT, po_line INTEGER, supplier_id TEXT, part_id TEXT, plant TEXT, qty_ordered REAL, qty_received REAL, delivery_note TEXT, inspector TEXT, remark TEXT);
CREATE TABLE IF NOT EXISTS stock (id INTEGER PRIMARY KEY AUTOINCREMENT, snapshot_date TEXT, site TEXT, material_id TEXT, batch TEXT, quantity REAL, uom TEXT, safety_stock REAL, weeks_of_cover REAL, last_count TEXT);
CREATE TABLE IF NOT EXISTS shipments (shipment_id TEXT PRIMARY KEY, carrier_id TEXT, mode TEXT, reference TEXT, supplier_id TEXT, po_numbers TEXT, part_ids TEXT, route_id TEXT, origin TEXT, destination TEXT, via TEXT, dest_site TEXT, etd TEXT, eta TEXT, status TEXT, last_lat REAL, last_lon REAL, updated_at TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS packout (date TEXT, site TEXT, product_id TEXT, line TEXT, units_packed REAL);
CREATE TABLE IF NOT EXISTS routes (route_id TEXT PRIMARY KEY, origin TEXT, destination TEXT, mode TEXT, carrier_id TEXT, transit_days REAL, via TEXT);
CREATE TABLE IF NOT EXISTS carriers (carrier_id TEXT PRIMARY KEY, name TEXT, city TEXT, country TEXT, modes TEXT);
CREATE TABLE IF NOT EXISTS ports (locode TEXT PRIMARY KEY, name TEXT, country TEXT, lat REAL, lon REAL, mode TEXT);
CREATE TABLE IF NOT EXISTS sites (site_id TEXT PRIMARY KEY, name TEXT, operator TEXT, type TEXT, country TEXT, city TEXT, lat REAL, lon REAL);
`);

// Columns added after a database was first created. CREATE TABLE IF NOT EXISTS leaves an existing table as it is,
// so they are added here once, guarded by the table's current column list.
const addColumn = (table: string, column: string, decl: string) => {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
};
addColumn("decisions", "scenario", "TEXT NOT NULL DEFAULT '{}'");
for (const [column, decl] of [
  ["approval_kind", "TEXT NOT NULL DEFAULT 'other'"], ["value_eur", "REAL"], ["decide_by", "TEXT"], ["wait_copies_per_hour", "REAL"], ["wait_eur_per_hour", "REAL"],
  ["timing_basis", "TEXT"], ["expires_at", "TEXT"], ["report", "TEXT NOT NULL DEFAULT '{}'"], ["signatures", "TEXT NOT NULL DEFAULT '[]'"],
  ["stage", "TEXT NOT NULL DEFAULT 'proposed'"], ["auto", "INTEGER NOT NULL DEFAULT 0"], ["check_at", "TEXT"], ["closed_reason", "TEXT"],
] as const) addColumn("decisions", column, decl);

// Columns added after the first release. Adding them to an existing database fails harmlessly once they exist.
for (const sql of ["ALTER TABLE issues ADD COLUMN note TEXT"]) {
  try { db.exec(sql); } catch { /* already there */ }
}

type Param = string | number | bigint | null | Uint8Array;
const clean = (params: unknown[]): Param[] => params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : (p as Param)));

/** Small typed helpers around node:sqlite. */
export function all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...clean(params)) as T[];
}
export function get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...clean(params)) as T | undefined;
}
export function run(sql: string, ...params: unknown[]): { changes: number; lastId: number } {
  const r = db.prepare(sql).run(...clean(params));
  return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
}
export function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; }
}

export const kv = {
  get(key: string): string | null { return get<{ value: string }>("SELECT value FROM kv WHERE key = ?", key)?.value ?? null; },
  set(key: string, value: string) { run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value); },
};

export const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (s == null || s === "") return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};
