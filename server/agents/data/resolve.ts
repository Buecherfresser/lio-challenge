import type { ObjectType } from "../../../shared/api.ts";
import { all } from "../../db.ts";
import { VOCAB, fieldDef, normalizeField } from "../../vocab.ts";

// Everything a model says about a document passes through here before it is stored.
// The field must be in the vocabulary, the value must be readable, and the object must exist in Soony's data.
// What does not pass is not stored. It is returned with the reason so the log shows it.

export interface RawFact {
  object_type: string;
  object_id: string;
  field: string;
  value: string;
  unit: string | null;
  part_id: string | null;
  confidence: number;
  quote: string | null;
}

export interface ResolvedFact {
  object_type: ObjectType;
  object_id: string;
  field: string;
  value: string;
  unit: string | null;
  part_id: string | null;
  confidence: number;
  quote: string | null;
  notes: string[]; // what code changed on the way, e.g. "line matched by part"
}

export interface ResolveContext {
  /** Supplier the source belongs to (supplier folder or mail sender). Facts about another supplier's orders are refused. */
  supplier_id?: string | null;
  /** Goods receipts the source is known to belong to, e.g. from the delivery note number in a file name. */
  gr_hints?: string[];
  /** Text of the source, if it has one. A quote that is not in it lowers the confidence. */
  source_text?: string | null;
}

export type ResolveResult = { ok: true; fact: ResolvedFact } | { ok: false; reason: string };
export interface Rejected { raw: RawFact; reason: string }

interface PoLine { po_line_id: string; po_number: string; po_line: number; supplier_id: string | null; part_id: string | null; currency: string | null }
interface Shipment { shipment_id: string; reference: string | null; supplier_id: string | null; part_ids: string[] }
interface Receipt { gr_number: string; part_id: string | null; delivery_note: string | null; supplier_id: string | null }

/** The ids that exist right now. Built once per document. */
export interface Lookup {
  parts: Set<string>;
  products: Set<string>;
  suppliers: Map<string, string>;       // id and normalised names -> id
  poLines: Map<string, PoLine>;
  poByNumber: Map<string, PoLine[]>;
  shipments: Map<string, Shipment>;     // normalised id and reference -> shipment
  shipmentList: Shipment[];
  receipts: Map<string, Receipt>;
  receiptsByNote: Map<string, Receipt[]>;
}

/** Letters and digits only, upper case. Makes "020-4811 3256" and "02048113256" the same. */
export const key = (s: string | null | undefined) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const nameKey = (s: string | null | undefined) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function loadLookup(): Lookup {
  const suppliers = new Map<string, string>();
  for (const s of all<{ supplier_id: string; name: string | null; legal_name: string | null }>("SELECT supplier_id, name, legal_name FROM suppliers")) {
    suppliers.set(key(s.supplier_id), s.supplier_id);
    for (const n of [s.name, s.legal_name]) if (n && nameKey(n)) suppliers.set(`name:${nameKey(n)}`, s.supplier_id);
  }
  const poLines = new Map<string, PoLine>();
  const poByNumber = new Map<string, PoLine[]>();
  for (const l of all<PoLine>("SELECT po_line_id, po_number, po_line, supplier_id, part_id, currency FROM po_lines")) {
    poLines.set(l.po_line_id, l);
    if (!poByNumber.has(l.po_number)) poByNumber.set(l.po_number, []);
    poByNumber.get(l.po_number)!.push(l);
  }
  const shipments = new Map<string, Shipment>();
  const shipmentList: Shipment[] = [];
  for (const s of all<{ shipment_id: string; reference: string | null; supplier_id: string | null; part_ids: string | null }>("SELECT shipment_id, reference, supplier_id, part_ids FROM shipments")) {
    let parts: string[] = [];
    try { parts = JSON.parse(s.part_ids ?? "[]") as string[]; } catch { /* keep empty */ }
    const sh: Shipment = { shipment_id: s.shipment_id, reference: s.reference, supplier_id: s.supplier_id, part_ids: parts };
    shipmentList.push(sh);
    shipments.set(key(s.shipment_id), sh);
    if (key(s.reference)) shipments.set(key(s.reference), sh);
  }
  const receipts = new Map<string, Receipt>();
  const receiptsByNote = new Map<string, Receipt[]>();
  for (const r of all<Receipt>("SELECT gr_number, part_id, delivery_note, supplier_id FROM goods_receipts")) {
    receipts.set(key(r.gr_number), r);
    const k = key(r.delivery_note);
    if (k) { if (!receiptsByNote.has(k)) receiptsByNote.set(k, []); receiptsByNote.get(k)!.push(r); }
  }
  return {
    parts: new Set(all<{ part_id: string }>("SELECT part_id FROM components").map((x) => x.part_id)),
    products: new Set(all<{ product_id: string }>("SELECT product_id FROM products").map((x) => x.product_id)),
    suppliers, poLines, poByNumber, shipments, shipmentList, receipts, receiptsByNote,
  };
}

