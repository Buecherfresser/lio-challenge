import { config } from "../../config.ts";
import { portal } from "../../adapters/index.ts";
import { all, get } from "../../db.ts";
import { now } from "../../clock.ts";
import { key } from "./resolve.ts";
import { sayDate } from "./rows.ts";

// What a model is told about Soony's data before it reads a document or a mail, so that it can name
// orders, shipments, lots and parts by the ids the database uses. Everything here comes from the database.

export interface SourceContext {
  text: string;
  supplier_id: string | null;
  gr_hints: string[];
}

const line = (...cells: (string | number | null | undefined)[]) => cells.map((c) => (c === null || c === undefined || c === "" ? "-" : String(c))).join(" | ");
const list = (s: string | null) => { try { return (JSON.parse(s ?? "[]") as string[]).join(", "); } catch { return s ?? ""; } };

/** Supplier a portal path belongs to, from its folder. */
export function supplierOfPath(path: string): string | null {
  const folder = portal.supplierFolder(path);
  if (!folder) return null;
  const byFolder = get<{ supplier_id: string }>("SELECT supplier_id FROM suppliers WHERE folder = ?", folder);
  if (byFolder) return byFolder.supplier_id;
  const id = portal.supplierIdInPath(path);
  return id && get("SELECT 1 AS x FROM suppliers WHERE supplier_id = ?", id) ? id : null;
}

/** Goods receipts whose receipt number or delivery note number is part of the file name. */
export function receiptsInFileName(path: string): string[] {
  const name = key(path.split("/").pop() ?? "");
  if (!name) return [];
  return all<{ gr_number: string; delivery_note: string | null }>("SELECT gr_number, delivery_note FROM goods_receipts")
    .filter((r) => (key(r.gr_number).length >= 6 && name.includes(key(r.gr_number))) || (key(r.delivery_note).length >= 6 && name.includes(key(r.delivery_note))))
    .map((r) => r.gr_number);
}

export function masterBlock(): string {
  const products = all<{ product_id: string; name: string; lifecycle: string | null }>("SELECT product_id, name, lifecycle FROM products ORDER BY product_id");
  const parts = all<{ part_id: string; description: string | null; category: string | null; drawing_rev: string | null }>("SELECT part_id, description, category, drawing_rev FROM components ORDER BY part_id");
  const bom = all<{ parent_id: string; child_id: string; qty_per: number }>("SELECT parent_id, child_id, qty_per FROM bom ORDER BY parent_id, child_id");
  const suppliers = all<{ supplier_id: string; name: string; legal_name: string | null; country: string | null; language: string | null }>("SELECT supplier_id, name, legal_name, country, language FROM suppliers ORDER BY supplier_id");
  return [
    "Products (id | name | lifecycle):", ...products.map((p) => line(p.product_id, p.name, p.lifecycle)),
    "", "Parts (id | description | category | revision in the master data):", ...parts.map((p) => line(p.part_id, p.description, p.category, p.drawing_rev)),
    "", "Which product contains which part (product | part | pieces per copy):", ...bom.map((b) => line(b.parent_id, b.child_id, b.qty_per)),
    "", "Suppliers (id | name | legal name | country | language):", ...suppliers.map((s) => line(s.supplier_id, s.name, s.legal_name, s.country, s.language)),
  ].join("\n");
}

interface PoRow { po_line_id: string; po_number: string; part_id: string | null; supplier_id: string | null; quantity: number | null; unit_price: number | null; currency: string | null; requested_date: string | null; promised_date: string | null; status: string | null; order_date: string | null; incoterm: string | null }
interface ShipRow { shipment_id: string; reference: string | null; supplier_id: string | null; mode: string | null; po_numbers: string | null; part_ids: string | null; etd: string | null; eta: string | null; status: string | null }

const poLine = (l: PoRow, withSupplier: boolean) => line(l.po_line_id, ...(withSupplier ? [l.supplier_id] : []), l.part_id, l.quantity, `${l.unit_price ?? "-"} ${l.currency ?? ""}`.trim(), l.requested_date, l.promised_date, l.status, l.incoterm);
const shipLine = (s: ShipRow, withSupplier: boolean) => line(s.shipment_id, s.reference, ...(withSupplier ? [s.supplier_id] : []), s.mode, list(s.po_numbers), list(s.part_ids), s.etd, s.eta, s.status);

