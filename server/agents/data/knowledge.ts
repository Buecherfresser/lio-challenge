import type { Fact, ObjectType } from "../../../shared/api.ts";
import { all, get, json, run } from "../../db.ts";
import { config } from "../../config.ts";
import { nowIso } from "../../clock.ts";
import { logEvent } from "../../events.ts";
import { currentFacts } from "../../facts.ts";
import { enumT, obj, str } from "../../llm.ts";
import type { Tool } from "../../llm.ts";
import { VOCAB } from "../../vocab.ts";
import type { IssueDb } from "./rows.ts";

// Tools the reading agent and the correspondence agent share: look things up in Soony's data,
// search what is already known, and keep notes. Read-only except for notes.

const KINDS = ["any", "part", "product", "supplier", "order_line", "shipment", "lot", "role", "policy"] as const;
type Kind = (typeof KINDS)[number];

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9À-￿]+/i).filter((w) => w.length > 1);
const hit = (hay: string, q: string[]) => { const h = hay.toLowerCase(); return q.every((w) => h.includes(w)); };
const list = (s: string | null) => json<string[]>(s, []).join(", ");

/** Search ids, names, descriptions and references. Every query word must appear. */
export function find(text: string, kind: Kind = "any", limit = 30): unknown[] {
  const q = words(text);
  if (!q.length) return [];
  const out: unknown[] = [];
  const want = (k: Kind) => kind === "any" || kind === k;
  if (want("part")) for (const r of all<{ part_id: string; description: string; category: string; drawing_rev: string }>("SELECT part_id, description, category, drawing_rev FROM components"))
    if (hit(`${r.part_id} ${r.description} ${r.category}`, q)) out.push({ kind: "part", ...r });
  if (want("product")) for (const r of all<{ product_id: string; name: string; lifecycle: string }>("SELECT product_id, name, lifecycle FROM products"))
    if (hit(`${r.product_id} ${r.name}`, q)) out.push({ kind: "product", ...r });
  if (want("supplier")) for (const r of all<{ supplier_id: string; name: string; legal_name: string; country: string; language: string; contact_name: string; contact_email: string }>("SELECT supplier_id, name, legal_name, country, language, contact_name, contact_email FROM suppliers"))
    if (hit(`${r.supplier_id} ${r.name} ${r.legal_name} ${r.contact_email}`, q)) out.push({ kind: "supplier", ...r });
  if (want("order_line")) for (const r of all<{ po_line_id: string; supplier_id: string; part_id: string; quantity: number; unit_price: number; currency: string; order_date: string; requested_date: string; promised_date: string; status: string; incoterm: string }>(
    "SELECT po_line_id, supplier_id, part_id, quantity, unit_price, currency, order_date, requested_date, promised_date, status, incoterm FROM po_lines ORDER BY po_number DESC, po_line"))
    if (hit(`${r.po_line_id} ${r.supplier_id} ${r.part_id} ${r.status}`, q)) out.push({ kind: "order_line", ...r });
  if (want("shipment")) for (const r of all<{ shipment_id: string; reference: string; supplier_id: string; mode: string; po_numbers: string; part_ids: string; etd: string; eta: string; status: string; dest_site: string }>(
    "SELECT shipment_id, reference, supplier_id, mode, po_numbers, part_ids, etd, eta, status, dest_site FROM shipments"))
    if (hit(`${r.shipment_id} ${r.reference} ${r.supplier_id} ${r.po_numbers} ${r.part_ids} ${r.mode}`, q)) out.push({ kind: "shipment", ...r, po_numbers: list(r.po_numbers), part_ids: list(r.part_ids) });
  if (want("lot")) for (const r of all<{ gr_number: string; gr_date: string; po_number: string; po_line: number; supplier_id: string; part_id: string; delivery_note: string; remark: string }>(
    "SELECT gr_number, gr_date, po_number, po_line, supplier_id, part_id, delivery_note, remark FROM goods_receipts ORDER BY gr_number DESC"))
    if (hit(`${r.gr_number} ${r.delivery_note} ${r.po_number} ${r.supplier_id} ${r.part_id}`, q)) out.push({ kind: "lot", lot_id: r.gr_number, received: r.gr_date, order_line: `${r.po_number}/${r.po_line}`, supplier_id: r.supplier_id, part_id: r.part_id, delivery_note: r.delivery_note, remark: r.remark });
  for (const k of ["role", "policy"] as const) if (want(k))
    for (const r of all<{ object_id: string }>("SELECT DISTINCT object_id FROM facts WHERE object_type = ?", k)) if (hit(r.object_id, q)) out.push({ kind: k, id: r.object_id });
  return out.slice(0, limit);
}

