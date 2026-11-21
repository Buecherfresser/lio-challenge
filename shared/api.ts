// Contract between the backend (server/) and the dashboard (web/).
// Types only, erasable syntax only (the backend runs on Node's native TypeScript support).

export type Actor = "sync" | "data_agent" | "risk_agent" | "action_agent" | "human" | "system";
export type ObjectType = "po_line" | "shipment" | "part" | "lot" | "supplier" | "product" | "policy" | "role" | "document" | "message" | "decision" | "risk" | "issue" | "task";
export type FactOrigin = "code" | "openai" | "bootstrap" | "human";

export interface ObjectRef { type: ObjectType; id: string; label?: string }

/** One observed value. Facts are append-only. */
export interface Fact {
  id: number;
  object_type: ObjectType;
  object_id: string;
  field: string;
  value: string;
  unit: string | null;
  part_id: string | null;     // the part this value is about, if any
  source_path: string;        // portal path, or "mail:<message id>", or "human"
  source_version: number;     // version of that file (1 = first seen)
  observed_at: string | null; // date the document states, ISO
  recorded_at: string;        // when we stored it, ISO
  origin: FactOrigin;
  confidence: number;         // 0..1
  quote: string | null;       // snippet from the source that backs the value
}

export type IssueType = "quantity" | "date_eta" | "price" | "tracking_stale" | "source_conflict" | "quality_hold" | "supplier_notice" | "other";
export type IssueStatus = "open" | "asked" | "answered" | "resolved";

/** A deviation from what we expect, or a contradiction between sources. */
export interface Issue {
  id: number;
  type: IssueType;
  status: IssueStatus;
  title: string;
  detail: string;
  expected: string | null;
  actual: string | null;
  object: ObjectRef;
  part_id: string | null;
  supplier_id: string | null;
  addressee: "supplier" | "internal" | null; // who can clear it
  assignee_role: string | null;              // for internal ones
  question: string | null;
  fact_ids: number[];
  created_at: string;
  updated_at: string;
}

export interface EditionStatus {
  product_id: string;
  name: string;
  demand: number;      // day-one demand
  packed: number;
  remaining: number;   // still to pack
  safe: number;        // of remaining: parts are in the building and usable
  uncertain: number;   // of remaining: depends on something that is not confirmed yet
  lost: number;        // of remaining: cannot be packed before the deadline as things stand
  bottleneck_part_id: string | null;
  bottleneck_reason: string | null;
}

export interface Overview {
  now: string;
  deadline: string;
  hours_left: number;
  packing_hours_left: number;
  editions: EditionStatus[];
  open_decisions: DecisionCard[];
  top_risks: Risk[];
  counts: { open_issues: number; open_tasks: number; needs_approval_mails: number; pending_decisions: number; parts_at_risk: number };
  last_sync: { at: string; snapshot_id: number; added: number; changed: number; removed: number; source: "live" | "replay" | "import" } | null;
  mode: { source: "live" | "replay"; mail: "outbox" | "live"; llm: boolean };
}

export type PartStatus = "ok" | "uncertain" | "lost";

export interface PartRow {
  part_id: string;
  description: string;
  category: string;
  status: PartStatus;
  products: { product_id: string; name: string; qty_per: number }[];
  suppliers: { supplier_id: string; name: string }[];
  need: number;               // units needed for the remaining pack-out
  ordered: number;            // open order quantity
  confirmed: number;          // confirmed by the supplier
  shipped: number;            // supplier says it left
  in_transit: number;         // on a shipment that has not been received
  arrived: number;            // received at the distribution center (lifetime of open orders)
  stock: number;              // in stock per ERP
  usable: number;             // stock minus blocked lots
  available_safe: number;     // usable by the deadline, confirmed
  available_uncertain: number;// may additionally arrive or be released by the deadline
  gap: number;                // need - available_safe - available_uncertain, 0 if covered
  open_issues: number;
  open_questions: number;
}

export interface PartSourceLine {
  label: string;              // e.g. "In transit", "Stock"
  quantity: number | null;
  detail: string;             // e.g. "SHP-2026-04311, air, ETA 21 Nov"
  when: string | null;        // ISO, e.g. ETA
  confidence: "safe" | "uncertain" | "lost" | "info";
  object: ObjectRef | null;
  fact_ids: number[];
}