function supplierBlock(supplierId: string, mentioned: string): string {
  const s = get<{ name: string; legal_name: string | null; language: string | null; incoterm: string | null; currency: string | null }>("SELECT name, legal_name, language, incoterm, currency FROM suppliers WHERE supplier_id = ?", supplierId);
  const parts = all<{ part_id: string; description: string | null; note: string | null }>(
    "SELECT sp.part_id, c.description, sp.note FROM supplier_parts sp LEFT JOIN components c ON c.part_id = sp.part_id WHERE sp.supplier_id = ? ORDER BY sp.part_id", supplierId);
  // Orders that are still open, orders the source names, and what was ordered in the last months.
  const recentFrom = new Date(now().getTime() - 120 * 86_400_000).toISOString().slice(0, 10);
  const lines = all<PoRow>("SELECT po_line_id, po_number, part_id, supplier_id, quantity, unit_price, currency, requested_date, promised_date, status, order_date, incoterm FROM po_lines WHERE supplier_id = ? ORDER BY po_number DESC, po_line", supplierId)
    .filter((l) => l.status === "open" || l.status === "awaiting_approval" || mentioned.includes(l.po_number) || (l.order_date ?? "") >= recentFrom)
    .slice(0, 200);
  const ships = all<ShipRow>("SELECT shipment_id, reference, supplier_id, mode, po_numbers, part_ids, etd, eta, status FROM shipments WHERE supplier_id = ? ORDER BY shipment_id", supplierId);
  return [
    `This source belongs to supplier ${supplierId} (${s?.name ?? ""}${s?.legal_name ? `, ${s.legal_name}` : ""}). Language on file: ${s?.language ?? "unknown"}. Delivery term on file: ${s?.incoterm ?? "unknown"}. Currency: ${s?.currency ?? "unknown"}.`,
    "", `Parts this supplier delivers (${config.customer.name} part id | description | note). The supplier may use its own part numbers. Then match by description:`, ...parts.map((p) => line(p.part_id, p.description, p.note)),
    "", "Order lines with this supplier (order line id | part | quantity | unit price | requested | promised in ERP | ERP status | delivery term on the order):", ...(lines.length ? lines.map((l) => poLine(l, false)) : ["none"]),
    "", "Open shipments from this supplier (shipment id | container or air waybill | mode | orders | parts | departure | arrival | status):", ...(ships.length ? ships.map((x) => shipLine(x, false)) : ["none"]),
  ].join("\n");
}

function soonyBlock(): string {
  const lines = all<PoRow>("SELECT po_line_id, po_number, part_id, supplier_id, quantity, unit_price, currency, requested_date, promised_date, status, order_date, incoterm FROM po_lines WHERE status IN ('open', 'awaiting_approval') ORDER BY po_number, po_line");
  const ships = all<ShipRow>("SELECT shipment_id, reference, supplier_id, mode, po_numbers, part_ids, etd, eta, status FROM shipments ORDER BY shipment_id");
  const roles = all<{ object_id: string }>("SELECT DISTINCT object_id FROM facts WHERE object_type = 'role' ORDER BY object_id").map((r) => r.object_id);
  const policies = all<{ object_id: string }>("SELECT DISTINCT object_id FROM facts WHERE object_type = 'policy' ORDER BY object_id").map((r) => r.object_id);
  return [
    "Open order lines (order line id | supplier | part | quantity | unit price | requested | promised in ERP | ERP status | delivery term):", ...(lines.length ? lines.map((l) => poLine(l, true)) : ["none"]),
    "", "Open shipments (shipment id | container or air waybill | supplier | mode | orders | parts | departure | arrival | status):", ...(ships.length ? ships.map((x) => shipLine(x, true)) : ["none"]),
    ...(roles.length ? ["", `Role titles already on file (reuse the exact title when the source means the same role): ${roles.join("; ")}`] : []),
    ...(policies.length ? ["", `Policies already on file: ${policies.join("; ")}`] : []),
  ].join("\n");
}

function receiptBlock(grs: string[]): string {
  if (!grs.length) return "";
  const rows = all<{ gr_number: string; gr_date: string | null; po_number: string | null; po_line: number | null; supplier_id: string | null; part_id: string | null; delivery_note: string | null }>(
    `SELECT gr_number, gr_date, po_number, po_line, supplier_id, part_id, delivery_note FROM goods_receipts WHERE gr_number IN (${grs.map(() => "?").join(",")}) ORDER BY gr_number`, ...grs);
  // Quantities are left out on purpose: the model reads the paper, the comparison with the booking is done by code.
  return ["Goods receipts that belong to this file by its name (goods receipt = lot id | booked on | order line | supplier | part | delivery note):",
    ...rows.map((r) => line(r.gr_number, r.gr_date, r.po_number ? `${r.po_number}/${r.po_line ?? "?"}` : null, r.supplier_id, r.part_id, r.delivery_note))].join("\n");
}

/**
 * Context for one source. `path` is a portal path, `supplierId` overrides the supplier (mail),
 * `seenAt` is when the file first appeared.
 */
export function buildContext(opts: { path?: string; supplierId?: string | null; seenAt?: string | null; mentioned?: string }): SourceContext {
  const supplierId = opts.supplierId ?? (opts.path ? supplierOfPath(opts.path) : null);
  const grHints = opts.path ? receiptsInFileName(opts.path) : [];
  const year = now().getUTCFullYear();
  const blocks = [
    `Now: ${now().toISOString()} (${sayDate(now().toISOString(), year)} local time). Launch deadline at the distribution center: ${config.deadline} (${sayDate(config.deadline, year)}).`,
    opts.seenAt ? `The file first appeared in the portal on ${opts.seenAt}.` : "",
    masterBlock(),
    // A file that belongs to known goods receipts only needs those. Everything else of Soony's own gets the open orders and shipments.
    supplierId ? supplierBlock(supplierId, `${opts.path ?? ""} ${opts.mentioned ?? ""}`) : grHints.length ? "" : soonyBlock(),
    receiptBlock(grHints),
  ];
  return { text: blocks.filter(Boolean).join("\n\n"), supplier_id: supplierId, gr_hints: grHints };
}
