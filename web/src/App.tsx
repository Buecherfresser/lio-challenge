import { Link, Route, Routes } from "react-router"
import { AppLayout } from "@/components/app-layout"
import { EmptyState } from "@/components/states"
import { ApprovalsPage } from "@/pages/approvals"
import { InboxPage } from "@/pages/inbox"
import { LogPage } from "@/pages/log"
import { OverviewPage } from "@/pages/overview"
import { PartsPage } from "@/pages/parts"

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<OverviewPage />} />
        <Route path="parts" element={<PartsPage />} />
        <Route path="parts/:part_id" element={<PartsPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="log" element={<LogPage />} />
        <Route
          path="*"
          element={
            <div className="p-6">
              <EmptyState>
                <span>
                  This page does not exist.{" "}
                  <Link to="/" className="font-medium text-foreground underline underline-offset-4">
                    Go to the overview
                  </Link>
                </span>
              </EmptyState>
            </div>
          }
        />
      </Route>
    </Routes>
  )
}
