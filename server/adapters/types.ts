// How one customer's supplier portal is laid out. The app itself only knows the base tables below and documents to
// read. A new customer gets its own adapter next to soony.ts; nothing else in the code names a folder or an id format.

/** The tables code fills from tabular base files. Everything else in the portal is read by the data agent. */
export type BaseTable =
  | "components" | "products" | "bom" | "routes" | "carriers" | "ports" | "sites"
  | "suppliers" | "supplier_parts" | "po_lines" | "goods_receipts" | "stock" | "shipments" | "packout";

export interface PortalAdapter {
  /** Name in PORTAL_ADAPTER. */
  id: string;
  /** Which portal file fills which base table, matched against the path relative to the portal root. */
  files: Record<BaseTable, RegExp>;
  /** Folders of the customer's own context (news, notices, logistics, master data) that the data agent reads first. */
  readFirst: RegExp;
  /** The folder a supplier's files sit in ("suppliers/SUP-0011_Boise_Semi"), or null if the path is not a supplier's. */
  supplierFolder(path: string): string | null;
  /** A supplier id named in a path, if the portal puts ids into folder or file names. */
  supplierIdInPath(path: string): string | null;
  /** The supplier id as the rest of the data uses it, from what the ERP export writes (for example a bare vendor number). */
  supplierIdFromErp(raw: string | null): string | null;
}
