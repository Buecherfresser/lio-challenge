import type { ObjectType } from "../shared/api.ts";

// The shared language between code loaders, the model and the compute tools.
// A fact is (object, field, value). Only the fields listed here are accepted, so two sources that talk
// about the same thing end up on the same field and can be compared.

export type ValueKind = "number" | "date" | "datetime" | "text" | "bool" | "json";
export interface FieldDef {
  kind: ValueKind;
  about: string;
  /** Two sources that state different values for this field contradict each other. */
  compare?: boolean;
  /** The value legitimately moves over time. Of two dated statements the newer one wins and it is a change, not a contradiction. */
  changes?: boolean;
  /** "code": a short status word, stored lower case with underscores. "revision": a revision letter, stored without the word "rev". */
  format?: "code" | "revision";
}

const f = (kind: ValueKind, about: string, compare = true, extra: Partial<FieldDef> = {}): FieldDef => ({ kind, about, compare, ...extra });
const moves = { changes: true } as const;
const code = { format: "code" } as const;
const movingCode = { changes: true, format: "code" } as const;
const rev = { format: "revision" } as const;
const movingRev = { changes: true, format: "revision" } as const;

export const VOCAB: Partial<Record<ObjectType, { id: string; fields: Record<string, FieldDef> }>> = {
  po_line: {
    id: "<order number>/<line number>. Line numbers are 1, 2, 3 (supplier item 00010 = line 1, 00020 = line 2).",
    fields: {
      qty_ordered: f("number", "quantity Soony ordered"),
      unit_price: f("number", "price per unit on the order (unit = currency)"),
      requested_date: f("date", "delivery date Soony asked for"),
      promised_date: f("date", "delivery date held in the ERP as promised", true, moves),
      actual_delivery_date: f("date", "date the line was delivered"),
      erp_status: f("text", "order status in the ERP: open, delivered, cancelled, awaiting_approval", true, movingCode),
      confirmed_qty: f("number", "quantity the supplier confirmed", true, moves),
      confirmed_date: f("date", "delivery date the supplier confirmed", true, moves),
      confirmed_unit_price: f("number", "price per unit the supplier confirmed (unit = currency)", true, moves),
      confirmed_incoterm: f("text", "delivery term the supplier states for this order, e.g. the Incoterm and place", true, moves),
      release_condition: f("text", "a condition the supplier names before it ships or keeps working on this line, in English", false),
      shipped_qty: f("number", "quantity the supplier says has left", true, moves),
      shipped_date: f("date", "date it left the supplier", true, moves),
      balance_qty: f("number", "quantity still owed after a partial shipment", true, moves),
      balance_eta: f("date", "date the supplier names for the rest to arrive at Soony", true, moves),
      received_qty: f("number", "quantity booked at goods receipt", true, moves),
      artwork_rev: f("text", "revision of the artwork or drawing the supplier produced to", true, movingRev),
      note: f("text", "anything else the document says about this line", false),
    },
  },
  shipment: {
    id: "Soony shipment id. If the document only has a container or air waybill number, use that; it is resolved to the shipment.",
    fields: {
      qty: f("number", "units of one part on this shipment (set part_id)", true, moves),
      revision: f("text", "revision of the part loaded on this shipment (set part_id)", true, rev),
      etd: f("date", "departure date", true, moves),
      eta: f("date", "arrival date at the destination of the shipment", true, moves),
      status: f("text", "booked, in_transit, delayed, arrived_port, in_delivery, delivered", true, movingCode),
      mode: f("text", "sea, air or road", true, code),
      last_update: f("datetime", "when the tracking was last updated", true, moves),
      position: f("text", "last known position as 'lat,lon'", false),
      note: f("text", "anything else the document says about this shipment", false),
    },
  },
  part: {
    id: "Soony component id.",
    fields: {
      stock_qty: f("number", "total stock at the distribution center", true, moves),
      drawing_rev: f("text", "current released revision of the part", true, movingRev),
      blocked_rev: f("text", "a revision that must not be packed any more", true, movingRev),
      use_up_old_rev: f("bool", "whether stock of the previous revision may still be used", true, moves),
      critical: f("bool", "whether the part is marked critical", true, moves),
      need_remaining: f("number", "units needed for the remaining pack-out, as a document states it", true, moves),
      due_before_launch: f("number", "units a plan expects to arrive before the launch", true, moves),
      lead_time_days: f("number", "lead time in days (set the supplier in the note if it is supplier specific)", true, moves),
      supply_delay_days: f("number", "days by which a supplier says deliveries of this part move out", true, moves),
      single_source: f("bool", "whether there is only one supplier on file", true, moves),
      supplied_within: f("text", "id of the part this one comes fitted into, when it is not ordered, received or stocked on its own", false),
      notice: f("text", "news or a warning that affects supply of this part, in English", false),
    },
  },
  lot: {
    id: "goods receipt number, which is also the stock batch. Use the delivery note number if the receipt number is not on the document.",
    fields: {
      qty: f("number", "units delivered in the lot, as the delivery note or the receipt states it (a handwritten correction counts)"),
      stock_qty: f("number", "units of this lot still in stock", true, moves),
      received_date: f("date", "date of receipt"),
      delivery_note: f("text", "delivery note number"),
      revision: f("text", "revision of the part in this lot", true, rev),
      inspection_result: f("text", "accept or reject", true, movingCode),
      quality_status: f("text", "unrestricted, blocked, concession_required", true, movingCode),
      defect_note: f("text", "what was found", false),
      note: f("text", "anything else, e.g. damage or handwritten remarks", false),
    },
  },
  supplier: {
    id: "Soony supplier id.",
    fields: {
      status: f("text", "status in the vendor master: active, watch, at_risk, blocked", true, movingCode),
      qualification_status: f("text", "qualified or conditional", true, movingCode),
      qualification_released_on: f("date", "date of the release"),
      qualification_valid_until: f("date", "date a conditional release expires", true, moves),
      contact_email: f("text", "contact mail address", true, moves),
      language: f("text", "language the supplier writes in, ISO 639-1", true, movingCode),
      incoterm: f("text", "delivery term agreed in the contract, e.g. the Incoterm and place", true, moves),
      list_price: f("number", "price per unit on the supplier's price list that is valid now (set part_id, unit = currency)", true, moves),
      downtime_from: f("datetime", "start of an announced downtime", true, moves),
      downtime_to: f("datetime", "end of an announced downtime", true, moves),
      capacity_note: f("text", "what the supplier can still make or ship, in English", false),
      offer: f("text", "an offer the supplier made: what, how many, by when, at what price, in English", false),
      notice: f("text", "a notice from or about the supplier that affects supply, in English", false),
      contract_term: f("text", "a contract clause that matters for delivery, rush orders, penalties or force majeure, in English", false),
    },
  },
  product: {
    id: "Soony product id.",
    fields: {
      day_one_demand: f("number", "copies needed on launch day"),
      packed: f("number", "copies packed so far", true, moves),
      still_to_pack: f("number", "copies still to pack", true, moves),
      pack_rate_per_hour: f("number", "copies the line packs per hour", true, moves),
      priority_rank: f("number", "1 = gets short parts first", true, moves),
      note: f("text", "anything else that matters for the launch of this product", false),
    },
  },
  policy: {
    id: "policy number as printed on the policy.",
    fields: {
      approval_rule: f("json", 'one rule as JSON: {"kind":"po_value|air_freight|supplier_release|quality_concession|dock_slot|exception|other","role":"<role title>","limit_eur":<number or null>,"scope":"<when it applies>","text":"<the rule in one sentence>"}', false),
    },
  },
  role: {
    id: "role title exactly as on the organisation chart.",
    fields: {
      person: f("text", "name of the person in the role, or 'vacant'", true, moves),
      deputy: f("text", "name of the person who stands in for the role", true, moves),
      reports_to: f("text", "role title this role reports to", true, moves),
      available_from: f("date", "date the person starts, if in the future", true, moves),
      responsibility: f("text", "what this role is responsible for or signs", false),
    },
  },
};