const factView = (f: Fact) => ({ fact_id: f.id, field: f.field, value: f.value, ...(f.unit ? { unit: f.unit } : {}), ...(f.part_id ? { part_id: f.part_id } : {}), source: f.source_path, as_of: f.observed_at, origin: f.origin, confidence: f.confidence });

/** One object: its row in the customer's tables, what each source says about it right now, open issues and notes. */
export function getObject(type: string, id: string): unknown {
  const base: Record<string, () => unknown> = {
    part: () => get("SELECT * FROM components WHERE part_id = ?", id),
    product: () => get("SELECT * FROM products WHERE product_id = ?", id),
    supplier: () => get("SELECT supplier_id, name, legal_name, country, city, currency, payment_terms, incoterm, status, qualification_status, contact_name, contact_email, language, notes FROM suppliers WHERE supplier_id = ?", id),
    po_line: () => get("SELECT * FROM po_lines WHERE po_line_id = ?", id),
    shipment: () => get("SELECT * FROM shipments WHERE shipment_id = ? OR reference = ?", id, id),
    lot: () => get("SELECT * FROM goods_receipts WHERE gr_number = ?", id),
  };
  const row = base[type]?.() ?? null;
  const objId = type === "shipment" && row ? (row as { shipment_id: string }).shipment_id : id;
  const extra: Record<string, unknown> = {};
  if (type === "part") {
    extra.stock_lots = all("SELECT batch AS lot_id, quantity, snapshot_date FROM stock WHERE material_id = ? AND batch IS NOT NULL", id);
    extra.suppliers = all("SELECT supplier_id, share, unit_price, currency, lead_time_days, is_primary, note FROM supplier_parts WHERE part_id = ?", id);
    extra.used_in = all("SELECT parent_id AS product_id, qty_per FROM bom WHERE child_id = ?", id);
    extra.open_order_lines = all("SELECT po_line_id, supplier_id, quantity, requested_date, promised_date, status FROM po_lines WHERE part_id = ? AND status IN ('open', 'awaiting_approval') ORDER BY requested_date", id);
  }
  if (type === "supplier") {
    extra.parts = all("SELECT part_id, share, unit_price, currency, lead_time_days, is_primary, note FROM supplier_parts WHERE supplier_id = ?", id);
    extra.open_order_lines = all("SELECT po_line_id, part_id, quantity, unit_price, currency, requested_date, promised_date, status, incoterm FROM po_lines WHERE supplier_id = ? AND status IN ('open', 'awaiting_approval') ORDER BY po_number, po_line", id);
    extra.open_shipments = all("SELECT shipment_id, reference, mode, po_numbers, part_ids, etd, eta, status FROM shipments WHERE supplier_id = ?", id);
  }
  if (type === "lot") extra.stock = all("SELECT quantity, snapshot_date FROM stock WHERE batch = ?", id);
  const issues = all<IssueDb>("SELECT * FROM issues WHERE object_type = ? AND object_id = ? AND status != 'resolved'", type, objId)
    .map((i) => ({ issue_id: i.id, status: i.status, type: i.type, title: i.title, question: i.question }));
  const topic = type === "part" || type === "supplier" ? `${type}:${objId}` : null;
  return {
    object: `${type} ${objId}`,
    in_soony_tables: row,
    ...extra,
    facts: currentFacts("object_type = ? AND object_id = ?", type, objId).map(factView),
    open_issues: issues,
    ...(topic ? { notes: readNotes(topic) } : {}),
  };
}

