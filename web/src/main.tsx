import "./index.css"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router"
import { TooltipProvider } from "@/components/ui/tooltip"
import { PRODUCT_NAME, POLL_MS } from "@/lib/config"
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
