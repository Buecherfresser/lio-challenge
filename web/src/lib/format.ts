import type { Actor, FactOrigin, Message, MessageStatus, ObjectRef, ObjectType } from "@shared/api.ts"

const TIME_ZONE = "Europe/Berlin"

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })
const euro = new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR", maximumFractionDigits: 0 })
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 })

const dateParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
})
const longWeekday = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, weekday: "long" })

function parts(iso: string): Record<string, string> | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const out: Record<string, string> = {}
  for (const part of dateParts.formatToParts(date)) out[part.type] = part.value
  return out
}

/** 12,000 */
export const num = (value: number) => integer.format(value)

/** €18,400 */
export const eur = (value: number) => euro.format(value)

/** $0.13, with more digits for very small amounts */
export function usd(value: number): string {
  const digits = value !== 0 && Math.abs(value) < 0.1 ? 4 : 2
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)
}

/** 55% */
export const pct = (value: number) => percent.format(value)

/** Sun 22 Nov, 20:00 */
export function dateTime(iso: string | null | undefined): string {
  const p = iso ? parts(iso) : null
  return p ? `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute}` : "n/a"
}

/** Sun 22 Nov */
export function dateOnly(iso: string | null | undefined): string {
  const p = iso ? parts(iso) : null
  return p ? `${p.weekday} ${p.day} ${p.month}` : "n/a"
}

/** 20:00 */
export function timeOnly(iso: string | null | undefined): string {
  const p = iso ? parts(iso) : null
  return p ? `${p.hour}:${p.minute}` : "n/a"
}

/** 20:00:07 */
export function timeWithSeconds(iso: string): string {
  const p = parts(iso)
  return p ? `${p.hour}:${p.minute}:${p.second}` : "n/a"
}

/** Sunday 20:00 */
export function weekdayTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "n/a"
  return `${longWeekday.format(date)} ${timeOnly(iso)}`
}

/** 31 h 12 min */
export function duration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours > 0 ? `${num(hours)} h ${minutes} min` : `${minutes} min`
}

/** 4 min ago, measured against the server clock */
export function ago(iso: string, now: string): string {
  const ms = new Date(now).getTime() - new Date(iso).getTime()
  if (Number.isNaN(ms)) return "n/a"
  if (ms < 60000) return "just now"
  if (ms < 24 * 3600000) return `${duration(ms)} ago`
  return dateTime(iso)
}

export const ACTOR_LABEL: Record<Actor, string> = {
  sync: "Sync",
  data_agent: "Data agent",
  risk_agent: "Risk agent",
  action_agent: "Action agent",
  human: "Human",
  system: "System",
}

export const ORIGIN_LABEL: Record<FactOrigin, string> = {
  code: "code",
  openai: "openai",
  bootstrap: "bootstrap",
  human: "human",
}

export const OBJECT_TYPE_LABEL: Record<ObjectType, string> = {
  po_line: "Order line",
  shipment: "Shipment",
  part: "Part",
  lot: "Lot",
  supplier: "Supplier",
  product: "Edition",
  policy: "Policy",
  role: "Role",
  document: "Document",
  message: "Mail",
  decision: "Decision",
  risk: "Risk",
  issue: "Issue",
  task: "Task",
}

export const MESSAGE_STATUS_LABEL: Record<MessageStatus, string> = {
  draft: "Draft",
  needs_approval: "Needs approval",
  sent: "Sent",
  outbox: "In the outbox",
  received: "Received",
  rejected: "Discarded",
}

/** Mails in another language show the original and the English text side by side. */
export const isTranslated = (message: Message) => message.language.toLowerCase() !== "en"

/** Where an object reference leads. Parts have their own page, everything else opens the log. */
export function objectHref(ref: Pick<ObjectRef, "type" | "id">): string {
  if (ref.type === "part") return `/parts/${encodeURIComponent(ref.id)}`
  const search = new URLSearchParams({ object_type: ref.type, object_id: ref.id })
  return `/log?${search.toString()}`
}

/** "de" becomes "German". Falls back to the code. */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code
  } catch {
    return code
  }
}

export function pretty(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/** "in 51 min", "in 9 h 12 min" or "2 h 5 min overdue", measured against the server clock (or the time being viewed). */
export function relativeDue(iso: string, now: string): { label: string; ms: number } {
  const ms = new Date(iso).getTime() - new Date(now).getTime()
  if (Number.isNaN(ms)) return { label: "n/a", ms: Infinity }
  return { label: ms >= 0 ? `in ${duration(ms)}` : `${duration(-ms)} overdue`, ms }
}

/** How pressing a deadline is: under 2 hours it is urgent, under 8 hours soon. */
export function urgency(ms: number): "urgent" | "soon" | "later" {
  if (ms < 2 * 3600000) return "urgent"
  if (ms < 8 * 3600000) return "soon"
  return "later"
}

/** 2,133,000 becomes 2.1M, 42,900 becomes 42.9k. For dense rows where the exact number sits one click away. */
export function compact(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)
}
