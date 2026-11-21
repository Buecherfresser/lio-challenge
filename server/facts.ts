import type { Fact, FactOrigin, ObjectType } from "../shared/api.ts";
import { all, get, run } from "./db.ts";
import { nowIso } from "./clock.ts";

export interface NewFact {
  object_type: ObjectType;
  object_id: string;
  field: string;
  value: string;
  unit?: string | null;
  part_id?: string | null;
  source_path: string;
  source_version: number;
  document_id?: number | null;
  observed_at?: string | null;
  origin: FactOrigin;
  confidence: number;
  quote?: string | null;
}

/**
 * Add a fact. The table is append-only: nothing is ever updated or deleted.
 * If the same source already said exactly this as its latest statement, nothing is written and the
 * existing fact id is returned, so a re-read of an unchanged value does not grow the table.
 */
export function addFact(f: NewFact): { id: number; isNew: boolean } {
  const last = get<{ id: number; value: string; observed_at: string | null }>(
    `SELECT id, value, observed_at FROM facts WHERE object_type = ? AND object_id = ? AND field = ? AND source_path = ? AND IFNULL(part_id, '') = ? ORDER BY id DESC LIMIT 1`,
    f.object_type, f.object_id, f.field, f.source_path, f.part_id ?? "",
  );
  // Same value with a different date is a new statement (for example a corrected date), so it is written again.
  if (last && last.value === f.value && (last.observed_at ?? null) === (f.observed_at ?? null)) return { id: last.id, isNew: false };
  const r = run(
    `INSERT INTO facts (object_type, object_id, field, value, unit, part_id, source_path, source_version, document_id, observed_at, recorded_at, origin, confidence, quote)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    f.object_type, f.object_id, f.field, f.value, f.unit ?? null, f.part_id ?? null, f.source_path, f.source_version, f.document_id ?? null,
    f.observed_at ?? null, nowIso(), f.origin, Math.max(0, Math.min(1, f.confidence)), f.quote ?? null,
  );
  return { id: r.lastId, isNew: true };
}

const COLS = "id, object_type, object_id, field, value, unit, part_id, source_path, source_version, observed_at, recorded_at, origin, confidence, quote";

export const factsById = (ids: number[]): Fact[] =>
  ids.length ? all<Fact>(`SELECT ${COLS} FROM facts WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`, ...ids) : [];

export const factsOf = (type: string, id: string, field?: string): Fact[] =>
  field
    ? all<Fact>(`SELECT ${COLS} FROM facts WHERE object_type = ? AND object_id = ? AND field = ? ORDER BY id`, type, id, field)
    : all<Fact>(`SELECT ${COLS} FROM facts WHERE object_type = ? AND object_id = ? ORDER BY id`, type, id);

export const factsOfPart = (partId: string): Fact[] =>
  all<Fact>(`SELECT ${COLS} FROM facts WHERE part_id = ? OR (object_type = 'part' AND object_id = ?) ORDER BY id`, partId, partId);

export const factsOfType = (type: string, field?: string): Fact[] =>
  field
    ? all<Fact>(`SELECT ${COLS} FROM facts WHERE object_type = ? AND field = ? ORDER BY id`, type, field)
    : all<Fact>(`SELECT ${COLS} FROM facts WHERE object_type = ? ORDER BY id`, type);

/**
 * What each source currently says: per (object, field, part, source file) only the newest fact.
 * Older statements of the same source stay in the table as history.
 */
export function currentFacts(where = "1 = 1", ...params: unknown[]): Fact[] {
  return all<Fact>(
    `SELECT ${COLS} FROM facts WHERE id IN (
       SELECT MAX(id) FROM facts WHERE ${where} GROUP BY object_type, object_id, field, IFNULL(part_id, ''), source_path
     ) ORDER BY id`, ...params);
}

/** The newest statement about a field across all sources (by document date, then by when we recorded it). */
export function latestFact(type: string, id: string, field: string, partId?: string | null): Fact | null {
  const rows = currentFacts("object_type = ? AND object_id = ? AND field = ?" + (partId ? " AND part_id = ?" : ""), ...(partId ? [type, id, field, partId] : [type, id, field]));
  if (!rows.length) return null;
  // A date without a time counts as the start of that day, so it sorts before a timestamp of the same day.
  const key = (f: Fact) => `${!f.observed_at ? "" : f.observed_at.length === 10 ? `${f.observed_at}T00:00:00.000Z` : f.observed_at}#${String(f.id).padStart(12, "0")}`;
  return rows.reduce((a, b) => (key(b) > key(a) ? b : a));
}

export const latestValue = (type: string, id: string, field: string, partId?: string | null): string | null => latestFact(type, id, field, partId)?.value ?? null;
export const latestNumber = (type: string, id: string, field: string, partId?: string | null): number | null => {
  const v = latestValue(type, id, field, partId);
  return v === null || !Number.isFinite(Number(v)) ? null : Number(v);
};
