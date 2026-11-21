import fs from "node:fs";
import type { ObjectType } from "../../../shared/api.ts";
import { all, get, run, tx } from "../../db.ts";
import { logEvent } from "../../events.ts";
import { addFact } from "../../facts.ts";
import { fieldDef } from "../../vocab.ts";

// The demo backup. bootstrap-export writes what a model has read out of the documents to one file.
// bootstrap-import stores those results for documents that are still waiting and have exactly the same content
// (same path, same SHA-256), without calling a model. Facts stored this way carry the origin "bootstrap".

interface BootFact { object_type: string; object_id: string; field: string; value: string; unit: string | null; part_id: string | null; observed_at: string | null; confidence: number; quote: string | null }
interface BootDoc { path: string; sha256: string; doc_type: string | null; language: string | null; doc_date: string | null; summary: string | null; facts: BootFact[] }
interface BootFile { format: "lineguard-bootstrap-1"; exported_at: string; documents: BootDoc[] }

export function bootstrapExport(file: string): { documents: number; facts: number } {
  const docs = all<{ id: number; path: string; sha256: string; doc_type: string | null; language: string | null; doc_date: string | null; summary: string | null }>(
    "SELECT id, path, sha256, doc_type, language, doc_date, summary FROM documents WHERE handler = 'openai' AND status = 'done' ORDER BY path, version");
  const out: BootFile = { format: "lineguard-bootstrap-1", exported_at: new Date().toISOString(), documents: [] };
  let n = 0;
  for (const doc of docs) {
    const facts = all<BootFact>(
      "SELECT object_type, object_id, field, value, unit, part_id, observed_at, confidence, quote FROM facts WHERE document_id = ? AND origin IN ('openai', 'bootstrap') ORDER BY id", doc.id);
    n += facts.length;
    out.documents.push({ path: doc.path, sha256: doc.sha256, doc_type: doc.doc_type, language: doc.language, doc_date: doc.doc_date, summary: doc.summary, facts });
  }
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  return { documents: out.documents.length, facts: n };
}

export function bootstrapImport(file: string, runId?: string): { documents: number; facts: number; not_matching: number } {
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as BootFile;
  if (data.format !== "lineguard-bootstrap-1" || !Array.isArray(data.documents)) throw new Error(`${file} is not a bootstrap file.`);
  const res = { documents: 0, facts: 0, not_matching: 0 };
  for (const b of data.documents) {
    const doc = get<{ id: number; version: number }>("SELECT id, version FROM documents WHERE path = ? AND sha256 = ? AND handler = 'openai' AND status = 'pending'", b.path, b.sha256);
    if (!doc) { res.not_matching++; continue; }
    const factIds: number[] = [];
    let fresh = 0;
    tx(() => {
      for (const f of b.facts ?? []) {
        if (!fieldDef(f.object_type, f.field)) continue; // the vocabulary has moved on
        const r = addFact({ object_type: f.object_type as ObjectType, object_id: f.object_id, field: f.field, value: f.value, unit: f.unit, part_id: f.part_id,
          source_path: b.path, source_version: doc.version, document_id: doc.id, observed_at: f.observed_at, origin: "bootstrap", confidence: f.confidence, quote: f.quote });
        factIds.push(r.id);
        if (r.isNew) fresh++;
      }
      run("UPDATE documents SET status = 'done', doc_type = ?, language = ?, doc_date = ?, summary = ?, error = NULL, processed_at = ? WHERE id = ?", b.doc_type, b.language, b.doc_date, b.summary, new Date().toISOString(), doc.id);
    });
    res.documents++; res.facts += fresh;
    logEvent({ actor: "data_agent", action: "document.bootstrap", run_id: runId, object: { type: "document", id: b.path },
      summary: `I took the stored reading of ${b.path} instead of asking a model and got ${factIds.length} ${factIds.length === 1 ? "fact" : "facts"}.`,
      input: { path: b.path, sha256: b.sha256, from: file, read_on: data.exported_at }, output: { doc_type: b.doc_type, doc_date: b.doc_date, summary: b.summary, facts: factIds.length }, fact_ids: factIds });
  }
  logEvent({ actor: "data_agent", action: "bootstrap.imported", run_id: runId,
    summary: `I loaded stored readings for ${res.documents} waiting documents (${res.facts} new facts) from a backup file, without calling a model.`,
    input: { file, exported_at: data.exported_at, documents_in_file: data.documents.length }, output: res });
  return res;
}