export const fieldDef = (type: string, field: string): FieldDef | null => VOCAB[type as ObjectType]?.fields[field] ?? null;

/** The vocabulary as text for a prompt. */
export function vocabForPrompt(): string {
  return Object.entries(VOCAB).map(([type, def]) =>
    `${type} (id: ${def!.id})\n` + Object.entries(def!.fields).map(([k, v]) => `  - ${k} [${v.kind}]: ${v.about}`).join("\n"),
  ).join("\n\n");
}

/** Bring a raw value into the canonical form of its kind. Returns null if it cannot be read. */
export function normalizeValue(kind: ValueKind, raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  switch (kind) {
    case "number": { const n = parseNumber(s); return n === null ? null : String(n); }
    case "date": { const d = parseDate(s); return d ? d.slice(0, 10) : null; }
    case "datetime": { const d = parseDate(s); return d; }
    case "bool": return /^(y|yes|true|1|ja)$/i.test(s) ? "true" : /^(n|no|false|0|nein)$/i.test(s) ? "false" : null;
    case "json": try { return JSON.stringify(JSON.parse(s)); } catch { return null; }
    default: return s;
  }
}

/** Canonical form of a value for one field: the kind first, then the format of the field (status word, revision letter). */
export function normalizeField(def: FieldDef, raw: string): string | null {
  const v = normalizeValue(def.kind, raw);
  if (v === null) return null;
  if (def.format === "code") return v.toLowerCase().replace(/[\s\-]+/g, "_").replace(/^_+|_+$/g, "") || null;
  if (def.format === "revision") return v.replace(/^(rev(ision)?\.?|version|v\.)\s*/i, "").trim().toUpperCase() || null;
  return v;
}

