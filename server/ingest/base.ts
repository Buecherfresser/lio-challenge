import { all, db, get, run, tx } from "../db.ts";
import { readBlob } from "../sync/archive.ts";
import { readTable } from "../readers.ts";
import type { Table } from "../readers.ts";
import { parseDate, parseNumber } from "../vocab.ts";
import { addFact } from "../facts.ts";
import { logEvent } from "../events.ts";
import type { ObjectType } from "../../shared/api.ts";

// Base data: master data, purchase orders (both exports unified), goods receipts, stock, shipments, pack-out log.
// Loaded by code. Column names are matched through aliases because the exports differ and change.
// If a required column cannot be found, a model may propose a mapping once (see proposeMapping in main wiring);
// the mapping is stored and from then on applied by code.

type Kind = "text" | "number" | "int" | "date" | "datetime" | "bool" | "list";
interface Col { name: string; kind: Kind; required?: boolean; aliases?: string[] }
interface Spec { table: string; match: RegExp; cols: Col[]; describe: string }

const c = (name: string, kind: Kind = "text", required = false, ...aliases: string[]): Col => ({ name, kind, required, aliases });

export const SPECS: Spec[] = [
  { table: "components", match: /^soony\/master\/components\.csv$/i, describe: "component master", cols: [
    c("part_id", "text", true, "component_id", "material_id", "matnr"), c("description"), c("category"), c("uom"), c("abc_class"), c("critical", "bool"), c("drawing_rev") ] },
  { table: "products", match: /^soony\/master\/products\.csv$/i, describe: "finished products", cols: [
    c("product_id", "text", true), c("name"), c("product_line"), c("lifecycle"), c("launch_date", "date"), c("plan_weekly_units", "number"), c("std_cost_eur", "number") ] },
  { table: "bom", match: /^soony\/master\/bom\.csv$/i, describe: "bill of materials", cols: [
    c("parent_id", "text", true, "product_id"), c("child_id", "text", true, "component_id"), c("qty_per", "number", true, "quantity", "qty"), c("valid_from", "date"), c("valid_to", "date") ] },
  { table: "routes", match: /^soony\/master\/routes\.csv$/i, describe: "transport routes", cols: [
    c("route_id", "text", true), c("origin"), c("destination"), c("mode"), c("carrier_id"), c("transit_days", "number"), c("via") ] },
  { table: "carriers", match: /^soony\/master\/logistics_providers\.csv$/i, describe: "logistics providers", cols: [
    c("carrier_id", "text", true), c("name"), c("city"), c("country"), c("modes") ] },
  { table: "ports", match: /^soony\/master\/ports\.csv$/i, describe: "ports and airports", cols: [
    c("locode", "text", true), c("name"), c("country"), c("lat", "number"), c("lon", "number"), c("mode") ] },
  { table: "sites", match: /^soony\/master\/sites\.csv$/i, describe: "Soony sites", cols: [
    c("site_id", "text", true), c("name"), c("operator"), c("type"), c("country"), c("city"), c("lat", "number"), c("lon", "number") ] },
  { table: "suppliers", match: /^suppliers\/[^/]+\/profile\.csv$/i, describe: "supplier profile", cols: [
    c("supplier_id", "text", true), c("name"), c("legal_name"), c("category"), c("country"), c("city"), c("lat", "number"), c("lon", "number"), c("currency"), c("payment_terms"), c("incoterm"),
    c("supplier_since", "date"), c("status"), c("qualification_status"), c("contact_name"), c("contact_email"), c("phone"), c("language", "text", false, "preferred_language"), c("notes") ] },
  { table: "supplier_parts", match: /^suppliers\/[^/]+\/components\.csv$/i, describe: "parts a supplier delivers", cols: [
    c("part_id", "text", true, "component_id"), c("share", "number"), c("unit_price", "number"), c("currency"), c("lead_time_days", "number"), c("moq", "number"), c("is_primary", "bool", false, "primary"), c("note") ] },
  { table: "po_lines", match: /^soony\/erp\/purchase_orders[^/]*\.csv$/i, describe: "purchase order lines", cols: [
    c("po_number", "text", true, "ebeln"), c("po_line", "int", true, "ebelp"), c("supplier_id", "text", true, "lifnr"), c("part_id", "text", true, "material_id", "matnr"), c("plant", "text", false, "werks"),
    c("quantity", "number", true, "menge"), c("unit_price", "number", false, "netpr"), c("currency", "text", false, "waers"), c("order_date", "date", false, "bedat"), c("requested_date", "date", false, "eindt"),
    c("promised_date", "date", false, "zzconf"), c("actual_delivery_date", "date", false, "wedat"), c("status", "text", false, "zzstat"), c("buyer", "text", false, "ernam"), c("incoterm"), c("note") ] },
  { table: "goods_receipts", match: /^soony\/erp\/goods_receipts[^/]*\.csv$/i, describe: "goods receipts", cols: [
    c("gr_number", "text", true), c("gr_date", "date"), c("po_number"), c("po_line", "int"), c("supplier_id"), c("part_id", "text", true, "material_id"), c("plant"),
    c("qty_ordered", "number"), c("qty_received", "number", true), c("delivery_note"), c("inspector"), c("remark") ] },
  { table: "stock", match: /^soony\/erp\/stock_snapshot[^/]*\.csv$/i, describe: "stock snapshot", cols: [
    c("snapshot_date", "date"), c("site"), c("material_id", "text", true, "part_id", "component_id"), c("batch"), c("quantity", "number", true), c("uom"), c("safety_stock", "number"), c("weeks_of_cover", "number"), c("last_count", "date") ] },
  { table: "shipments", match: /^soony\/erp\/open_shipments[^/]*\.csv$/i, describe: "open shipments", cols: [
    c("shipment_id", "text", true), c("carrier_id"), c("mode"), c("reference"), c("supplier_id"), c("po_numbers", "list"), c("part_ids", "list", false, "material_ids"), c("route_id"), c("origin"), c("destination"), c("via"),
    c("dest_site"), c("etd", "date"), c("eta", "date"), c("status"), c("last_lat", "number"), c("last_lon", "number"), c("updated_at", "datetime"), c("note") ] },
  { table: "packout", match: /^soony\/erp\/packout_log[^/]*\.csv$/i, describe: "pack-out log", cols: [
    c("date", "date", true), c("site"), c("product_id", "text", true), c("line"), c("units_packed", "number", true) ] },
];

