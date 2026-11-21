import { parse as parseCsv } from "csv-parse/sync";

// Turns raw file bytes into something code or a model can read.

export const ext = (p: string) => (p.includes(".") ? p.split(".").pop()!.toLowerCase() : "");
const IMAGE_MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
export const imageMime = (p: string): string | null => IMAGE_MIME[ext(p)] ?? null;

/** Files use mixed encodings: UTF-8 with or without BOM, UTF-16, Windows-1252. */
export function decodeText(buf: Uint8Array): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(buf);
  }
}

export interface Table { headers: string[]; rows: Record<string, string>[]; delimiter: string }

/** Guess the delimiter from the header line: the candidate that splits it into the most columns. */
export function sniffDelimiter(text: string): string {
  const first = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  let best = ",", bestN = 0;
  for (const d of [",", ";", "\t", "|"]) {
    const n = first.split(d).length;
    if (n > bestN) { best = d; bestN = n; }
  }
  return best;
}

export function readTable(buf: Uint8Array): Table {
  const text = decodeText(buf);
  const delimiter = sniffDelimiter(text);
  const records = parseCsv(text, { delimiter, columns: false, skip_empty_lines: true, relax_column_count: true, relax_quotes: true, trim: true }) as string[][];
  const headers = (records[0] ?? []).map((h) => h.trim());
  const rows = records.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])));
  return { headers, rows, delimiter };
}

export async function pdfText(buf: Uint8Array): Promise<{ text: string; pages: number; isScan: boolean }> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const chars = text.join("").replace(/\s/g, "").length;
  return {
    text: text.map((t, i) => `--- page ${i + 1}/${totalPages} ---\n${t.trim()}`).join("\n\n"),
    pages: totalPages,
    isScan: chars < 20 * totalPages, // no text layer: needs a vision model
  };
}

export async function xlsxText(buf: Uint8Array): Promise<string> {
  const XLSX = (await import("xlsx")).default;
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  return wb.SheetNames.map((name) => {
    const sheet = wb.Sheets[name];
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    const notes: string[] = [];
    for (const [addr, cell] of Object.entries(sheet)) {
      if (addr.startsWith("!")) continue;
      const c = (cell as { c?: { t: string }[] }).c;
      if (c) for (const x of c) notes.push(`${addr}: ${x.t}`);
    }
    return `=== sheet: ${name} ===\n${csv}${notes.length ? `\n[cell comments]\n${notes.join("\n")}` : ""}`;
  }).join("\n\n");
}

export async function docxText(buf: Uint8Array): Promise<string> {
  const mammoth = (await import("mammoth")).default;
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(buf) });
  return value;
}

export type Readable =
  | { kind: "text"; text: string }
  | { kind: "image"; mime: string; bytes: Uint8Array }
  | { kind: "pdf_scan"; bytes: Uint8Array; pages: number };

/** What a model should be shown for this file. */
export async function readForModel(path: string, buf: Uint8Array): Promise<Readable> {
  const e = ext(path);
  const mime = imageMime(path);
  if (mime) return { kind: "image", mime, bytes: buf };
  if (e === "pdf") {
    const p = await pdfText(buf);
    return p.isScan ? { kind: "pdf_scan", bytes: buf, pages: p.pages } : { kind: "text", text: p.text };
  }
  if (e === "xlsx" || e === "xls" || e === "xlsm") return { kind: "text", text: await xlsxText(buf) };
  if (e === "docx") return { kind: "text", text: await docxText(buf) };
  return { kind: "text", text: decodeText(buf) };
}