/** Free-text search over notes, document summaries and the free-text facts (notices, offers, terms). */
export function search(text: string, limit = 20): unknown[] {
  const q = words(text);
  if (!q.length) return [];
  const score = (s: string) => q.filter((w) => s.toLowerCase().includes(w)).length;
  const need = Math.max(1, Math.ceil(q.length / 2));
  const rows: { score: number; item: unknown }[] = [];
  for (const n of all<{ id: number; topic: string; text: string; source: string | null; created_at: string }>("SELECT id, topic, text, source, created_at FROM notes")) {
    const sc = score(`${n.topic} ${n.text}`); if (sc >= need) rows.push({ score: sc, item: { kind: "note", ...n } });
  }
  for (const d of all<{ path: string; version: number; doc_type: string; doc_date: string; summary: string }>("SELECT path, version, doc_type, doc_date, summary FROM documents WHERE current = 1 AND summary IS NOT NULL")) {
    const sc = score(`${d.path} ${d.summary}`); if (sc >= need) rows.push({ score: sc, item: { kind: "document", ...d } });
  }
  for (const f of currentFacts("field IN ('notice', 'offer', 'capacity_note', 'contract_term', 'note', 'defect_note', 'responsibility', 'approval_rule')")) {
    const sc = score(`${f.object_id} ${f.value}`); if (sc >= need) rows.push({ score: sc, item: { kind: "fact", object: `${f.object_type} ${f.object_id}`, ...factView(f) } });
  }
  return rows.sort((a, b) => b.score - a.score).slice(0, limit).map((r) => r.item);
}

export function readNotes(topic: string): { note_id: number; text: string; source: string | null; written: string }[] {
  return all<{ id: number; text: string; source: string | null; created_at: string }>("SELECT id, text, source, created_at FROM notes WHERE topic = ? ORDER BY id", topic)
    .map((n) => ({ note_id: n.id, text: n.text, source: n.source, written: n.created_at }));
}

/** Topics look like general, supplier:<id> or part:<id>. Anything else is filed under general. */
export function normTopic(topic: string): string {
  const m = topic.trim().match(/^(supplier|part)\s*[:/ ]\s*(\S+)$/i);
  if (!m) return "general";
  const id = m[2].toUpperCase();
  const table = m[1].toLowerCase() === "supplier" ? "suppliers WHERE supplier_id" : "components WHERE part_id";
  return get(`SELECT 1 AS x FROM ${table} = ?`, id) ? `${m[1].toLowerCase()}:${id}` : "general";
}

export function writeNote(topic: string, text: string, source: string | null, runId: string | null): number {
  const t = normTopic(topic);
  const id = run("INSERT INTO notes (topic, text, source, run_id, created_at) VALUES (?, ?, ?, ?, ?)", t, text.trim(), source, runId, nowIso()).lastId;
  const [type, objId] = t.includes(":") ? (t.split(":") as [ObjectType, string]) : [null, null];
  logEvent({ actor: "data_agent", action: "note.written", run_id: runId, object: type && objId ? { type, id: objId } : null,
    summary: `I noted${type ? ` on ${objId}` : ""}: ${text.trim().replace(/\s+/g, " ").slice(0, 220)}`, input: { source }, output: { note_id: id, topic: t, text } });
  return id;
}

/** The tools as the model sees them. `source` is the document being read, if any. */
export function knowledgeTools(ctx: { source: string | null; runId: string | null; notesWritten?: number[] }, opts: { canWrite: boolean }): Tool[] {
  const tools: Tool[] = [
    { name: "find", description: `Search ${config.customer.name}'s data by id, name, description, order number, container or air waybill number, delivery note number. Every word must match.`,
      parameters: obj({ text: str(), kind: enumT([...KINDS]) }), run: (a: { text: string; kind: Kind }) => find(a.text, a.kind) },
    { name: "get", description: `One object: its row in ${config.customer.name}'s tables, what each source says about it now (with fact ids), open issues and notes.`,
      parameters: obj({ object_type: enumT(Object.keys(VOCAB)), object_id: str() }), run: (a: { object_type: string; object_id: string }) => getObject(a.object_type, a.object_id) },
    { name: "search", description: "Search notes, summaries of documents already read, and notices, offers and contract terms.",
      parameters: obj({ text: str() }), run: (a: { text: string }) => search(a.text) },
    { name: "read_notes", description: "Notes on one topic: general, supplier:<id> or part:<id>.",
      parameters: obj({ topic: str() }), run: (a: { topic: string }) => readNotes(normTopic(a.topic)) },
  ];
  if (opts.canWrite) tools.push({
    name: "note", description: "Write a note on a topic (general, supplier:<id> or part:<id>). Notes are kept and shown with the part or supplier.",
    parameters: obj({ topic: str(), text: str() }),
    run: (a: { topic: string; text: string }) => { const id = writeNote(a.topic, a.text, ctx.source, ctx.runId); ctx.notesWritten?.push(id); return { note_id: id, topic: normTopic(a.topic) }; },
  });
  return tools;
}

