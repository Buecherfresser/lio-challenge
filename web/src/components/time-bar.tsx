import { Pause, Play, StepBack, StepForward, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { HistoryEvent, HistoryStep } from "@shared/api.ts"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { dateOnly, dateTime, duration, timeOnly, timeWithSeconds } from "@/lib/format"
import { useHistory } from "@/lib/queries"
import { timeTravel, useTimeTravel } from "@/lib/time-travel"
import { cn } from "@/lib/utils"

// The time bar: the same dashboard at an earlier moment.
// It shows one event at a time (a delivery of new data and what it set off). Every step with a word is a point you
// can jump to. Steps in between are small ticks: Play stops on them, they have no word.
// One colour only. A dashed line means that somebody was waited for.

/** A wait longer than this between two steps is drawn dashed and skipped by Play. */
const WAIT_MS = 2 * 60_000
/** How long Play stays on a step. */
const STEP_MS = 1800

/** A step with a word, and the steps in between that follow it. */
interface Stop {
  step: HistoryStep
  index: number
  between: { step: HistoryStep; index: number }[]
  /** Time from the last step of this stop to the next stop. */
  gapAfter: number
}

function stopsOf(event: HistoryEvent): Stop[] {
  const stops: Stop[] = []
  event.steps.forEach((step, index) => {
    if (step.word || stops.length === 0) stops.push({ step, index, between: [], gapAfter: 0 })
    else stops[stops.length - 1].between.push({ step, index })
  })
  stops.forEach((stop, n) => {
    const next = stops[n + 1]
    const last = stop.between[stop.between.length - 1]?.step ?? stop.step
    stop.gapAfter = next ? new Date(next.step.at).getTime() - new Date(last.at).getTime() : 0
  })
  return stops
}

/** The small button in the header: where in time the dashboard is. A click opens or closes the bar. */
export function TimeToggle() {
  const { at, open } = useTimeTravel()
  const { data } = useHistory()
  const step = at === null ? null : data?.events.flatMap((event) => event.steps).find((s) => s.id === at)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-pressed={open || at !== null}
          onClick={() => timeTravel.setOpen(!(open || at !== null))}
          className="shrink-0 tabular-nums"
        >
          <span
            aria-hidden
            className={cn("size-2 rounded-full", at === null ? "bg-emerald-500" : "border border-muted-foreground")}
          />
          {at === null ? "Live" : step ? timeOnly(step.at) : "Past"}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {at === null ? "Look at an earlier moment" : "You are looking at the past. Click to go back to live."}
      </TooltipContent>
    </Tooltip>
  )
}

