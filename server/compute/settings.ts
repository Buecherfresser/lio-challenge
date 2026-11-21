import "../config.ts"; // loads .env before we read process.env

// Tunable assumptions of the compute tools. All of them can be set in .env.

const env = (k: string, d = "") => (process.env[k] ?? "").trim() || d;
const num = (k: string, d: number) => (env(k) && Number.isFinite(Number(env(k))) ? Number(env(k)) : d);
const bool = (k: string, d: boolean) => (env(k) ? /^(1|true|yes|on)$/i.test(env(k)) : d);

export const settings = {
  /** UTC offset of the distribution center. Used to read date-only values and to print times. */
  localUtcOffset: /^[+-]\d{2}:\d{2}$/.test(env("LOCAL_UTC_OFFSET")) ? env("LOCAL_UTC_OFFSET") : "+01:00",
  /** A date without a time (an ETA, a promised date) counts as this time of that day. Default: end of the day. */
  dateOnlyTime: /^\d{2}:\d{2}$/.test(env("ETA_DATE_ONLY_TIME")) ? env("ETA_DATE_ONLY_TIME") : "23:59",
  /** Hours between a truck arriving at the distribution center and its parts being at the line. */
  inboundHandlingHours: num("INBOUND_HANDLING_HOURS", 0),
  /** Onward leg in hours when the shipment does not end at the distribution center and no route is on file. */
  unknownOnwardLegHours: num("UNKNOWN_ONWARD_LEG_HOURS", 24),
  /** Parts packed since the last stock count are taken off the stock figure (packed now minus packed at the count). */
  adjustStockForPacking: bool("STOCK_ADJUST_FOR_PACKING", true),
  /** "packed_fact": packing hours count from the time of the latest packed figure. "now": from the current time. */
  capacityFrom: (env("CAPACITY_FROM", "packed_fact") === "now" ? "now" : "packed_fact") as "packed_fact" | "now",
  /** Seconds the loaded state and the tables computed from it are reused. The dashboard polls every 5 s. */
  cacheSeconds: num("COMPUTE_CACHE_SECONDS", 4),
  /** Number of risks on the overview. */
  topRisks: num("TOP_RISKS", 5),
  /** Tool-calling steps the risk agent may take in one run. */
  riskAgentMaxSteps: num("RISK_AGENT_MAX_STEPS", 40),
  /** The risk agent's model run waits until the data agent has read every pending document (a forced run does not wait). */
  riskAgentWaitsForDocuments: bool("RISK_AGENT_WAIT_FOR_DOCUMENTS", true),
  /** Characters of a tool result kept in the stored trace of a risk. */
  traceResultMaxChars: num("TRACE_RESULT_MAX_CHARS", 4000),
  /** Decision options the action agent may propose per risk. */
  maxOptionsPerRisk: num("ACTION_MAX_OPTIONS", 3),
};

const offsetMs = (() => {
  const m = settings.localUtcOffset.match(/^([+-])(\d{2}):(\d{2})$/)!;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
})();

/** Read a date or timestamp. A date without a time becomes the configured time of that day, local time. */
export function toTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = s.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(t) ? new Date(`${t}T${settings.dateOnlyTime}:00${settings.localUtcOffset}`) : new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sun 22 Nov, 20:00" in local time. */
export function fmtTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "unknown";
  const d = new Date(ms + offsetMs);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
/** "Sun 22 Nov" for a date string or a timestamp. */
export function fmtDate(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "unknown";
  const ms = typeof v === "number" ? v + offsetMs : /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T12:00:00Z`) : Date.parse(v) + offsetMs;
  if (!Number.isFinite(ms)) return String(v);
  const d = new Date(ms);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
export const fmtQty = (n: number): string => Math.round(n).toLocaleString("en-US");
export const fmtHours = (h: number): string => (Math.round(h * 10) / 10).toLocaleString("en-US");
