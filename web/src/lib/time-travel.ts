import { useSyncExternalStore } from "react"

// Which moment the dashboard shows. null = live.
// Kept outside React so the API client can read it for every request without a hook.

interface TimeTravel {
  /** Id of the recorded moment on screen, or null for live. */
  at: number | null
  /** The event whose steps the time bar shows, or null for the newest. */
  eventId: number | null
  /** Whether the time bar is open. It is always open while a past moment is on screen. */
  open: boolean
}

let state: TimeTravel = { at: null, eventId: null, open: false }
const listeners = new Set<() => void>()

function set(next: Partial<TimeTravel>) {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

export const timeTravel = {
  get: () => state,
  /** Show a recorded moment, or go back to live with null. */
  goTo: (at: number | null) => set(at === null ? { at } : { at, open: true }),
  showEvent: (eventId: number | null, at: number | null = state.at) => set({ eventId, at, open: true }),
  setOpen: (open: boolean) => set(open ? { open } : { open, at: null }),
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

export const useTimeTravel = () => useSyncExternalStore(timeTravel.subscribe, timeTravel.get)

/** True while the dashboard shows a moment in the past. Nothing can be changed then. */
export const usePast = () => useTimeTravel().at !== null