export const specFor = (path: string): Spec | null => SPECS.find((s) => s.match.test(path)) ?? null;
/** Known tabular base files are loaded by code, everything else is read by the data agent. */
export const handlerFor = (path: string): "code" | "openai" => (specFor(path) ? "code" : "openai");

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
const STATUS_CODES: Record<string, string> = { gl: "delivered", lo: "cancelled", of: "open" }; // SAP status codes of the old export

export interface ColumnResolution { mapping: Record<string, string | null>; missing: string[] }

/** Match the columns of a file to the target fields: by name, by alias, then by a stored mapping. */
export function resolveColumns(spec: Spec, headers: string[]): ColumnResolution {
  const byNorm = new Map(headers.map((h) => [norm(h), h]));
  const stored = get<{ mapping: string }>("SELECT mapping FROM column_mappings WHERE signature = ?", signature(spec, headers));
  const storedMap = stored ? (JSON.parse(stored.mapping) as Record<string, string | null>) : {};
  const mapping: Record<string, string | null> = {};
  for (const col of spec.cols) {
    const hit = [col.name, ...(col.aliases ?? [])].map(norm).map((n) => byNorm.get(n)).find(Boolean);
    mapping[col.name] = hit ?? (storedMap[col.name] && headers.includes(storedMap[col.name]!) ? storedMap[col.name]! : null);
  }
  return { mapping, missing: spec.cols.filter((x) => x.required && !mapping[x.name]).map((x) => x.name) };
}
export const signature = (spec: Spec, headers: string[]) => `${spec.table}|${[...headers].map(norm).sort().join(",")}`;
export function storeMapping(spec: Spec, headers: string[], mapping: Record<string, string | null>) {
  run("INSERT INTO column_mappings (signature, mapping, created_at) VALUES (?, ?, ?) ON CONFLICT(signature) DO UPDATE SET mapping = excluded.mapping", signature(spec, headers), JSON.stringify(mapping), new Date().toISOString());
}

