import type { IssueType, ObjectType } from "../../../shared/api.ts";
import { config } from "../../config.ts";
import { all, get, json, kv, run, tx } from "../../db.ts";
import { now, nowIso } from "../../clock.ts";
import { logEvent } from "../../events.ts";
import { arr, enumT, llmAvailable, nullable, numT, obj, prompt, runAgent, str, withStyle } from "../../llm.ts";
import type { Part, Tool } from "../../llm.ts";
import { readForModel } from "../../readers.ts";
import type { Readable } from "../../readers.ts";
import { readBlob } from "../../sync/archive.ts";
import { VOCAB, vocabForPrompt } from "../../vocab.ts";
import { masterBlock, receiptsInFileName, supplierOfPath } from "./context.ts";
import { factForLog, isServiceError, observedAt, readingOrder, rejectedForLog, storeFacts } from "./extract.ts";
import type { DocRow } from "./extract.ts";
import { knowledgeTools, readNotes } from "./knowledge.ts";
import { loadLookup, resolveFact } from "./resolve.ts";
import type { RawFact, Rejected, ResolvedFact } from "./resolve.ts";
import { replyBy } from "./people.ts";
import { sayDate } from "./rows.ts";
import type { IssueDb, MessageDb } from "./rows.ts";

// The reading agent. It works through every new or changed document and every received mail, one at a time,
// with tools: it looks things up, records facts (code checks each one at once), keeps notes for itself and for
// people, and writes down questions. Questions are not sent from here. They are collected and go out in one
// round once everything new has been read (see clarify.ts).
//
// The customer's own files are read first, in order. Then each supplier's files are read in order, suppliers in parallel,
// so that notes about a supplier are there when the next file of that supplier is read.

const ISSUE_TYPES: IssueType[] = ["quantity", "date_eta", "price", "tracking_stale", "source_conflict", "quality_hold", "supplier_notice", "other"];

type Source =
  | { kind: "doc"; doc: DocRow; lane: string }
  | { kind: "mail"; mail: MessageDb; lane: string };

const label = (s: Source) => (s.kind === "doc" ? s.doc.path : `mail ${s.mail.id} from ${s.mail.from_addr}`);
const sourcePath = (s: Source) => (s.kind === "doc" ? s.doc.path : `mail:${s.mail.id}`);

/** Which lane a source is read in: the supplier it belongs to, or "customer" for the customer's own files. */
function laneOf(doc: DocRow): string {
  const sup = supplierOfPath(doc.path);
  if (sup) return sup;
  const grs = receiptsInFileName(doc.path);
  if (grs.length) {
    const s = get<{ supplier_id: string }>("SELECT supplier_id FROM goods_receipts WHERE gr_number = ?", grs[0]);
    if (s?.supplier_id) return s.supplier_id;
  }
  return "customer";
}

export function pendingSources(): Source[] {
  const docs = all<DocRow>("SELECT id, path, sha256, version, bytes, sync_id, seen_at FROM documents WHERE handler = 'openai' AND current = 1 AND status = 'pending'");
  const mails = all<MessageDb>("SELECT * FROM messages WHERE direction = 'in' AND processed = 0 ORDER BY id");
  // Replies first: they are the newest word of a supplier. Then documents in reading order.
  return [
    ...mails.map((m): Source => ({ kind: "mail", mail: m, lane: m.supplier_id ?? "customer" })),
    ...readingOrder(docs).map((d): Source => ({ kind: "doc", doc: d, lane: laneOf(d) })),
  ];
}

export const pendingCount = () => pendingSources().length;

// ---------------------------------------------------------------------------------------------

const factSchema = obj({
  object_type: enumT(Object.keys(VOCAB)),
  object_id: str(),
  field: str(),
  value: str(),
  unit: nullable(str()),
  part_id: nullable(str()),
  confidence: numT("0 to 1"),
  quote: nullable(str("the passage of the source, exactly as printed")),
});

export const readerSystem = () => withStyle(`${prompt("reader.md")}\n\n## Vocabulary\n\n${vocabForPrompt()}`);

const MAX_TEXT = 120_000;

