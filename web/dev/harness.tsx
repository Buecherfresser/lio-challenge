/* oxlint-disable react/only-export-components -- a dev entry point, not a module */
// Dev-only page that renders SupplyMapPanel against /api (answered from dev/fixtures by dev/screenshot.mjs).
// Not part of the app: open http://localhost:5173/dev/harness.html?variant=buyer under `vite`.
import "@/index.css"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { SupplyMapPanel } from "@/components/supply-map"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useMap, useParts } from "@/lib/queries"

const variant = new URLSearchParams(location.search).get("variant") === "buyer" ? "buyer" : "management"

function Harness() {
  const map = useMap()
  const parts = useParts()
  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-4 p-4 md:p-6">
      <h1 className="text-sm font-medium text-muted-foreground">Critical supply ({variant})</h1>
      <SupplyMapPanel map={map.data} parts={parts.data} variant={variant} loading={map.isPending || parts.isPending} />
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <TooltipProvider>
          <Harness />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  </StrictMode>,
)
