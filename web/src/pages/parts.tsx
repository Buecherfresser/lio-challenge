import { Search } from "lucide-react"
import { useMemo } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router"
import type { PartRow, PartStatus } from "@shared/api.ts"
import { Page } from "@/components/app-layout"
import { PartSheet } from "@/components/part-sheet"
import { Stat, StatRow } from "@/components/stat"
import { EmptyState, ErrorState } from "@/components/states"
import { StatusDot } from "@/components/status"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { num } from "@/lib/format"
import { useParts } from "@/lib/queries"
import { cn } from "@/lib/utils"

const STATUS_ORDER: Record<PartStatus, number> = { lost: 0, uncertain: 1, ok: 2 }
const ALL = "all"

const NUMBER_COLUMNS: { key: keyof PartRow & ("need" | "ordered" | "confirmed" | "shipped" | "in_transit" | "arrived" | "usable"); label: string }[] = [
  { key: "need", label: "Need" },
  { key: "ordered", label: "Ordered" },
  { key: "confirmed", label: "Confirmed" },
  { key: "shipped", label: "Shipped" },
  { key: "in_transit", label: "In transit" },
  { key: "arrived", label: "Arrived" },
  { key: "usable", label: "Usable" },
]

function Quantity({ value, className }: { value: number; className?: string }) {
  return (
    <TableCell className={cn("text-right tabular-nums", value === 0 && "text-muted-foreground/60", className)}>
      {num(value)}
    </TableCell>
  )
}

export function PartsPage() {
  const { part_id: partId } = useParams()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { data: parts, isPending } = useParts()

  const edition = searchParams.get("edition") ?? ALL
  const search = searchParams.get("q") ?? ""
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

  const rows = useMemo(() => {
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
      .sort(
        (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.gap - a.gap || a.part_id.localeCompare(b.part_id),
      )
  }, [parts, edition, search])

  const count = (status: PartStatus) => (parts ?? []).filter((part) => part.status === status).length
  const openIssues = (parts ?? []).reduce((sum, part) => sum + part.open_issues, 0)

  return (
    <Page>
      <StatRow>
        <Stat label="Lost" dot={<StatusDot level="lost" />} value={num(count("lost"))} hint="parts with a gap" loading={isPending} />
        <Stat
          label="Uncertain"
          dot={<StatusDot level="uncertain" />}
          value={num(count("uncertain"))}
          hint="parts that depend on something open"
          loading={isPending}
        />
        <Stat label="OK" dot={<StatusDot level="ok" />} value={num(count("ok"))} hint="parts covered" loading={isPending} />
        <Stat label="Open issues" value={num(openIssues)} hint="across all parts" loading={isPending} />
      </StatRow>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label="Search parts"
            placeholder="Search part, description or supplier"
            value={search}
            onChange={(event) => setParam("q", event.target.value)}
            className="pl-8"
          />
        </div>
        <Select value={edition} onValueChange={(value) => setParam("edition", value)}>
          <SelectTrigger aria-label="Edition" className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All editions</SelectItem>
            {editions.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {parts && (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {rows.length} of {parts.length} parts
          </span>
        )}
      </div>

      {isPending ? (
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
                <TableHead>Used in</TableHead>
                {NUMBER_COLUMNS.map((column) => (
                  <TableHead key={column.key} className="text-right">
                    {column.label}
                  </TableHead>
                ))}
                <TableHead className="text-right">Gap</TableHead>
                <TableHead className="pr-4 text-right">Open issues</TableHead>
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
                        <div className="max-w-64 truncate font-medium">{part.description}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">{part.part_id}</div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {part.products.map((product) => (
                        <span
                          key={product.product_id}
                          title={product.name}
                          className="rounded-full border px-1.5 text-[11px] leading-4.5 whitespace-nowrap text-muted-foreground"
                        >
                          {product.name.replace(/\s+Edition$/i, "")}
                        </span>
                      ))}
                    </div>
                  </TableCell>
                  {NUMBER_COLUMNS.map((column) => (
                    <Quantity key={column.key} value={part[column.key]} />
                  ))}
                  <Quantity
                    value={part.gap}
                    className={cn(part.gap > 0 && "font-semibold", part.gap > 0 && part.status === "lost" && "text-lost")}
                  />
                  <Quantity value={part.open_issues} className="pr-4" />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <PartSheet partId={partId} onClose={() => navigate(`/parts${suffix}`)} />
    </Page>
  )
}
