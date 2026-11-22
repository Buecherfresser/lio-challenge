import "./index.css"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router"
import { TooltipProvider } from "@/components/ui/tooltip"
import { CUSTOMER, PRODUCT_NAME, POLL_MS } from "@/lib/config"
import type { Status } from "@shared/api.ts"
import App from "./App.tsx"

document.title = PRODUCT_NAME

// The agents change the data while the page is open, so every query asks again every few seconds.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchInterval: POLL_MS,
      staleTime: POLL_MS / 2,
      retry: 1,
    },
  },
})

// Customer name and time zone come from the backend. If it does not answer, the page still starts with the defaults.
try {
  const res = await fetch("/api/status")
  if (res.ok) Object.assign(CUSTOMER, ((await res.json()) as Status).customer ?? {})
} catch {
  // keep the defaults
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
