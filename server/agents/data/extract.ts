import type { ObjectRef } from "../../../shared/api.ts";
import { portal } from "../../adapters/index.ts";
import { config } from "../../config.ts";
import { all, get, tx } from "../../db.ts";
import { logEvent } from "../../events.ts";
import { addFact } from "../../facts.ts";
import { llmAvailable, obj, prompt, structured } from "../../llm.ts";
import { storeMapping } from "../../ingest/base.ts";
import type { BaseLoadResult } from "../../ingest/base.ts";
import { parseDate } from "../../vocab.ts";
import type { Rejected, ResolvedFact } from "./resolve.ts";

// Helpers the reading agent shares: storing checked facts, the reading order of the queue, telling a
// service failure from a bad document, and the one-off column mapping for base files with unknown headers.

/** Document date as stated by the model, in canonical form. null if it is missing or unreadable. */
export function observedAt(docDate: string | null | undefined): string | null {
  if (!docDate) return null;
  const d = parseDate(String(docDate).trim());
  if (!d) return null;
  const y = Number(d.slice(0, 4));
  return y >= 2000 && y <= 2100 ? d : null;
}

export interface StoredFacts { fact_ids: number[]; new_ids: number[]; stored: { id: number; isNew: boolean; fact: ResolvedFact }[] }

/** Write resolved facts. Append-only: an unchanged statement of the same source is not written again. */
export function storeFacts(facts: ResolvedFact[], src: { source_path: string; source_version: number; document_id?: number | null; observed_at: string | null; origin: "openai" | "bootstrap" }): StoredFacts {
  return tx(() => {
    const out: StoredFacts = { fact_ids: [], new_ids: [], stored: [] };
    for (const f of facts) {
      const r = addFact({
        object_type: f.object_type, object_id: f.object_id, field: f.field, value: f.value, unit: f.unit, part_id: f.part_id,
        source_path: src.source_path, source_version: src.source_version, document_id: src.document_id ?? null,
        observed_at: src.observed_at, origin: src.origin, confidence: f.confidence, quote: f.quote,
      });
      out.fact_ids.push(r.id);
      if (r.isNew) out.new_ids.push(r.id);
      out.stored.push({ id: r.id, isNew: r.isNew, fact: f });
    }
    return out;
  });
}

export const factForLog = (s: StoredFacts["stored"][number]) => ({
  fact_id: s.id, object: `${s.fact.object_type} ${s.fact.object_id}`, field: s.fact.field, value: s.fact.value, unit: s.fact.unit, part_id: s.fact.part_id,
  confidence: s.fact.confidence, quote: s.fact.quote, ...(s.fact.notes.length ? { notes: s.fact.notes } : {}), ...(s.isNew ? {} : { already_known: true }),
});
export const rejectedForLog = (r: Rejected) => ({ object: `${r.raw.object_type} ${r.raw.object_id}`, field: r.raw.field, value: r.raw.value, part_id: r.raw.part_id, quote: r.raw.quote, reason: r.reason });

export interface DocRow { id: number; path: string; sha256: string; version: number; bytes: number; sync_id: number; seen_at: string }

/** Errors that say something about the service or the key, not about the document. The document stays in the queue. */
export function isServiceError(e: unknown): boolean {
  const x = e as { status?: unknown; name?: unknown; code?: unknown; message?: unknown };
  const status = typeof x?.status === "number" ? x.status : null;
  if (status !== null) return status === 401 || status === 403 || status === 404 || status === 408 || status === 409 || status === 429 || status >= 500;
  return /connection|timeout|timed out|network|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|OPENAI_API_KEY|OPENAI_BUDGET_USD/i.test(`${String(x?.name ?? "")} ${String(x?.code ?? "")} ${String(x?.message ?? "")}`);
}

/**
 * The order in which waiting documents are read. Lower is earlier:
 * 0 new or replaced since the first sync, 1 context, news, logistics and notices, 2 shipping advices and packing lists,
 * 3 order confirmations of orders that are still open, 4 receiving scans (newest first), 5 contracts, 6 the rest.
 */