/** Fields of a shipment that are stated per part. Every other shipment field is about the shipment as a whole. */
const SHIPMENT_PART_FIELDS = new Set(["qty", "revision"]);
const PRICE_FIELDS = new Set(["unit_price", "confirmed_unit_price", "list_price"]);

const reject = (reason: string): ResolveResult => ({ ok: false, reason });

function findPart(lk: Lookup, raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (lk.parts.has(t)) return t;
  const k = key(t);
  for (const p of lk.parts) if (key(p) === k) return p;
  return null;
}

function resolvePoLine(lk: Lookup, rawId: string, part: string | null, ctx: ResolveContext, notes: string[]): { line: PoLine; factor: number } | string {
  const m = rawId.trim().match(/^(\d{5,})\s*(?:[\/\-_.#: ]+\s*(?:item|line|pos\.?|position)?\s*(\d+))?$/i);
  if (!m) return `"${rawId}" is not an order line id`;
  const lines = lk.poByNumber.get(m[1]);
  if (!lines?.length) return `order ${m[1]} is not in the ERP`;
  if (ctx.supplier_id && lines.some((l) => l.supplier_id && l.supplier_id !== ctx.supplier_id)) return `order ${m[1]} belongs to another supplier`;

  let line: PoLine | undefined;
  let factor = 1;
  if (m[2] !== undefined) {
    const n = Number(m[2]);
    // Supplier papers count items 00010, 00020. The ERP counts 1, 2.
    const tens = n >= 10 && n % 10 === 0 ? n / 10 : n;
    const candidates = m[2].startsWith("0") ? [tens, n] : [n, tens];
    for (const c of candidates) { line = lines.find((l) => l.po_line === c); if (line) break; }
  }
  if (!line) {
    const sameOrder = part ? lines.filter((l) => l.part_id === part) : lines;
    if (sameOrder.length === 1) {
      line = sameOrder[0];
      factor = 0.85;
      notes.push(m[2] !== undefined ? `line ${m[2]} is not on the order, matched by part to line ${line.po_line}` : `no line given, matched to line ${line.po_line}`);
    } else if (!sameOrder.length) {
      return part ? `order ${m[1]} has no line for ${part}` : `order ${m[1]} has no such line`;
    } else {
      return `order ${m[1]} has ${sameOrder.length} lines that fit, the line number is needed`;
    }
  }
  return { line, factor };
}

function resolveShipment(lk: Lookup, rawId: string): Shipment | string {
  const k = key(rawId);
  if (!k) return "no shipment id";
  const exact = lk.shipments.get(k);
  if (exact) return exact;
  // "AWB 020-48113256" or a reference with a carrier prefix: accept when exactly one open shipment fits.
  const hits = lk.shipmentList.filter((s) => {
    const ref = key(s.reference), id = key(s.shipment_id);
    return (ref.length >= 6 && (k.includes(ref) || (k.length >= 6 && ref.includes(k)))) || k.includes(id);
  });
  if (hits.length === 1) return hits[0];
  return hits.length ? `"${rawId}" fits ${hits.length} shipments` : `"${rawId}" is not among the open shipments`;
}

function resolveLot(lk: Lookup, rawId: string, part: string | null, ctx: ResolveContext, notes: string[]): Receipt | string {
  const k = key(rawId);
  const direct = lk.receipts.get(k);
  if (direct) return direct;
  const pick = (rows: Receipt[], how: string): Receipt | string | null => {
    if (!rows.length) return null;
    const fit = part && rows.length > 1 ? rows.filter((r) => r.part_id === part) : rows;
    if (fit.length === 1) { notes.push(`${how} ${fit[0].gr_number}`); return fit[0]; }
    return `${rows.length} goods receipts fit "${rawId}", the part is needed to tell them apart`;
  };
  const byNote = pick(lk.receiptsByNote.get(k) ?? [], "delivery note belongs to goods receipt");
  if (byNote) return byNote;
  const hinted = pick((ctx.gr_hints ?? []).map((g) => lk.receipts.get(key(g))).filter((r): r is Receipt => Boolean(r)), "file belongs to goods receipt");
  if (hinted) return hinted;
  return `"${rawId}" is neither a goods receipt nor a delivery note in the ERP`;
}

const squash = (s: string) => s.toLowerCase().replace(/[\s ]+/g, "");

/** Check one statement of a model and bring it into the form in which facts are stored. */
export function resolveFact(raw: RawFact, lk: Lookup, ctx: ResolveContext = {}): ResolveResult {
  const type = String(raw.object_type ?? "").trim() as ObjectType;
  const def = fieldDef(type, String(raw.field ?? "").trim());
  if (!VOCAB[type]) return reject(`unknown object type "${raw.object_type}"`);
  if (!def) return reject(`"${raw.field}" is not a field of ${type}`);
  const field = raw.field.trim();
  const rawId = String(raw.object_id ?? "").trim();
  if (!rawId) return reject("no object id");

  let value = normalizeField(def, String(raw.value ?? ""));
  if (value === null) return reject(`"${String(raw.value).slice(0, 80)}" cannot be read as ${def.kind}`);
  if (def.kind === "date" || def.kind === "datetime") {
    const y = Number(value.slice(0, 4));
    if (y < 2000 || y > 2100) return reject(`the date ${value} is out of range`);
  }
  if (def.kind === "text" && value.length > 1500) value = value.slice(0, 1500);
  if (def.kind === "json" && field === "approval_rule") {
    const r = JSON.parse(value) as Record<string, unknown>;
    if (!r || typeof r !== "object" || Array.isArray(r) || typeof r.role !== "string" || !r.role.trim() || typeof r.text !== "string") return reject("an approval rule needs at least a role and a text");
    const limit = typeof r.limit_eur === "number" && Number.isFinite(r.limit_eur) ? r.limit_eur : null;
    value = JSON.stringify({ kind: typeof r.kind === "string" ? r.kind : "other", role: r.role.trim(), limit_eur: limit, scope: typeof r.scope === "string" ? r.scope : "", text: r.text });
  }

  const notes: string[] = [];
  let confidence = Number.isFinite(Number(raw.confidence)) ? Math.max(0, Math.min(1, Number(raw.confidence))) : 0.5;
  const statedPart = findPart(lk, raw.part_id);
  let objectId = rawId;
  let partId: string | null = null;
  let currency: string | null = null;

  switch (type) {
    case "po_line": {
      const r = resolvePoLine(lk, rawId, statedPart, ctx, notes);
      if (typeof r === "string") return reject(r);
      objectId = r.line.po_line_id;
      partId = r.line.part_id;
      currency = r.line.currency;
      confidence *= r.factor;
      if (statedPart && r.line.part_id && statedPart !== r.line.part_id) { confidence *= 0.8; notes.push(`the model named ${statedPart}, the order line is for ${r.line.part_id}`); }
      break;
    }
    case "shipment": {
      const s = resolveShipment(lk, rawId);
      if (typeof s === "string") return reject(s);
      if (ctx.supplier_id && s.supplier_id && s.supplier_id !== ctx.supplier_id) return reject(`shipment ${s.shipment_id} belongs to another supplier`);
      if (s.shipment_id !== rawId) notes.push(`"${rawId}" is shipment ${s.shipment_id}`);
      objectId = s.shipment_id;
      if (SHIPMENT_PART_FIELDS.has(field)) {
        partId = statedPart ?? (s.part_ids.length === 1 && lk.parts.has(s.part_ids[0]) ? s.part_ids[0] : null);
        if (!partId) return reject(raw.part_id ? `part "${raw.part_id}" is not in the component master` : `shipment ${s.shipment_id} carries several parts, the part is needed`);
        if (!statedPart) notes.push(`part taken from the shipment: ${partId}`);
        else if (s.part_ids.length && !s.part_ids.includes(partId)) { confidence *= 0.8; notes.push(`${partId} is not listed on shipment ${s.shipment_id} in the ERP`); }
      }
      break;
    }
    case "lot": {
      const r = resolveLot(lk, rawId, statedPart, ctx, notes);
      if (typeof r === "string") return reject(r);
      if (ctx.supplier_id && r.supplier_id && r.supplier_id !== ctx.supplier_id) return reject(`goods receipt ${r.gr_number} belongs to another supplier`);
      objectId = r.gr_number;
      partId = r.part_id && lk.parts.has(r.part_id) ? r.part_id : null;
      if (statedPart && partId && statedPart !== partId) { confidence *= 0.8; notes.push(`the model named ${statedPart}, the goods receipt is for ${partId}`); }
      break;
    }
    case "part": {
      const p = findPart(lk, rawId);
      if (!p) return reject(`part "${rawId}" is not in the component master`);
      objectId = p;
      break;
    }
    case "supplier": {
      const k = key(rawId);
      const id = lk.suppliers.get(k) ?? lk.suppliers.get(`name:${nameKey(rawId)}`) ?? (/^\d+$/.test(rawId) ? lk.suppliers.get(key(`SUP-${rawId.padStart(4, "0")}`)) : undefined);
      if (!id) return reject(`supplier "${rawId}" is not in the vendor master`);
      if (ctx.supplier_id && id !== ctx.supplier_id) { confidence *= 0.8; notes.push(`the source belongs to ${ctx.supplier_id}, the statement is about ${id}`); }
      objectId = id;
      partId = statedPart;
      if (raw.part_id && !statedPart) notes.push(`part "${raw.part_id}" is not in the component master, left out`);
      break;
    }
    case "product": {
      const k = key(rawId);
      const id = [...lk.products].find((p) => key(p) === k);
      if (!id) return reject(`product "${rawId}" is not in the product master`);
      objectId = id;
      break;
    }
    case "policy":
    case "role":
      objectId = rawId.replace(/\s+/g, " ").slice(0, 120);
      break;
    default:
      return reject(`facts about ${type} are not stored`);
  }

  let unit = raw.unit ? String(raw.unit).trim().slice(0, 12) : null;
  if (PRICE_FIELDS.has(field)) unit = unit ? unit.toUpperCase() : currency;

  let quote = raw.quote ? String(raw.quote).replace(/\s+/g, " ").trim().slice(0, 300) : null;
  if (quote === "") quote = null;
  if (quote && ctx.source_text) {
    const hay = squash(ctx.source_text), needle = squash(quote);
    const loose = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "");
    if (needle.length >= 4 && !hay.includes(needle) && !loose(hay).includes(loose(needle))) { confidence *= 0.7; notes.push("the quote is not in the text of the source"); }
  }

  return { ok: true, fact: { object_type: type, object_id: objectId, field, value, unit, part_id: partId, confidence: Math.round(confidence * 1000) / 1000, quote, notes } };
}

/**
 * Resolve everything a model returned for one source. A value that the same source states twice with different
 * values for a comparable field is only taken once: the first statement stays, the second is refused.
 */
export function resolveAll(raws: RawFact[], lk: Lookup, ctx: ResolveContext = {}): { facts: ResolvedFact[]; rejected: Rejected[] } {
  const facts: ResolvedFact[] = [];
  const rejected: Rejected[] = [];
  const seen = new Map<string, string>();
  for (const raw of raws) {
    const r = resolveFact(raw, lk, ctx);
    if (!r.ok) { rejected.push({ raw, reason: r.reason }); continue; }
    const f = r.fact;
    const k = `${f.object_type}|${f.object_id}|${f.field}|${f.part_id ?? ""}`;
    const before = seen.get(k);
    if (before !== undefined) {
      if (before === f.value) continue; // said twice, same value
      if (fieldDef(f.object_type, f.field)?.compare) { rejected.push({ raw, reason: `the source already states ${before} for this, a second value is not taken` }); continue; }
    }
    seen.set(k, f.value);
    facts.push(f);
  }
  return { facts, rejected };
}