function convert(table: Table, spec: Spec, mapping: Record<string, string | null>): Record<string, unknown>[] {
  // Slash dates are ambiguous (11/12/2026). Decide per column from the values that are not.
  const dayFirst: Record<string, boolean> = {};
  for (const col of spec.cols.filter((x) => x.kind === "date" && mapping[x.name])) {
    let df = false, mf = false;
    for (const r of table.rows) {
      const m = r[mapping[col.name]!]?.match(/^(\d{1,2})\/(\d{1,2})\/\d{4}$/);
      if (m) { if (Number(m[1]) > 12) df = true; if (Number(m[2]) > 12) mf = true; }
    }
    dayFirst[col.name] = df && !mf;
  }
  return table.rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const col of spec.cols) {
      const raw = mapping[col.name] ? (r[mapping[col.name]!] ?? "") : "";
      switch (col.kind) {
        case "number": o[col.name] = raw === "" ? null : parseNumber(raw); break;
        case "int": { const n = parseNumber(raw); o[col.name] = n === null ? null : Math.round(n); break; }
        case "date": o[col.name] = raw === "" ? null : (parseDate(raw, dayFirst[col.name])?.slice(0, 10) ?? null); break;
        case "datetime": o[col.name] = raw === "" ? null : parseDate(raw); break;
        case "bool": o[col.name] = /^(y|yes|true|1|x)$/i.test(raw) ? 1 : 0; break;
        case "list": o[col.name] = JSON.stringify(raw.split(/[|;,]/).map((x) => x.trim()).filter(Boolean)); break;
        default: o[col.name] = raw === "" ? null : raw;
      }
    }
    return o;
  });
}

interface DocRow { id: number; path: string; sha256: string; version: number; seen_at: string }

export interface BaseLoadResult { loaded: { path: string; table: string; rows: number }[]; needsMapping: { doc: DocRow; spec: Spec; headers: string[]; sample: Record<string, string>[]; missing: string[] }[]; facts: number }

/**
 * Rebuild all base tables from the files of the current snapshot and record the values as facts.
 * Files with required columns we cannot find are returned in needsMapping and left out.
 */
export function loadBase(): BaseLoadResult {
  const docs = all<DocRow>("SELECT id, path, sha256, version, seen_at FROM documents WHERE current = 1 AND handler = 'code' ORDER BY path");
  const result: BaseLoadResult = { loaded: [], needsMapping: [], facts: 0 };
  const perTable = new Map<string, { doc: DocRow; rows: Record<string, unknown>[] }[]>();

  for (const doc of docs) {
    const spec = specFor(doc.path)!;
    try {
      const table = readTable(readBlob(doc.sha256));
      const res = resolveColumns(spec, table.headers);
      if (res.missing.length) {
        result.needsMapping.push({ doc, spec, headers: table.headers, sample: table.rows.slice(0, 5), missing: res.missing });
        run("UPDATE documents SET status = 'failed', error = ?, processed_at = ? WHERE id = ?", `columns not found: ${res.missing.join(", ")}`, new Date().toISOString(), doc.id);
        continue;
      }
      const rows = convert(table, spec, res.mapping);
      if (!perTable.has(spec.table)) perTable.set(spec.table, []);
      perTable.get(spec.table)!.push({ doc, rows });
      result.loaded.push({ path: doc.path, table: spec.table, rows: rows.length });
      run("UPDATE documents SET status = 'done', doc_type = ?, error = NULL, processed_at = ? WHERE id = ?", spec.describe, new Date().toISOString(), doc.id);
    } catch (e) {
      run("UPDATE documents SET status = 'failed', error = ?, processed_at = ? WHERE id = ?", String((e as Error).message), new Date().toISOString(), doc.id);
      logEvent({ actor: "sync", action: "base.failed", summary: `I could not load ${doc.path}: ${(e as Error).message}.`, object: { type: "document", id: doc.path } });
    }
  }

  tx(() => {
    for (const spec of SPECS) {
      const parts = perTable.get(spec.table) ?? [];
      if (!parts.length) continue; // file missing or unreadable: keep what we had
      db.exec(`DELETE FROM ${spec.table}`);
      for (const { doc, rows } of parts) for (const row of rows) insertRow(spec.table, row, doc, rows);
    }
    for (const [table, parts] of perTable) for (const { doc, rows } of parts) result.facts += emitFacts(table, rows, doc);
  });
  return result;
}

