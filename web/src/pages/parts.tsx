import { Search } from "lucide-react"
import { useMemo } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router"
import type { PartStatus } from "@shared/api.ts"
import { Page } from "@/components/app-layout"
import { FilterChip, Segmented } from "@/components/controls"
import { PartSheet } from "@/components/part-sheet"
import { EmptyState, ErrorState } from "@/components/states"
import { StatusDot } from "@/components/status"
import { SupplyMapPanel } from "@/components/supply-map"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { compact, num } from "@/lib/format"
import { useMap, useParts } from "@/lib/queries"
import { shortEdition } from "@/lib/decisions"
import { cn } from "@/lib/utils"

// Every part with what is needed, what is safe, what may still come and the gap, in that order.
// The order pipeline (ordered, confirmed, shipped, ...) is one quiet column here and in full in the part's sheet.
// The map is the same data drawn on the world, one switch away.

const STATUS_ORDER: Record<PartStatus, number> = { lost: 0, uncertain: 1, ok: 2 }
const STATUS_LABEL: Record<PartStatus, string> = { lost: "Lost", uncertain: "Early warning", ok: "Covered" }
const ALL = "all"

function Quantity({ value, className }: { value: number; className?: string }) {
  return (
    <TableCell className={cn("text-right tabular-nums", value === 0 && "text-muted-foreground/60", className)}>
      {num(value)}
    </TableCell>
  )
}

/** Numbers with an explanation on hover, because "ordered" and "arrived" count every open order, not this launch. */
function Head({ children, hint, className }: { children: string; hint: string; className?: string }) {
  return (
    <TableHead className={cn("text-right", className)}>
      <span
        title={hint}
        className="cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-4"
      >
        {children}
      </span>
    </TableHead>
  )
}

