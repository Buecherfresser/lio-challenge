import type { PortalAdapter } from "./types.ts";

// Soony's portal: the customer's own files under soony/ (master data, ERP exports, logistics, context), and one folder
// per supplier under suppliers/<SUP-id>_<Name>/. The SAP export names vendors by bare number (11 for SUP-0011).

export const soony: PortalAdapter = {
  id: "soony",
  files: {
    components: /^soony\/master\/components\.csv$/i,
    products: /^soony\/master\/products\.csv$/i,
    bom: /^soony\/master\/bom\.csv$/i,
    routes: /^soony\/master\/routes\.csv$/i,
    carriers: /^soony\/master\/logistics_providers\.csv$/i,
    ports: /^soony\/master\/ports\.csv$/i,
    sites: /^soony\/master\/sites\.csv$/i,
    suppliers: /^suppliers\/[^/]+\/profile\.csv$/i,
    supplier_parts: /^suppliers\/[^/]+\/components\.csv$/i,
    po_lines: /^soony\/erp\/purchase_orders[^/]*\.csv$/i,
    goods_receipts: /^soony\/erp\/goods_receipts[^/]*\.csv$/i,
    stock: /^soony\/erp\/stock_snapshot[^/]*\.csv$/i,
    shipments: /^soony\/erp\/open_shipments[^/]*\.csv$/i,
    packout: /^soony\/erp\/packout_log[^/]*\.csv$/i,
  },
  readFirst: /^soony\/(context|news|logistics|master)\//i,
  supplierFolder: (path) => (path.startsWith("suppliers/") ? path.split("/").slice(0, 2).join("/") : null),
  supplierIdInPath: (path) => path.match(/SUP-\d+/i)?.[0]?.toUpperCase() ?? null,
  supplierIdFromErp: (raw) => (raw && /^\d+$/.test(raw) ? `SUP-${raw.padStart(4, "0")}` : raw),
};