/** Whether two stored values of a field say the same thing. Numbers may differ by a rounding error, text by case and spacing. */
export function sameValue(def: FieldDef, a: string, b: string, relTolerance = 0.005): boolean {
  if (a === b) return true;
  if (def.kind === "number") {
    const x = Number(a), y = Number(b);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    return Math.abs(x - y) <= Math.max(Math.abs(x), Math.abs(y)) * relTolerance;
  }
  if (def.kind === "datetime") return new Date(a).getTime() === new Date(b).getTime();
  if (def.kind === "date") return a.slice(0, 10) === b.slice(0, 10);
  const na = normalizeField(def, a), nb = normalizeField(def, b);
  const loose = (x: string | null) => (x ?? "").toLowerCase().replace(/[\s_\-]+/g, " ").trim();
  return loose(na) === loose(nb);
}

/** Reads 1,234.5 and 1.234,5 and 640.000 (German thousands) and 9,8. */
export function parseNumber(s: string): number | null {
  let t = s.replace(/[\s ']/g, "").replace(/[^\d.,\-+eE]/g, "");
  if (!t || !/\d/.test(t)) return null;
  const lastComma = t.lastIndexOf(","), lastDot = t.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    t = lastComma > lastDot ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  } else if (lastComma >= 0) {
    // a single comma followed by exactly three digits is a thousands separator, otherwise a decimal comma
    t = /^[-+]?\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, "") : t.replace(",", ".");
  } else if (lastDot >= 0) {
    if (/^[-+]?\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Reads ISO dates and datetimes, 21.11.2026, 11/21/2026 and 21/11/2026. Returns ISO (date or full timestamp). */
export function parseDate(s: string, dayFirst?: boolean): string | null {
  const t = s.trim();
  if (!t) return null;
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/);
  if (m) {
    if (!m[4]) return `${m[1]}-${m[2]}-${m[3]}`;
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}${m[8] ? m[8].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2") : "+01:00"}`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ ,]+(\d{1,2}):(\d{2}))?$/);
  if (m) {
    const iso = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    return m[4] ? new Date(`${iso}T${m[4].padStart(2, "0")}:${m[5]}:00+01:00`).toISOString() : iso;
  }
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    const df = dayFirst ?? (a > 12 && b <= 12);
    const [day, month] = df ? [a, b] : [b, a];
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${m[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return null;
}