function insertRow(table: string, row: Record<string, unknown>, doc: DocRow, allRows: Record<string, unknown>[]) {
  const r = { ...row };
  if (table === "suppliers") r.folder = doc.path.split("/").slice(0, 2).join("/");
  if (table === "supplier_parts") r.supplier_id = doc.path.match(/SUP-\d+/)?.[0] ?? null;
  if (table === "po_lines") {
    r.po_line = lineNo(r.po_line as number | null, allRows);
    r.supplier_id = supplierId(r.supplier_id as string | null);
    r.status = normStatus(r.status as string | null);
    r.po_line_id = `${r.po_number}/${r.po_line}`;
    r.source_path = doc.path;
  }
  if (table === "goods_receipts") r.po_line = lineNo(r.po_line as number | null, allRows);
  const keys = Object.keys(r);
  run(`INSERT OR REPLACE INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, ...keys.map((k) => r[k]));
}

/** The old export counts lines 00010, 00020; the new one 1, 2. Supplier documents use the 00010 style. */
function lineNo(n: number | null, allRows: Record<string, unknown>[]): number | null {
  if (n === null) return null;
  const tens = allRows.every((x) => x.po_line === null || (x.po_line as number) % 10 === 0);
  return tens ? n / 10 : n;
}
export const normalizeLineNo = (n: number): number => (n >= 10 && n % 10 === 0 ? n / 10 : n);
const supplierId = (s: string | null): string | null => (s && /^\d+$/.test(s) ? `SUP-${s.padStart(4, "0")}` : s);
const normStatus = (s: string | null): string | null => (s ? (STATUS_CODES[s.toLowerCase()] ?? s.toLowerCase().replace(/\s+/g, "_")) : s);

function emitFacts(table: string, rows: Record<string, unknown>[], doc: DocRow): number {
  let n = 0;
  const put = (object_type: ObjectType, object_id: string, field: string, value: unknown, extra: { unit?: string | null; part_id?: string | null; observed_at?: string | null } = {}) => {
    if (value === null || value === undefined || value === "") return;
    const r = addFact({ object_type, object_id, field, value: String(value), unit: extra.unit ?? null, part_id: extra.part_id ?? null,
      source_path: doc.path, source_version: doc.version, document_id: doc.id, observed_at: extra.observed_at ?? doc.seen_at, origin: "code", confidence: 1 });
    if (r.isNew) n++;
  };
  const bool = (v: unknown) => (v ? "true" : "false");
  for (const r of rows) {
    switch (table) {
      case "components":
        put("part", r.part_id as string, "drawing_rev", r.drawing_rev); put("part", r.part_id as string, "critical", bool(r.critical)); break;
      case "suppliers":
        for (const k of ["status", "qualification_status", "contact_email", "language"]) put("supplier", r.supplier_id as string, k, r[k]); break;
      case "po_lines": {
        const id = `${r.po_number}/${lineNo(r.po_line as number | null, rows)}`; const part = r.part_id as string;
        put("po_line", id, "qty_ordered", r.quantity, { part_id: part });
        put("po_line", id, "unit_price", r.unit_price, { part_id: part, unit: r.currency as string | null });
        put("po_line", id, "requested_date", r.requested_date, { part_id: part });
        put("po_line", id, "promised_date", r.promised_date, { part_id: part });
        put("po_line", id, "actual_delivery_date", r.actual_delivery_date, { part_id: part });
        put("po_line", id, "erp_status", normStatus(r.status as string | null), { part_id: part });
        break;
      }
      case "goods_receipts": {
        const lot = r.gr_number as string; const part = r.part_id as string; const at = (r.gr_date as string | null) ?? doc.seen_at;
        put("lot", lot, "qty", r.qty_received, { part_id: part, observed_at: at });
        put("lot", lot, "received_date", r.gr_date, { part_id: part, observed_at: at });
        put("lot", lot, "delivery_note", r.delivery_note, { part_id: part, observed_at: at });
        put("lot", lot, "note", r.remark, { part_id: part, observed_at: at });
        break;
      }
      case "stock": {
        const m = r.material_id as string; const at = (r.snapshot_date as string | null) ?? doc.seen_at;
        if (m.startsWith("FG-")) put("product", m, "packed", r.quantity, { observed_at: at });
        else if (r.batch) put("lot", r.batch as string, "stock_qty", r.quantity, { part_id: m, observed_at: at });
        break;
      }
      case "shipments": {
        const id = r.shipment_id as string; const at = (r.updated_at as string | null) ?? doc.seen_at;
        for (const k of ["etd", "eta", "status", "mode", "note"]) put("shipment", id, k, r[k], { observed_at: at });
        put("shipment", id, "last_update", r.updated_at, { observed_at: at });
        if (r.last_lat !== null && r.last_lon !== null) put("shipment", id, "position", `${r.last_lat},${r.last_lon}`, { observed_at: at });
        break;
      }
    }
  }
  if (table === "stock") {
    const sums = new Map<string, { q: number; at: string | null }>();
    for (const r of rows) { const m = r.material_id as string; if (m.startsWith("FG-")) continue; const s = sums.get(m) ?? { q: 0, at: r.snapshot_date as string | null }; s.q += (r.quantity as number) ?? 0; sums.set(m, s); }
    for (const [m, s] of sums) put("part", m, "stock_qty", s.q, { observed_at: s.at ?? doc.seen_at });
  }
  return n;
}