export interface PartDetail extends PartRow {
  drawing_rev: string | null;
  critical: boolean;
  sources: PartSourceLine[];
  facts: Fact[];
  issues: Issue[];            // contradictions and open questions live here
  risks: Risk[];
  history: EventRow[];
}

export interface ToolCallTrace { id: string; name: string; args: unknown; result: unknown }

export interface Risk {
  id: number;
  status: "open" | "mitigated" | "closed";
  part_id: string | null;
  product_id: string | null;
  supplier_id: string | null;
  title: string;
  explanation: string;
  probability: number;        // 0..1, the agent's estimate
  copies_at_risk: number;     // computed by code from the scenario, never by the model
  copies_by_product: { product_id: string; copies: number }[];
  scenario: unknown;          // what the agent assumed goes wrong (input of the what-if tool)
  fact_ids: number[];
  facts?: Fact[];
  tool_calls: ToolCallTrace[];
  created_at: string;
}

export interface Approver { role: string; person: string | null; rule: string; available: boolean; note: string | null }

export interface DecisionCard {
  id: number;
  risk_id: number;
  status: "pending" | "approved" | "rejected";
  title: string;
  option: string;             // what we would do, one or two sentences
  rationale: string;
  copies_saved: number;       // from the what-if tool
  copies_by_product: { product_id: string; copies: number }[];
  cost_eur: number | null;
  cost_basis: string;         // how the cost was computed
  approver: Approver;         // per PP-07
  mail_draft: Message | null;
  risk?: Risk;
  created_by: "mock" | "agent";
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

export type MessageStatus = "draft" | "needs_approval" | "sent" | "outbox" | "received" | "rejected";
export type MailFolder = "inbox" | "sent" | "needs_approval" | "tasks";

export interface Message {
  id: number;
  thread_id: string;          // "supplier:SUP-0010" or "person:<name>"
  direction: "out" | "in";
  status: MessageStatus;
  from_addr: string;
  to_addr: string;
  subject: string;
  language: string;           // ISO 639-1 of body_original
  body_original: string;
  body_en: string;            // same text in English (identical if the original is English)
  supplier_id: string | null;
  person: string | null;
  created_by: Actor;
  issue_ids: number[];
  decision_id: number | null;
  created_at: string;
  sent_at: string | null;
}

export interface Thread {
  thread_id: string;
  title: string;              // supplier or person name
  kind: "supplier" | "person";
  supplier_id: string | null;
  last_at: string;
  last_subject: string;
  count: number;
  needs_approval: number;
  unread_in: number;
}

export interface Task {
  id: number;
  status: "open" | "done";
  role: string;
  person: string | null;
  title: string;
  body: string;
  issue_id: number | null;
  object: ObjectRef | null;
  created_by: Actor;
  created_at: string;
  done_at: string | null;
}

export interface EventRow {
  id: number;
  ts: string;
  actor: Actor;
  action: string;             // e.g. "sync.completed", "fact.extracted", "mail.drafted"
  summary: string;            // one sentence, first person
  object: ObjectRef | null;
  run_id: string | null;
  input: unknown;
  output: unknown;
  fact_ids: number[];
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
}

export interface Status {
  now: string;
  running: { sync: boolean; data_agent: boolean; risk_agent: boolean; action_agent: boolean };
  queue: { documents_pending: number; documents_done: number; documents_failed: number };
  last_sync: Overview["last_sync"];
  mode: Overview["mode"];
  spend_usd: number;
  replay: { position: number; total: number } | null;
}

// ---- Supply map ----
// What travels to the distribution center right now, with places as coordinates.
// The backend states facts (places, times, quantities, classes). The dashboard draws the route lines
// and estimates where a ship or plane is now from etd, eta and the last tracked position.

export type TransportMode = "sea" | "air" | "truck" | "rail" | "unknown";

export interface GeoPoint {
  lat: number;
  lon: number;
  name: string;                // shown in tooltips only, never as a label on the map
  kind: "supplier" | "port" | "airport" | "site" | "hub";
  code: string | null;         // UN/LOCODE, site id or supplier id
}

export interface MapShipment {
  shipment_id: string;
  mode: TransportMode;
  status: string;              // lower case, as the data states it (booked, departed, in_transit, at_port, ...)
  departed: boolean;
  supplier: { supplier_id: string; name: string } | null;
  pickup: GeoPoint | null;     // the supplier's site, when it is not the place of loading (the leg "to port or airport")
  origin: GeoPoint | null;     // port or airport of loading
  via: GeoPoint[];             // stopovers the data names (transshipment port, hub airport), in order
  destination: GeoPoint | null;// port or airport of discharge
  final: GeoPoint | null;      // the distribution center, when the shipment does not end there (onward leg)
  etd: string | null;          // ISO
  eta: string | null;          // ISO, at destination
  at_line: string | null;      // ISO, expected at the distribution center (onward leg included)
  last_position: { lat: number; lon: number; at: string | null } | null; // tracking from the data, if any
  parts: { part_id: string; description: string; quantity: number; status: PartStatus }[];
  quantity: number;            // units on board, all parts
  value: { amount: number; currency: string } | null;  // goods value from order prices
  value_eur: number | null;    // the same in EUR, null if no rate is known
  status_class: "safe" | "uncertain" | "lost"; // worst class of the units on board
  critical: boolean;           // carries a part whose status is uncertain or lost: only these are drawn on the map
  risk_ids: number[];          // open risks that name this shipment or its parts
  disrupted: boolean;          // an open risk assumes this shipment does not arrive or arrives too late: route is crossed out
}

/** A replacement route from a decision card: drawn next to the crossed-out route it replaces. */
export interface MapReplacement {
  decision_id: number;
  risk_id: number;
  status: DecisionCard["status"];
  title: string;
  replaces_shipment_id: string | null;
  part_id: string | null;
  mode: TransportMode;
  from: GeoPoint;
  via: GeoPoint[];
  to: GeoPoint;
  quantity: number | null;
  arrival: string | null;      // ISO, at the distribution center
  cost_eur: number | null;
  copies_saved: number;
}

export interface MapView {
  now: string;
  hub: GeoPoint;               // the distribution center (Hamburg)
  suppliers: { supplier_id: string; name: string; point: GeoPoint; part_ids: string[]; status: PartStatus }[];
  shipments: MapShipment[];    // open shipments of launch parts, critical or not
  replacements: MapReplacement[];
}

/*
HTTP API (all JSON, all under /api):

GET  /api/overview                         -> Overview
GET  /api/status                           -> Status
GET  /api/map                              -> MapView
GET  /api/parts                            -> PartRow[]
GET  /api/parts/:part_id                   -> PartDetail
GET  /api/risks                            -> Risk[]
GET  /api/decisions?status=pending|all     -> DecisionCard[]   (includes risk and mail_draft)
POST /api/decisions/:id/approve            -> DecisionCard     body: { by?: string }
POST /api/decisions/:id/reject             -> DecisionCard     body: { by?: string, reason?: string }
GET  /api/threads                          -> Thread[]
GET  /api/messages?folder=inbox|sent|needs_approval&thread_id=...  -> Message[]
POST /api/messages/:id/approve             -> Message          body: { by?: string, body_original?: string } (sends it)
POST /api/messages/:id/reject              -> Message
GET  /api/tasks?status=open|all            -> Task[]
POST /api/tasks/:id/done                   -> Task
GET  /api/issues?status=open|all&part_id=  -> Issue[]
GET  /api/events?actor=&object_type=&object_id=&q=&limit=&before_id=  -> EventRow[]
GET  /api/facts?object_type=&object_id=    -> Fact[]   (or ?ids=1,2,3)
POST /api/run/:what                        -> { started: boolean }   what = sync | data-agent | risk-agent | action-agent | all
POST /api/replay/next                      -> Status           (replay mode: load the next stored snapshot)
POST /api/dev/inbound                      -> Message          body: { supplier_id, subject, body }  (simulate a supplier reply)
*/