function sourceContent(s: Source, readable: Readable): Part[] {
  const year = now().getUTCFullYear();
  const head: string[] = [
    `Now: ${sayDate(nowIso(), year)} (local time). Deadline: ${sayDate(config.deadline, year)}.`,
    masterBlock(),
  ];
  if (s.lane !== "customer") {
    const sup = get<{ name: string; language: string | null }>("SELECT name, language FROM suppliers WHERE supplier_id = ?", s.lane);
    head.push(`This source belongs to supplier ${s.lane} (${sup?.name ?? "?"}).`);
    const notes = readNotes(`supplier:${s.lane}`);
    if (notes.length) head.push(`Your notes on this supplier:\n${notes.map((n) => `- ${n.text}`).join("\n")}`);
  }
  const general = readNotes("general");
  if (general.length) head.push(`Your general notes:\n${general.map((n) => `- ${n.text}`).join("\n")}`);
  if (s.kind === "mail") {
    const asked = s.mail.supplier_id ? all<IssueDb>("SELECT * FROM issues WHERE status = 'asked' AND addressee = 'supplier' AND supplier_id = ? ORDER BY id", s.mail.supplier_id) : [];
    head.push(asked.length
      ? `Questions ${config.customer.name} has open with this sender (issue id | about | question):\n${asked.map((i) => `${i.id} | ${i.title} | ${i.question ?? ""}`).join("\n")}`
      : `${config.customer.name} has no open question with this sender.`);
    head.push(`=== Mail received ${sayDate(s.mail.sent_at ?? s.mail.created_at, year)}, from ${s.mail.from_addr} ===\nSubject: ${s.mail.subject}\n\n${s.mail.body_original}`);
    return [{ type: "text", text: head.join("\n\n") }];
  }
  const d = s.doc;
  const title = `=== Source: ${d.path} (version ${d.version}, in the portal since ${sayDate(d.seen_at, year)}) ===`;
  // The source itself is a file part: the OpenAI API gets its content right here, Claude Code gets its name and opens it.
  const base = d.path.split("/").pop() || "document";
  if (readable.kind === "text") {
    const text = readable.text.length > MAX_TEXT ? `${readable.text.slice(0, MAX_TEXT)}\n[cut after ${MAX_TEXT} characters]` : readable.text;
    const filename = /\.(txt|csv|md|json)$/i.test(base) ? base : `${base}.txt`;
    return [{ type: "text", text: `${head.join("\n\n")}\n\n${title}` }, { type: "file", filename, mime: "text/plain", bytes: new TextEncoder().encode(text) }];
  }
  if (readable.kind === "image") return [{ type: "text", text: `${head.join("\n\n")}\n\n${title}\nThe scanned page follows.` }, { type: "file", filename: base, mime: readable.mime, bytes: readable.bytes }];
  const filename = base.replace(/\.pdf.*$/i, "") + ".pdf";
  return [{ type: "text", text: `${head.join("\n\n")}\n\n${title}\nThe scanned PDF follows (${readable.pages} pages).` }, { type: "file", filename, mime: "application/pdf", bytes: readable.bytes }];
}

interface Finish { doc_type: string; language: string; doc_date: string | null; summary: string; body_en: string | null }

interface SourceOutcome { status: "done" | "skipped" | "failed" | "waiting"; facts_new: number; questions: number; notes: number; error?: string }

