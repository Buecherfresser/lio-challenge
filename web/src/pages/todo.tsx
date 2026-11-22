import { useMemo, useState } from "react"
import { useSearchParams } from "react-router"
import { Page } from "@/components/app-layout"
import { Segmented } from "@/components/controls"
import { ItemSheet, QueueRow } from "@/components/queue"
import { EmptyState, ErrorState } from "@/components/states"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { num } from "@/lib/format"
import { KIND, PRIORITIES, PRIORITY, byPriority, useQueue, type Kind } from "@/lib/queue"

// What waits for a signature: decisions, and mails to release, the most urgent first. Tasks have their own page.
// One line per item. A click opens it in a side panel with its buttons at the top.

const EVERYONE = "everyone"
const PERSON_KEY = "1e16.todo.person"

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // A private window may refuse storage. The filter then lasts for this visit only.
  }
}

export function TodoPage() {
  const { queue, threadById, productNames, now, loading, failed } = useQueue()
  const [searchParams, setSearchParams] = useSearchParams()

  const kindParam = searchParams.get("kind")
  const kind: Kind | "all" =
    kindParam === "decision" || kindParam === "mail" ? kindParam : "all"
  const showDone = searchParams.get("show") === "done"
  const openKey = searchParams.get("item")
  const [person, setPersonState] = useState(() => searchParams.get("person") ?? readStored(PERSON_KEY) ?? EVERYONE)

  function setParam(key: string, value: string | null) {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous)
        if (value) next.set(key, value)
        else next.delete(key)
        return next
      },
      { replace: true },
    )
  }
  function setPerson(value: string) {
    setPersonState(value)
    writeStored(PERSON_KEY, value)
    setParam("person", value === EVERYONE ? null : value)
  }

  const people = useMemo(
    () => [...new Set(queue.filter((item) => !item.done && item.owner).map((item) => item.owner!))].sort(),
    [queue],
  )

  // Items without an owner (mails) belong to everyone, so they show under every person.
  const mine = queue.filter((item) => person === EVERYONE || item.owner === null || item.owner === person)
  const forPerson = mine.filter((item) => item.done === showDone)
  const visible = forPerson
    .filter((item) => kind === "all" || item.kind === kind)
    .sort(showDone ? (a, b) => b.at.localeCompare(a.at) : byPriority)
  const countOf = (k: Kind | "all") => forPerson.filter((item) => k === "all" || item.kind === k).length
  const doneCount = mine.filter((item) => item.done).length
  const openItem = queue.find((item) => item.key === openKey)

  return (
    <Page>
      <div className="mx-auto max-w-5xl space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            label="Kind"
            value={kind}
            onChange={(value) => setParam("kind", value === "all" ? null : value)}
            options={(["all", "decision", "mail"] as const).map((k) => ({
              value: k,
              label: k === "all" ? `All ${num(countOf("all"))}` : `${KIND[k].plural} ${num(countOf(k))}`,
            }))}
          />
          <div className="ml-auto flex items-center gap-2">
            <Select value={people.includes(person) ? person : EVERYONE} onValueChange={setPerson}>
              <SelectTrigger aria-label="Whose items" size="sm" className="w-40 border-transparent shadow-none">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value={EVERYONE}>Everyone</SelectItem>
                {people.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((row) => (
              <Skeleton key={row} className="h-10 w-full" />
            ))}
          </div>
        ) : failed ? (
          <ErrorState what="the decisions" />
        ) : visible.length === 0 ? (
          <EmptyState>
            {showDone
              ? "Nothing is done yet."
              : person === EVERYONE
                ? "Nothing waits for anyone right now."
                : `Nothing waits for ${person} right now.`}
          </EmptyState>
        ) : (
          <div className="overflow-hidden rounded-xl border">
            {/* Open items in groups by tier, so the eye finds the urgent ones first. Done items in one list. */}
            {(showDone ? [null] : PRIORITIES).map((tier) => {
              const items = tier ? visible.filter((item) => item.priority === tier) : visible
              if (items.length === 0) return null
              return (
                <section
                  key={tier ?? "done"}
                  aria-label={tier ? PRIORITY[tier].label : "Done"}
                  className="border-b last:border-b-0"
                >
                  {tier && (
                    <h3 className="flex items-baseline gap-2 border-b bg-muted/30 px-4 py-1.5 text-xs font-medium">
                      {PRIORITY[tier].label}
                      <span className="font-normal text-muted-foreground tabular-nums">{num(items.length)}</span>
                    </h3>
                  )}
                  <ul className="divide-y">
                    {items.map((item) => (
                      <QueueRow key={item.key} item={item} now={now} onOpen={() => setParam("item", item.key)} />
                    ))}
                  </ul>
                </section>
              )
            })}
          </div>
        )}

        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={() => setParam("show", showDone ? null : "done")}
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {showDone ? "Back to open items" : `Show done (${num(doneCount)})`}
          </button>
        </div>
      </div>

      <ItemSheet
        item={openItem}
        now={now}
        onClose={() => setParam("item", null)}
        productNames={productNames}
        threadTitle={openItem?.message ? threadById.get(openItem.message.thread_id)?.title : undefined}
      />
    </Page>
  )
}