export function PartsPage() {
  const { part_id: partId } = useParams()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { data: parts, isPending } = useParts()
  const map = useMap()

  const edition = searchParams.get("edition") ?? ALL
  const search = searchParams.get("q") ?? ""
  const statusParam = searchParams.get("status")
  const status: PartStatus | typeof ALL =
    statusParam === "lost" || statusParam === "uncertain" || statusParam === "ok" ? statusParam : ALL
  const view = searchParams.get("view") === "map" ? "map" : "table"
  const suffix = searchParams.size > 0 ? `?${searchParams.toString()}` : ""

  function setParam(key: string, value: string) {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous)
        if (value && value !== ALL) next.set(key, value)
        else next.delete(key)
        return next
      },
      { replace: true },
    )
  }

  const editions = useMemo(() => {
    const byId = new Map<string, string>()
    for (const part of parts ?? []) for (const product of part.products) byId.set(product.product_id, product.name)
    return [...byId].map(([id, name]) => ({ id, name }))
  }, [parts])

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return (parts ?? [])
      .filter((part) => edition === ALL || part.products.some((product) => product.product_id === edition))
      .filter(
        (part) =>
          !needle ||
          [part.part_id, part.description, part.category, ...part.suppliers.map((supplier) => supplier.name)]
            .join(" ")
            .toLowerCase()
            .includes(needle),
      )
  }, [parts, edition, search])

  const rows = filtered
    .filter((part) => status === ALL || part.status === status)
    .sort(
      (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.gap - a.gap || a.part_id.localeCompare(b.part_id),
    )
  const count = (s: PartStatus | typeof ALL) => filtered.filter((part) => s === ALL || part.status === s).length
  const openIssues = rows.reduce((sum, part) => sum + part.open_issues, 0)

  return (
    <Page>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Table or map"
          value={view}
          onChange={(value) => setParam("view", value === "map" ? "map" : ALL)}
          options={[
            { value: "table", label: "Table" },
            { value: "map", label: "Map" },
          ]}
        />
        <div className="mx-1 h-5 w-px bg-border" aria-hidden />
        {([ALL, "lost", "uncertain", "ok"] as const).map((s) => (
          <FilterChip key={s} active={status === s} count={count(s)} onClick={() => setParam("status", s)}>
            {s !== ALL && <StatusDot level={s} className={cn(status === s && s === "ok" && "bg-background")} />}
            {s === ALL ? "All parts" : STATUS_LABEL[s]}
          </FilterChip>
        ))}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              aria-label="Search parts"
              placeholder="Search part or supplier"
              value={search}
              onChange={(event) => setParam("q", event.target.value)}
              className="h-8 pl-8"
            />
          </div>
          <Select value={edition} onValueChange={(value) => setParam("edition", value)}>
            <SelectTrigger aria-label="Edition" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All editions</SelectItem>
              {editions.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {shortEdition(item.name)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {view === "map" ? (
        <SupplyMapPanel map={map.data} parts={parts} variant="buyer" loading={map.isPending || isPending} />
      ) : isPending ? (
        <Card className="space-y-3 p-4 shadow-none">
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <Skeleton key={row} className="h-8 w-full" />
          ))}
        </Card>
      ) : !parts ? (
        <ErrorState what="the parts" />
      ) : parts.length === 0 ? (
        <EmptyState>No parts yet. Run a sync to load them.</EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState>No part matches your filter.</EmptyState>
      ) : (
        <Card className="py-0 shadow-none">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Part</TableHead>
                <Head hint="Units still to pack for the launch, for every edition that uses the part">Need</Head>
                <Head hint="In the building and usable, or confirmed to arrive before the last packing hour">Safe</Head>
                <Head hint="May still arrive or be released in time, but nothing confirms it yet">May still come</Head>
                <Head hint="Need minus safe minus may still come. What is missing even if everything open works out">
                  Gap
                </Head>
                <Head hint="Contradictions and open questions the agents found for this part">Open issues</Head>
                <Head
                  hint="All open orders for this part, also deliveries promised after the launch. The part's sheet shows every step"
                  className="hidden pr-4 xl:table-cell"
                >
                  Open orders
                </Head>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((part) => (
                <TableRow
                  key={part.part_id}
                  tabIndex={0}
                  aria-selected={part.part_id === partId}
                  data-state={part.part_id === partId ? "selected" : undefined}
                  className="cursor-pointer outline-none focus-visible:bg-muted/50"
                  onClick={() => navigate(`/parts/${encodeURIComponent(part.part_id)}${suffix}`)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") navigate(`/parts/${encodeURIComponent(part.part_id)}${suffix}`)
                  }}
                >
                  <TableCell className="pl-4">
                    <div className="flex items-center gap-2.5">
                      <StatusDot level={part.status} />
                      <div className="min-w-0">
                        <div className="max-w-80 truncate font-medium" title={part.description}>
                          {part.description}
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="font-mono text-[11px]">{part.part_id}</span>
                          <span aria-hidden>·</span>
                          <span className="truncate">
                            {part.products.map((product) => shortEdition(product.name)).join(", ")}
                          </span>
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <Quantity value={part.need} />
                  <Quantity value={part.available_safe} />
                  <Quantity value={part.available_uncertain} />
                  <Quantity
                    value={part.gap}
                    className={cn(
                      part.gap > 0 && "font-semibold",
                      part.gap > 0 && part.status === "lost" && "text-lost",
                    )}
                  />
                  <Quantity value={part.open_issues} />
                  <TableCell className="hidden pr-4 text-right text-xs text-muted-foreground tabular-nums xl:table-cell">
                    {part.ordered > 0 ? (
                      <span
                        title={`Ordered ${num(part.ordered)}, shipped ${num(part.shipped)}, in transit ${num(part.in_transit)}`}
                      >
                        {compact(part.ordered)} ordered · {compact(part.in_transit)} in transit
                      </span>
                    ) : (
                      <span className="text-muted-foreground/60">none open</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="border-t px-4 py-2 text-xs text-muted-foreground tabular-nums">
            {rows.length} of {parts.length} parts · {num(openIssues)} open issues
          </div>
        </Card>
      )}

      <PartSheet partId={partId} onClose={() => navigate(`/parts${suffix}`)} />
    </Page>
  )
}