/** Raise or sharpen a question. One open question per object, part, kind and addressee. */
function ask(a: { to: "supplier" | "customer"; supplier_id: string | null; object_type: string; object_id: string; part_id: string | null; type: string; title: string; question: string; background: string; fact_ids: number[] }, runId: string, source: string): { issue_id: number; held?: boolean; note?: string } | { error: string } {
  if (!(a.object_type in VOCAB)) return { error: `unknown object_type ${a.object_type}` };
  if (!a.question.trim() || !a.title.trim()) return { error: "title and question are required" };
  const supplier = a.supplier_id && get("SELECT 1 AS x FROM suppliers WHERE supplier_id = ?", a.supplier_id) ? a.supplier_id : null;
  if (a.to === "supplier" && !supplier) return { error: "a question for a supplier needs a known supplier_id" };
  const type = ISSUE_TYPES.includes(a.type as IssueType) ? a.type : "other";
  const addressee = a.to === "supplier" ? "supplier" : "internal";
  const key = `ask:${a.object_type}:${a.object_id}:${a.part_id ?? ""}:${type}:${addressee}`;
  const stamp = nowIso();
  const old = get<IssueDb>("SELECT * FROM issues WHERE dedupe_key = ?", key);
  const facts = JSON.stringify([...new Set([...(old ? json<number[]>(old.fact_ids, []) : []), ...a.fact_ids.filter((n) => Number.isInteger(n))])]);
  // A question to this supplier about the same order line, lot or shipment is already out and its answer is not due
  // yet: the new one joins it and does not go out again. A supplier who writes "we are checking" gets time to answer.
  if (addressee === "supplier" && (!old || old.status === "resolved" || old.status === "answered")) {
    const pending = get<IssueDb>(
      "SELECT * FROM issues WHERE status = 'asked' AND addressee = 'supplier' AND supplier_id = ? AND object_type = ? AND object_id = ? ORDER BY updated_at DESC LIMIT 1",
      supplier, a.object_type, a.object_id);
    const due = pending ? replyBy(new Date(pending.updated_at)) : null;
    if (pending && due && now().getTime() < new Date(due).getTime()) {
      const merged = JSON.stringify([...new Set([...json<number[]>(pending.fact_ids, []), ...a.fact_ids.filter((n) => Number.isInteger(n))])]);
      run("UPDATE issues SET detail = ?, fact_ids = ? WHERE id = ?", `${pending.detail}\n\nStill open as of ${sayDate(stamp, now().getUTCFullYear())}: ${a.question.trim()}`.trim(), merged, pending.id);
      const name = get<{ name: string }>("SELECT name FROM suppliers WHERE supplier_id = ?", supplier)?.name ?? "the supplier";
      logEvent({ actor: "data_agent", action: "question.held", run_id: runId, object: { type: a.object_type as ObjectType, id: a.object_id },
        summary: `I did not ask ${name} again: my question "${pending.title}" about the same ${a.object_type.replace("_", " ")} is out and due by ${sayDate(due, now().getUTCFullYear())}. I added the new point to it.`,
        input: { source, question: a.question.trim(), type }, output: { issue_id: pending.id, due }, fact_ids: json<number[]>(merged, []) });
      return { issue_id: pending.id, held: true, note: `Not sent: question ${pending.id} about the same ${a.object_type} is already out with ${name} and is due by ${sayDate(due, now().getUTCFullYear())}. The new point was added to it. Do not ask again before then.` };
    }
  }
  let id: number;
  if (old && old.status !== "resolved" && old.status !== "answered") {
    // Still open or already asked: the newer wording replaces the older one, the issue stays one.
    run("UPDATE issues SET title = ?, detail = ?, question = ?, fact_ids = ?, supplier_id = COALESCE(?, supplier_id), updated_at = ? WHERE id = ?", a.title.trim(), a.background.trim(), a.question.trim(), facts, supplier, stamp, old.id);
    id = old.id;
  } else if (old) {
    run("UPDATE issues SET status = 'open', note = NULL, title = ?, detail = ?, question = ?, fact_ids = ?, supplier_id = ?, part_id = ?, addressee = ?, updated_at = ? WHERE id = ?", a.title.trim(), a.background.trim(), a.question.trim(), facts, supplier, a.part_id, addressee, stamp, old.id);
    id = old.id;
  } else {
    id = run(`INSERT INTO issues (dedupe_key, type, status, title, detail, object_type, object_id, part_id, supplier_id, addressee, question, fact_ids, created_by, created_at, updated_at)
              VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'data_agent', ?, ?)`,
      key, type, a.title.trim(), a.background.trim(), a.object_type, a.object_id, a.part_id, supplier, addressee, a.question.trim(), facts, stamp, stamp).lastId;
  }
  logEvent({ actor: "data_agent", action: old ? "question.updated" : "question.raised", run_id: runId, object: { type: a.object_type as ObjectType, id: a.object_id },
    summary: `I ${old ? "sharpened my question" : "have a question"} for ${a.to === "supplier" ? (get<{ name: string }>("SELECT name FROM suppliers WHERE supplier_id = ?", supplier)?.name ?? "the supplier") : config.customer.name}: ${a.question.trim().replace(/\s+/g, " ").slice(0, 200)}`,
    input: { source }, output: { issue_id: id, ...a }, fact_ids: json<number[]>(facts, []) });
  return { issue_id: id };
}