function Track({ stops, position, onGo }: { stops: Stop[]; position: number | null; onGo: (index: number) => void }) {
  return (
    <div className="-mx-1 overflow-x-auto px-1 pb-0.5">
      <div
        className="flex min-w-[36rem]"
        role="group"
        aria-label="Steps of this event. Arrow keys move one step."
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
          event.preventDefault()
          const current = position ?? stops[stops.length - 1].index + stops[stops.length - 1].between.length
          onGo(current + (event.key === "ArrowRight" ? 1 : -1))
        }}
      >
        {stops.map((stop, n) => {
          // Live counts as "everything has happened".
          const here = position ?? Infinity
          const done = here > stop.index
          const current = here === stop.index
          const last = n === stops.length - 1
          const line = (reached: boolean) =>
            cn("mx-1 h-0 flex-1 border-t-[1.5px]", stop.gapAfter >= WAIT_MS && "border-dashed", reached ? "border-foreground" : "border-border")
          return (
            <button
              key={stop.step.id}
              type="button"
              aria-current={current ? "step" : undefined}
              title={stop.step.summary}
              onClick={() => onGo(stop.index)}
              className={cn(
                "group min-w-0 text-left text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground",
                last ? "flex-none" : "flex-1",
                (current || (done && here <= stop.index + stop.between.length)) && "text-foreground",
              )}
            >
              <span className="flex h-4 items-center">
                <span
                  className={cn(
                    "size-2.5 shrink-0 rounded-full border-[1.5px]",
                    done || current ? "border-foreground bg-foreground" : "border-border bg-background",
                    current && "ring-4 ring-foreground/15",
                    "group-focus-visible:ring-4 group-focus-visible:ring-ring/50",
                  )}
                />
                {!last && (
                  <>
                    {stop.between.map((tick) => (
                      <span key={tick.step.id} className="contents">
                        <span className={line(here >= tick.index)} />
                        <span
                          className={cn(
                            "size-1 shrink-0 rounded-full",
                            here >= tick.index ? "bg-foreground" : "bg-border",
                            here === tick.index && "ring-4 ring-foreground/15",
                          )}
                        />
                      </span>
                    ))}
                    <span className={line(here > stop.index + stop.between.length)} />
                  </>
                )}
              </span>
              <span className="mt-1.5 block truncate pr-3 text-xs font-medium">{stop.step.word ?? "Step"}</span>
              <span className="block font-mono text-[11px] tabular-nums opacity-80">{timeWithSeconds(stop.step.at)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** The bar under the header. Shown when it was opened, and always while a past moment is on screen. */
export function TimeBar() {
  const { at, eventId, open } = useTimeTravel()
  const { data } = useHistory()
  const queryClient = useQueryClient()
  const [playing, setPlaying] = useState(false)

  const events = useMemo(() => data?.events ?? [], [data])
  // The event on the bar: the one that was picked, else the one the moment on screen belongs to, else the newest.
  const event = useMemo(
    () =>
      events.find((e) => e.id === eventId) ??
      (at !== null ? events.find((e) => e.steps.some((s) => s.id === at)) : undefined) ??
      events[0],
    [events, eventId, at],
  )
  const steps = event?.steps ?? []
  const found = at === null ? -1 : steps.findIndex((s) => s.id === at)
  const position = found >= 0 ? found : null
  const stops = useMemo(() => (event ? stopsOf(event) : []), [event])

  // A link can open the dashboard at a moment: ?moment=<id>.
  const fromLink = useRef(false)
  useEffect(() => {
    if (fromLink.current) return
    fromLink.current = true
    const moment = Number(new URLSearchParams(window.location.search).get("moment"))
    if (Number.isInteger(moment) && moment > 0) timeTravel.goTo(moment)
  }, [])

  // Another moment means other numbers everywhere. The lists keep what they show until the new answer is in.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== "history" })
  }, [at, queryClient])

  const go = (index: number) => {
    if (!event || steps.length === 0) return
    const clamped = Math.max(0, Math.min(steps.length - 1, index))
    timeTravel.showEvent(event.id, steps[clamped].id)
  }

  // Play: one step after the other, each for the same short time. The real waits between them are skipped.
  useEffect(() => {
    if (!playing) return
    if (position === null || position >= steps.length - 1) { setPlaying(false); return }
    const timer = window.setTimeout(() => go(position + 1), STEP_MS)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- go reads the same event and steps this effect depends on
  }, [playing, position, steps.length, event?.id])

  if (!open && at === null) return null

  const step = position === null ? null : steps[position]
  const stopBefore = step ? stops.findLast((stop) => stop.index <= position!) : undefined
  const arrived = step && stopBefore && stopBefore.index === position ? stops[stops.indexOf(stopBefore) - 1] : undefined
  const waited = arrived && arrived.gapAfter >= WAIT_MS ? arrived.gapAfter : 0

  return (
    <section aria-label="Time bar" className="shrink-0 border-b bg-muted/40 px-4 py-3">
      {events.length === 0 || !event ? (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <p className="min-w-0 flex-1">
            {data?.recording_since
              ? `Recording since ${dateTime(data.recording_since)}. No new data has arrived since then, so there is no event to look at yet.`
              : "The time bar starts once the first full reading of the data is through. From then on, every delivery of new data can be played back here."}
          </p>
          <Button variant="ghost" size="icon-sm" aria-label="Close the time bar" onClick={() => timeTravel.setOpen(false)}>
            <X />
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex min-w-0 max-w-full flex-1 items-center gap-2 text-xs text-muted-foreground md:flex-none">
              Event
              <Select
                value={String(event.id)}
                onValueChange={(value) => {
                  const picked = events.find((e) => String(e.id) === value)
                  setPlaying(false)
                  // A newly picked event opens at its start, ready to be played.
                  if (picked) timeTravel.showEvent(picked.id, picked.steps[0]?.id ?? null)
                }}
              >
                <SelectTrigger size="sm" className="min-w-0 max-w-full bg-background text-foreground md:max-w-[26rem]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {events.map((e) => (
                    <SelectItem key={e.id} value={String(e.id)}>
                      <span className="tabular-nums">{dateTime(e.at)}</span> · {e.title}
                      <span className="text-muted-foreground"> · {e.state}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            <div className="order-last flex w-full min-w-0 items-baseline gap-2 overflow-hidden text-sm md:order-none md:w-auto md:flex-1">
              <span className="font-semibold whitespace-nowrap tabular-nums">
                {step ? `${dateOnly(step.at)}, ${timeWithSeconds(step.at)}` : "Live"}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {step ? (waited ? `${duration(waited)} after the step before` : "you are looking at the past") : "this is now"}
              </span>
              {event.test && <span className="rounded-full border px-1.5 text-xs leading-4.5 text-muted-foreground">test data</span>}
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <Button variant="outline" size="icon-sm" aria-label="One step back" disabled={position === 0} onClick={() => { setPlaying(false); go((position ?? steps.length) - 1) }}>
                <StepBack />
              </Button>
              <Button
                size="sm"
                className="min-w-18"
                onClick={() => {
                  if (playing) { setPlaying(false); return }
                  // From live or from the end, Play starts the event over.
                  if (position === null || position >= steps.length - 1) go(0)
                  setPlaying(true)
                }}
              >
                {playing ? <Pause /> : <Play />}
                {playing ? "Pause" : "Play"}
              </Button>
              <Button variant="outline" size="icon-sm" aria-label="One step forward" disabled={position === null || position >= steps.length - 1} onClick={() => { setPlaying(false); go((position ?? 0) + 1) }}>
                <StepForward />
              </Button>
              {at !== null ? (
                <Button variant="outline" size="sm" onClick={() => { setPlaying(false); timeTravel.goTo(null) }}>
                  Back to live
                </Button>
              ) : (
                <Button variant="ghost" size="icon-sm" aria-label="Close the time bar" onClick={() => timeTravel.setOpen(false)}>
                  <X />
                </Button>
              )}
            </div>
          </div>
          <Track stops={stops} position={position} onGo={(index) => { setPlaying(false); go(index) }} />
        </div>
      )}
    </section>
  )
}