export function readingOrder(docs: DocRow[]): DocRow[] {
  const firstSync = get<{ id: number | null }>("SELECT MIN(id) AS id FROM syncs")?.id ?? 0;
  const openOrders = new Set(all<{ po_number: string }>("SELECT DISTINCT po_number FROM po_lines WHERE status IN ('open', 'awaiting_approval')").map((r) => r.po_number));
  const base = (p: string) => p.split("/").pop() ?? p;
  const rank = (d: DocRow): number => {
    const p = d.path.toLowerCase(), b = base(p);
    if (d.version > 1 || d.sync_id > firstSync) return 0;
    if (portal.readFirst.test(p) || p.includes("/notices/")) return 1;
    if (!p.includes("/receiving/") && /(ship|advice|pack|^pl[_\-.]|asn|dispatch|despatch|awb|waybill|lading)/.test(b)) return 2;
    if (p.includes("/order_confirmations/") && (d.path.match(/\d{8,}/g) ?? []).some((n) => openOrders.has(n))) return 3;
    if (p.includes("/receiving/")) return 4;
    if (p.includes("/contracts/")) return 5;
    return 6;
  };
  // Inside a group the newest comes first: by a date in the file name where there is one (a file without a date counts
  // as current), then by the name itself, which often carries a running number.
  const dated = (name: string): string => {
    let best = "";
    for (const m of name.matchAll(/(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?!\d)/g)) {
      if (Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 && Number(m[3]) <= 31 && `${m[1]}${m[2]}${m[3]}` > best) best = `${m[1]}${m[2]}${m[3]}`;
    }
    return best || "99999999";
  };
  const ranked = docs.map((d) => ({ d, r: rank(d), when: dated(base(d.path)) }));
  ranked.sort((a, b) => a.r - b.r || (a.r === 0 ? b.d.sync_id - a.d.sync_id : 0) || b.when.localeCompare(a.when) || base(b.d.path).localeCompare(base(a.d.path)) || a.d.path.localeCompare(b.d.path));
  return ranked.map((x) => x.d);
}

type MappingItem = BaseLoadResult["needsMapping"][number];

/**
 * A base table file whose required columns code could not find: ask a model once which column is which.
 * The answer is stored and from then on applied by code. Returns the stored mapping, or null if there is none.
 */
export async function proposeColumnMapping(item: MappingItem, runId?: string): Promise<Record<string, string | null> | null> {
  const object: ObjectRef = { type: "document", id: item.doc.path };
  if (!llmAvailable()) {
    logEvent({ actor: "data_agent", action: "base.mapping_waiting", run_id: runId, object, summary: `I cannot match the columns of ${item.doc.path} without an OpenAI key, so the file stays out.`, output: { missing: item.missing, headers: item.headers } });
    return null;
  }
  try {
    const fields = item.spec.cols.map((c) => ({ name: c.name, kind: c.kind, required: Boolean(c.required) }));
    const columns = [...new Set(item.headers.filter((h) => h.trim()))];
    const schema = obj(Object.fromEntries(fields.map((c) => [c.name, { type: ["string", "null"], enum: [...columns, null], description: `column that holds ${c.name} (${c.kind})${c.required ? ", required" : ""}` }])));
    const user = [
      `File: ${item.doc.path}`,
      `It should fill the table "${item.spec.table}" (${item.spec.describe}).`,
      `Target fields (name, kind, required): ${fields.map((c) => `${c.name} (${c.kind}${c.required ? ", required" : ""})`).join(", ")}`,
      `Fields code could not find: ${item.missing.join(", ")}`,
      `Columns in the file: ${JSON.stringify(item.headers)}`,
      `First rows:\n${JSON.stringify(item.sample, null, 1)}`,
    ].join("\n\n");
    const { data, usage } = await structured<Record<string, string | null>>({ model: config.openai.modelExtract, system: prompt("data_columns.md"), user, schemaName: "column_mapping", schema });
    const mapping: Record<string, string | null> = {};
    const used = new Set<string>();
    for (const c of fields) {
      const col = data[c.name];
      // Only real columns, and each column for one field.
      mapping[c.name] = typeof col === "string" && item.headers.includes(col) && !used.has(col) ? col : null;
      if (mapping[c.name]) used.add(mapping[c.name]!);
    }
    const stillMissing = fields.filter((c) => c.required && !mapping[c.name] && item.missing.includes(c.name)).map((c) => c.name);
    storeMapping(item.spec, item.headers, mapping);
    logEvent({
      actor: "data_agent", action: "base.mapping_proposed", run_id: runId, object,
      summary: stillMissing.length
        ? `I matched the columns of ${item.doc.path} as far as I could, and ${stillMissing.join(", ")} still has no column.`
        : `I matched the unknown columns of ${item.doc.path} to the fields of the ${item.spec.describe}.`,
      input: { headers: item.headers, missing: item.missing, sample: item.sample.slice(0, 3) }, output: { mapping, still_missing: stillMissing },
      model: usage.model, tokens_in: usage.tokens_in, tokens_out: usage.tokens_out, cost_usd: usage.cost_usd,
    });
    return mapping;
  } catch (e) {
    logEvent({ actor: "data_agent", action: "base.mapping_failed", run_id: runId, object, summary: `I could not match the columns of ${item.doc.path}: ${(e as Error).message.slice(0, 200)}`, output: { error: String((e as Error).message) } });
    return null;
  }
}

