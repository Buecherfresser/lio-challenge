import type {
  DecisionCard,
  EventRow,
  Fact,
  HistoryList,
  MailFolder,
  MapView,
  Message,
  ObjectType,
  Overview,
  PartDetail,
  PartRow,
  Settings,
  Status,
  Task,
  Thread,
} from "@shared/api.ts"

import { timeTravel } from "@/lib/time-travel"

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** The message for anything that would change data while a past moment is on screen. */
export const PAST_MESSAGE = "You are looking at the past. Go back to live to change something."

/**
 * While a past moment is on screen, every read asks for the state of that moment (?at=) and nothing is sent that
 * would change data. The list of moments itself is always the live one.
 */
function atMoment(path: string, init?: RequestInit): string {
  const { at } = timeTravel.get()
  if (at === null || path.startsWith("/api/history")) return path
  if (init?.method && init.method !== "GET") throw new ApiError(409, PAST_MESSAGE)
  return `${path}${path.includes("?") ? "&" : "?"}at=${at}`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(atMoment(path, init), init)
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    let message = text
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === "object" && "error" in parsed) message = String(parsed.error)
    } catch {
      // keep the plain text
    }
    throw new ApiError(res.status, message || `${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
}

const get = <T>(path: string) => request<T>(path)

const post = <T>(path: string, body: unknown = {}) =>
  request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ""
}

export interface EventFilter {
  actors: string[]
  object_type: string
  object_id: string
  q: string
}

export type MessageFolder = Exclude<MailFolder, "tasks">

export const api = {
  overview: () => get<Overview>("/api/overview"),
  status: () => get<Status>("/api/status"),
  parts: () => get<PartRow[]>("/api/parts"),
  map: () => get<MapView>("/api/map"),
  part: (partId: string) => get<PartDetail>(`/api/parts/${encodeURIComponent(partId)}`),
  decisions: () => get<DecisionCard[]>("/api/decisions?status=all"),
  approveDecision: (id: number, by?: string) => post<DecisionCard>(`/api/decisions/${id}/approve`, by ? { by } : {}),
  history: () => get<HistoryList>("/api/history"),
  settings: () => get<Settings>("/api/settings"),
  saveSettings: (patch: Partial<Settings>) => post<Settings>("/api/settings", patch),
  rejectDecision: (id: number, reason: string) =>
    post<DecisionCard>(`/api/decisions/${id}/reject`, reason ? { reason } : {}),
  threads: () => get<Thread[]>("/api/threads"),
  folderMessages: (folder: MessageFolder) => get<Message[]>(`/api/messages${query({ folder })}`),
  threadMessages: (threadId: string) => get<Message[]>(`/api/messages${query({ thread_id: threadId })}`),
  sendMessage: (id: number, bodyOriginal: string) =>
    post<Message>(`/api/messages/${id}/approve`, { body_original: bodyOriginal }),
  discardMessage: (id: number) => post<Message>(`/api/messages/${id}/reject`),
  tasks: () => get<Task[]>("/api/tasks?status=all"),
  taskDone: (id: number) => post<Task>(`/api/tasks/${id}/done`),
  taskAnswer: (id: number, answer: string) => post<Task>(`/api/tasks/${id}/answer`, { answer, by: "Someone in procurement" }),
  events: (filter: EventFilter, limit: number, beforeId: number | null) =>
    get<EventRow[]>(
      `/api/events${query({
        actor: filter.actors.join(","),
        object_type: filter.object_type,
        object_id: filter.object_id,
        q: filter.q,
        limit,
        before_id: beforeId,
      })}`,
    ),
  facts: (objectType: ObjectType, objectId: string) =>
    get<Fact[]>(`/api/facts${query({ object_type: objectType, object_id: objectId })}`),
  runAll: () => post<{ started: boolean }>("/api/run/all"),
  replayNext: () => post<Status>("/api/replay/next"),
}
