import type { Actor, Issue, IssueStatus, IssueType, Message, MessageStatus, ObjectRef, ObjectType, Task } from "../../../shared/api.ts";
import { json } from "../../db.ts";
import { config } from "../../config.ts";

// Database rows of the tables the data agent owns, and how they map to the API types.

export interface IssueDb {
  id: number; dedupe_key: string; type: string; status: string; title: string; detail: string;
  expected: string | null; actual: string | null; object_type: string; object_id: string;
  part_id: string | null; supplier_id: string | null; addressee: string | null; assignee_role: string | null; question: string | null;
  fact_ids: string; created_by: string; created_at: string; updated_at: string;
  note?: string | null; // "dismissed: <why>" when someone decided it needs no action
}

export interface MessageDb {
  id: number; thread_id: string; direction: string; status: string; from_addr: string; to_addr: string; subject: string;
  language: string; body_original: string; body_en: string; supplier_id: string | null; person: string | null;
  created_by: string; issue_ids: string; decision_id: number | null; external_id: string | null; in_reply_to: string | null;
  processed: number; created_at: string; sent_at: string | null;
}

export interface TaskDb {
  id: number; status: string; role: string; person: string | null; title: string; body: string; issue_id: number | null;
  object_type: string | null; object_id: string | null; created_by: string; created_at: string; done_at: string | null;
  answer?: string | null; // what the colleague said, as a buyer recorded it
}

/** Whether people in this role work in the dashboard (DASHBOARD_ROLES). Their tasks go to the To do list. */
export function usesDashboard(roleTitle: string | null | undefined): boolean {
  const title = (roleTitle ?? "").toLowerCase();
  return config.dashboardRoles.some((r) => title.includes(r));
}

export function toIssue(r: IssueDb): Issue {
  return {
    id: r.id, type: r.type as IssueType, status: r.status as IssueStatus, title: r.title, detail: r.detail,
    expected: r.expected, actual: r.actual, object: { type: r.object_type as ObjectType, id: r.object_id },
    part_id: r.part_id, supplier_id: r.supplier_id,
    addressee: r.addressee === "supplier" || r.addressee === "internal" ? r.addressee : null,
    assignee_role: r.assignee_role, question: r.question, fact_ids: json<number[]>(r.fact_ids, []),
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

export function toMessage(r: MessageDb): Message {
  return {
    id: r.id, thread_id: r.thread_id, direction: r.direction === "in" ? "in" : "out", status: r.status as MessageStatus,
    from_addr: r.from_addr, to_addr: r.to_addr, subject: r.subject, language: r.language,
    body_original: r.body_original, body_en: r.body_en, supplier_id: r.supplier_id, person: r.person,
    created_by: r.created_by as Actor, issue_ids: json<number[]>(r.issue_ids, []), decision_id: r.decision_id,
    created_at: r.created_at, sent_at: r.sent_at,
  };
}

export function toTask(r: TaskDb): Task {
  const object: ObjectRef | null = r.object_type && r.object_id ? { type: r.object_type as ObjectType, id: r.object_id } : null;
  return {
    id: r.id, status: r.status === "done" ? "done" : "open", role: r.role, person: r.person, title: r.title, body: r.body,
    issue_id: r.issue_id, object, created_by: r.created_by as Actor, created_at: r.created_at, done_at: r.done_at,
    answer: r.answer ?? null, dashboard: usesDashboard(r.role),
  };
}

// ---- wording helpers for texts that code builds from the data ----

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TZ = config.customer.timezone; // dates are shown in the customer's local time

/** "Sun 22 Nov" for a date, "Sun 22 Nov, 20:00" for a timestamp. The year is added when it is not the current one. */
export function sayDate(iso: string | null | undefined, refYear?: number): string {
  if (!iso) return "no date";
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  if (dateOnly) {
    const [y, m, d] = iso.split("-").map(Number);
    const wd = DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
    return `${wd} ${d} ${MONTHS[m - 1]}${refYear !== undefined && y !== refYear ? ` ${y}` : ""}`;
  }
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(t).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}${refYear !== undefined && Number(p.year) !== refYear ? ` ${p.year}` : ""}, ${p.hour}:${p.minute}`;
}

export const sayQty = (n: number | null | undefined, unit = "pieces"): string =>
  n === null || n === undefined || !Number.isFinite(n) ? "an unknown quantity" : `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n)} ${unit}`;

export const sayNumber = (n: number): string => new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(n);

export const sayHours = (h: number): string => (h >= 48 ? `${Math.round(h / 24)} days` : `${Math.round(h)} hours`);

/** The calendar day in Hamburg of a timestamp, as YYYY-MM-DD. */
export function localDay(iso: string | Date): string {
  const t = typeof iso === "string" ? new Date(iso) : iso;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(t).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * Sort key that puts statements in the order they were made: by the date of the source, then by when we stored them.
 * A source that only gives a day counts as the start of that day. Undated statements come first.
 */
export function factOrder(f: { id: number; observed_at: string | null }): string {
  const at = !f.observed_at ? "" : f.observed_at.length === 10 ? `${f.observed_at}T00:00:00.000Z` : f.observed_at;
  return `${at}#${String(f.id).padStart(12, "0")}`;
}