async function readSource(s: Source, runId: string): Promise<SourceOutcome> {
  const object = s.kind === "doc" ? { type: "document" as const, id: s.doc.path } : { type: "message" as const, id: String(s.mail.id), label: s.mail.subject };
  const stamp = () => new Date().toISOString();
  try {
    const readable: Readable = s.kind === "doc" ? await readForModel(s.doc.path, readBlob(s.doc.sha256)) : { kind: "text", text: s.mail.body_original };
    if (s.kind === "doc" && readable.kind === "text" && !readable.text.trim()) {
      run("UPDATE documents SET status = 'skipped', error = 'empty file', processed_at = ? WHERE id = ?", stamp(), s.doc.id);
      logEvent({ actor: "data_agent", action: "document.skipped", run_id: runId, object, summary: `I skipped ${s.doc.path} because it is empty.` });
      return { status: "skipped", facts_new: 0, questions: 0, notes: 0 };
    }

    const lk = loadLookup();
    const text = readable.kind === "text" ? (s.kind === "mail" ? `${s.mail.subject}\n${s.mail.body_original}` : readable.text) : null;
    const resolveCtx = { supplier_id: s.lane === "customer" ? null : s.lane, gr_hints: s.kind === "doc" ? receiptsInFileName(s.doc.path) : [], source_text: text };
    const accepted = new Map<string, ResolvedFact>(); // one value per object, field and part; a later call corrects an earlier one
    const rejected: Rejected[] = [];
    const questions: number[] = [];
    const answered: { issue_id: number; answer: string }[] = [];
    const notesWritten: number[] = [];
    let finish: Finish | null = null;
    const src = sourcePath(s);
    const factKey = (f: ResolvedFact) => `${f.object_type}|${f.object_id}|${f.field}|${f.part_id ?? ""}|${VOCAB[f.object_type]?.fields[f.field]?.compare === false ? f.value : ""}`;

    const tools: Tool[] = [
      ...knowledgeTools({ source: src, runId, notesWritten }, { canWrite: true }),
      {
        name: "record_facts", description: `Record what the source says. Code checks each fact against ${config.customer.name}'s data and answers per fact with ok or the reason it was not taken. Send a corrected fact again to replace it.`,
        parameters: obj({ facts: arr(factSchema) }),
        run: (a: { facts: RawFact[] }) => (a.facts ?? []).map((raw, i) => {
          const r = resolveFact(raw, lk, resolveCtx);
          if (!r.ok) { rejected.push({ raw, reason: r.reason }); return { i, ok: false, reason: r.reason }; }
          accepted.set(factKey(r.fact), r.fact);
          return { i, ok: true, stored_as: `${r.fact.object_type} ${r.fact.object_id} ${r.fact.field}${r.fact.part_id ? ` (${r.fact.part_id})` : ""}`, ...(r.fact.notes.length ? { note: r.fact.notes.join("; ") } : {}) };
        }),
      },
      {
        name: "ask", description: `Write down a question for later. Questions go out after all new sources are read: to a supplier in one mail per supplier, to ${config.customer.name} as a task. Asking again about the same thing replaces the earlier wording.`,
        parameters: obj({
          to: enumT(["supplier", "customer"]), supplier_id: nullable(str()), object_type: enumT(Object.keys(VOCAB)), object_id: str(), part_id: nullable(str()),
          type: enumT(ISSUE_TYPES), title: str("short line naming the object and what is unclear"), question: str(), background: str("what you know and why it matters"), fact_ids: arr({ type: "integer" }),
        }),
        run: (a: Parameters<typeof ask>[0]) => { const r = ask(a, runId, src); if ("issue_id" in r && !r.held) questions.push(r.issue_id); return r; },
      },
      {
        name: "finish", description: "Close this source, after you have seen the results of record_facts.",
        parameters: obj({ doc_type: str(), language: str("ISO 639-1"), doc_date: nullable(str("date the source was issued or is valid for, ISO")), summary: str("one or two sentences for a buyer: what it is and what matters"), body_en: nullable(str("for a mail: the full text in English, otherwise null")) }),
        run: (a: Finish) => { finish = a; return { ok: true }; },
      },
    ];
    if (s.kind === "mail") tools.push({
      name: "mark_answered", description: `Mark one of ${config.customer.name}'s open questions as answered by this mail. If only part of it is answered, ask again for the rest.`,
      parameters: obj({ issue_id: { type: "integer" }, answer: str() }),
      run: (a: { issue_id: number; answer: string }) => { answered.push(a); return { ok: true }; },
    });

    const res = await runAgent({
      model: config.openai.modelReader, system: readerSystem(), user: sourceContent(s, readable), tools,
      maxSteps: Number(process.env.READER_MAX_STEPS ?? 16), stopWhen: (trace) => trace.some((t) => t.name === "finish"),
    });

    const f = finish as Finish | null;
    const at = observedAt(f?.doc_date) ?? (s.kind === "mail" ? (s.mail.sent_at ?? s.mail.created_at) : null);
    const facts = [...accepted.values()];
    const stored = storeFacts(facts, { source_path: src, source_version: s.kind === "doc" ? s.doc.version : 1, document_id: s.kind === "doc" ? s.doc.id : null, observed_at: at, origin: "openai" });
    const summary = String(f?.summary ?? res.text ?? "").trim().slice(0, 2000);
    const language = String(f?.language ?? "").slice(0, 8).toLowerCase() || null;

    if (s.kind === "doc") {
      run("UPDATE documents SET status = 'done', doc_type = ?, language = ?, doc_date = ?, summary = ?, error = NULL, processed_at = ? WHERE id = ?",
        String(f?.doc_type ?? "other").slice(0, 60), language, at, summary, stamp(), s.doc.id);
    } else {
      const askedIds = new Set(all<{ id: number }>("SELECT id FROM issues WHERE status = 'asked'").map((r) => r.id));
      const ok = answered.filter((a) => askedIds.has(Number(a.issue_id)));
      tx(() => {
        run("UPDATE messages SET body_en = ?, language = ?, issue_ids = ?, processed = 1 WHERE id = ?", String(f?.body_en ?? "").trim() || s.mail.body_original, language ?? s.mail.language, JSON.stringify(ok.map((a) => a.issue_id)), s.mail.id);
        for (const a of ok) run("UPDATE issues SET status = 'answered', updated_at = ? WHERE id = ? AND status = 'asked'", nowIso(), a.issue_id);
      });
      for (const a of ok) {
        const i = get<IssueDb>("SELECT * FROM issues WHERE id = ?", a.issue_id)!;
        logEvent({ actor: "data_agent", action: "issue.answered", run_id: runId, object: { type: i.object_type as ObjectType, id: i.object_id }, summary: `The supplier answered my question about ${i.title}: ${a.answer.slice(0, 200)}`, input: { issue_id: i.id, question: i.question, message_id: s.mail.id }, output: { answer: a.answer }, fact_ids: stored.fact_ids });
      }
    }

    const n = stored.stored.length;
    const bits = [`recorded ${n} ${n === 1 ? "fact" : "facts"}`];
    if (notesWritten.length) bits.push(`wrote ${notesWritten.length} ${notesWritten.length === 1 ? "note" : "notes"}`);
    if (questions.length) bits.push(`have ${new Set(questions).size} ${new Set(questions).size === 1 ? "question" : "questions"}`);
    logEvent({
      actor: "data_agent", action: s.kind === "doc" ? "document.read" : "mail.read", run_id: runId, object,
      summary: `I read ${s.kind === "doc" ? s.doc.path : `the mail "${s.mail.subject}"`} and ${bits.length > 1 ? `${bits.slice(0, -1).join(", ")} and ${bits[bits.length - 1]}` : bits[0]}.`,
      input: { source: src, lane: s.lane, read_as: readable.kind },
      output: { doc_type: f?.doc_type, doc_date: at, summary, facts: stored.stored.map(factForLog), rejected: rejected.map(rejectedForLog), questions: [...new Set(questions)], notes: notesWritten, answered, steps: res.steps, tool_calls: res.trace.map((t) => t.name) },
      fact_ids: stored.fact_ids, model: res.usage.model, tokens_in: res.usage.tokens_in, tokens_out: res.usage.tokens_out, cost_usd: res.usage.cost_usd,
    });
    return { status: "done", facts_new: stored.new_ids.length, questions: new Set(questions).size, notes: notesWritten.length };
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    if (isServiceError(e)) return { status: "waiting", facts_new: 0, questions: 0, notes: 0, error: message };
    if (s.kind === "doc") run("UPDATE documents SET status = 'failed', error = ?, processed_at = ? WHERE id = ?", message.slice(0, 1000), stamp(), s.doc.id);
    else {
      const tries = Number(kv.get(`mail_read_tries:${s.mail.id}`) ?? "0") + 1;
      kv.set(`mail_read_tries:${s.mail.id}`, String(tries));
      if (tries >= 3) run("UPDATE messages SET processed = 1 WHERE id = ?", s.mail.id);
    }
    logEvent({ actor: "data_agent", action: s.kind === "doc" ? "document.failed" : "mail.read_failed", run_id: runId, object, summary: `I could not read ${label(s)}: ${message.slice(0, 200)}`, output: { error: message.slice(0, 2000) } });
    return { status: "failed", facts_new: 0, questions: 0, notes: 0, error: message };
  }
}

export interface ReadResult { read: number; facts_added: number; questions: number; notes: number; failed: number; waiting: number }

/** Read waiting sources. The customer's own first, then the suppliers' in parallel lanes. `limit` caps how many in this pass. */
export async function readSources(opts: { runId: string; limit?: number; perLane?: number; mailsOnly?: boolean }): Promise<ReadResult> {
  const res: ReadResult = { read: 0, facts_added: 0, questions: 0, notes: 0, failed: 0, waiting: 0 };
  let sources = pendingSources();
  if (opts.mailsOnly) sources = sources.filter((s) => s.kind === "mail");
  res.waiting = sources.length;
  if (!sources.length) { kv.set("data_agent.waiting_logged", "0"); return res; }
  if (!llmAvailable()) {
    if (kv.get("data_agent.waiting_logged") !== String(sources.length)) {
      kv.set("data_agent.waiting_logged", String(sources.length));
      logEvent({ actor: "data_agent", action: "documents.waiting", run_id: opts.runId, summary: `I have ${sources.length} documents and mails waiting to be read, and without an OpenAI key they stay in the queue.`, output: { waiting: sources.length, next: sources.slice(0, 10).map(label) } });
    }
    return res;
  }

  let budget = Math.max(0, opts.limit ?? sources.length);
  let serviceErrors = 0, stop = false, lastError = "";
  const take = () => (stop || budget <= 0 ? false : (budget--, true));
  const work = async (lane: Source[]) => {
    // The per-lane cap is for test runs and only applies to suppliers: the customer's own files are always read in full.
    for (const s of opts.perLane !== undefined && lane[0]?.lane !== "customer" ? lane.slice(0, opts.perLane) : lane) {
      if (!take()) return;
      const out = await readSource(s, opts.runId);
      if (out.status === "waiting") { lastError = out.error ?? ""; if (++serviceErrors >= 3) stop = true; continue; }
      serviceErrors = 0;
      if (out.status === "done") { res.read++; res.facts_added += out.facts_new; res.questions += out.questions; res.notes += out.notes; }
      if (out.status === "failed") res.failed++;
    }
  };

  const lanes = new Map<string, Source[]>();
  for (const s of sources) { if (!lanes.has(s.lane)) lanes.set(s.lane, []); lanes.get(s.lane)!.push(s); }
  await work(lanes.get("customer") ?? []);
  lanes.delete("customer");
  const queue = [...lanes.values()].sort((a, b) => b.length - a.length); // the longest lane starts first
  await Promise.all(Array.from({ length: Math.max(1, Math.min(config.openai.concurrency, queue.length)) }, async () => {
    for (let lane = queue.shift(); lane; lane = queue.shift()) await work(lane);
  }));

  if (stop) logEvent({ actor: "data_agent", action: "documents.service_error", run_id: opts.runId, summary: `I stopped reading because the model service did not answer properly: ${lastError.slice(0, 200)}`, output: { error: lastError.slice(0, 2000) } });
  res.waiting = (opts.mailsOnly ? pendingSources().filter((s) => s.kind === "mail") : pendingSources()).length;
  return res;
}
